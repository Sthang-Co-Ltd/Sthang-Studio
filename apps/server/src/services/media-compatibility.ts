import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';

/**
 * Conservative signal evidence for retaining reviewed timing, not semantic or
 * bit-for-bit identity proof. Lossy encoding needs narrow tolerances: each 20 ms
 * window requires <=6% RMS error (with a -60 dBFS noise floor) and correlation
 * >=0.995 when audible. Arbitrarily small changes below these tolerances cannot
 * be distinguished from codec noise. Uncertain or unsupported inputs fail shut.
 */
export type MediaCompatibilityCode = 'MEDIA_AUDIO_MISMATCH' | 'MEDIA_AUDIO_UNVERIFIABLE' | 'MEDIA_TIMELINE_MISMATCH';
export class MediaCompatibilityError extends Error {
  readonly httpStatus = 422;
  constructor(message: string, readonly code: MediaCompatibilityCode = 'MEDIA_AUDIO_UNVERIFIABLE') {
    super(message);
    this.name = 'MediaCompatibilityError';
  }
}
export interface MediaCompatibilityOptions {
  captions?: readonly { startMs: number; endMs: number }[];
  expectedDurationMs?: number;
  signal?: AbortSignal;
}
export interface MediaCompatibilityEvidence {
  method: 'full-timeline-pcm-v1';
  durationMs: number;
  previousDurationMs: number;
  audioDurationMs: number;
  comparedSamples: number;
  sampleRate: number;
  channels: number;
  checkedWindows: number;
  informativeDurationMs: number;
}

// Every decoded sample is checked in aligned 20 ms windows. No searching for a
// matching snippet, time shifting, gain normalization, or matching only duration.
const SAMPLE_RATE = 48_000;
const WINDOW_SAMPLES = 960;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_SOURCE_BYTES = 4 * 1024 ** 3;
const MAX_PROCESS_MS = 5 * 60 * 1000;
const MAX_PROBE_BYTES = 256 * 1024;
const MAX_CONCURRENT = 2;
const DURATION_TOLERANCE_MS = 40;
const ORIGIN_TOLERANCE_MS = 2;
const PADDING_TOLERANCE_MS = 32;
const QUIET_RMS = 0.001; // -60 dBFS; quiet differences cannot be normalized away.
const INFORMATIVE_RMS = 0.004;
const INPUT_FORMATS = 'mov,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf,wav,mp3,flac,aac';
let running = 0;

function unverifiable(message = 'The audio could not be verified safely. Keep the current media or use a full caption reset.') {
  return new MediaCompatibilityError(message);
}
function mismatch() {
  return new MediaCompatibilityError('The audio is different or no longer aligned with the reviewed captions. Use a full caption reset for this file.', 'MEDIA_AUDIO_MISMATCH');
}
function timeline(message: string) {
  return new MediaCompatibilityError(message, 'MEDIA_TIMELINE_MISMATCH');
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw unverifiable('Media verification was cancelled. The current media has not been replaced.');
}

/** Bounded process output and wall time, no shell or network/playlist demuxers. */
function localProcess(command: string, args: string[], maxBytes: number, timeoutMs: number, signal?: AbortSignal, stderrLine?: (line: string) => void) {
  checkAbort(signal);
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure: MediaCompatibilityError | undefined;
  let bytes = 0;
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason = unverifiable()) => {
    failure ??= reason;
    if (closed) return;
    child.kill('SIGTERM');
    child.stdout.destroy();
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
    killTimer.unref();
  };
  const abort = () => stop(unverifiable('Media verification was cancelled. The current media has not been replaced.'));
  const timer = setTimeout(() => stop(unverifiable('Media verification exceeded its safe time limit. The current media has not been replaced.')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  // Only bounded transient frame-timestamp lines are inspected. Do not retain
  // diagnostics, source paths, checksums, or source-derived audio.
  let pendingLine = '';
  child.stderr.on('data', (bytes: Buffer) => {
    if (!stderrLine || failure) return;
    pendingLine += bytes.toString('utf8');
    const lines = pendingLine.split('\n');
    pendingLine = lines.pop() || '';
    if (pendingLine.length > 8192) { stop(unverifiable()); return; }
    try { for (const line of lines) stderrLine(line); }
    catch (error) { stop(error instanceof MediaCompatibilityError ? error : unverifiable()); }
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', () => { failure ??= unverifiable('Local media tools could not start. Check FFmpeg in Settings.'); });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(unverifiable());
      else resolve();
    });
  });
  // A decoder can exit while its peer is being read. Keep the original rejection
  // available to await without creating an unhandled rejection in the meantime.
  void completion.catch(() => {});
  async function* output() {
    try {
      for await (const chunk of child.stdout) {
        checkAbort(signal);
        bytes += chunk.length;
        if (bytes > maxBytes) { stop(unverifiable('Media verification exceeded its safe size limit.')); throw failure; }
        if (failure) throw failure;
        yield chunk as Buffer;
      }
      await completion;
    } catch (error) {
      stop(error instanceof MediaCompatibilityError ? error : unverifiable());
      throw failure;
    }
  }
  return { output: output(), completion, stop };
}

interface Probe {
  durationMs: number;
  originMs: number;
  audioStartMs: number;
  audioDurationMs?: number;
  videoStartMs?: number;
  videoDurationMs?: number;
  channels: number;
}
function numeric(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
async function probe(source: string, signal?: AbortSignal): Promise<Probe> {
  const stat = await fs.lstat(source).catch(() => null);
  if (!path.isAbsolute(source) || !stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_SOURCE_BYTES) {
    throw unverifiable('The local source media is unavailable or exceeds the verification limit.');
  }
  const process = localProcess(config.ffprobePath, [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
    '-show_entries', 'format=duration,start_time:stream=codec_type,start_time,duration,channels', '-of', 'json', source,
  ], MAX_PROBE_BYTES, 20_000, signal);
  const buffers: Buffer[] = [];
  try {
    for await (const bytes of process.output) buffers.push(bytes);
    const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    const streams: Array<Record<string, unknown>> = Array.isArray(value.streams) ? value.streams : [];
    const audio = streams.filter((stream) => stream.codec_type === 'audio');
    const video = streams.filter((stream) => stream.codec_type === 'video');
    // Choosing among multiple soundtracks or comparing only a downmix is not
    // enough evidence. Preserve the channels independently for mono/stereo.
    if (audio.length !== 1 || video.length > 1) throw unverifiable('Keeping reviewed captions requires one unambiguous audio track.');
    const duration = numeric(value.format?.duration);
    const channels = numeric(audio[0].channels);
    if (duration === undefined || duration < 0.1 || duration * 1000 > MAX_DURATION_MS || (channels !== 1 && channels !== 2)) {
      throw unverifiable('Keeping reviewed captions supports mono or stereo media up to two hours with a known duration.');
    }
    const origin = numeric(value.format?.start_time) ?? 0;
    const audioStart = numeric(audio[0].start_time) ?? origin;
    const videoStart = video[0] ? numeric(video[0].start_time) ?? origin : undefined;
    const audioDuration = numeric(audio[0].duration);
    const videoDuration = video[0] ? numeric(video[0].duration) : undefined;
    return {
      durationMs: duration * 1000, originMs: origin * 1000,
      audioStartMs: (audioStart - origin) * 1000,
      audioDurationMs: audioDuration === undefined ? undefined : audioDuration * 1000,
      videoStartMs: videoStart === undefined ? undefined : (videoStart - origin) * 1000,
      videoDurationMs: videoDuration === undefined ? undefined : videoDuration * 1000,
      channels,
    };
  } catch (error) {
    if (error instanceof MediaCompatibilityError) throw error;
    throw unverifiable('The media timeline information could not be verified.');
  } finally {
    process.stop();
    await process.completion.catch(() => {});
  }
}

function validateTimeline(previous: Probe, replacement: Probe, options: MediaCompatibilityOptions) {
  if (previous.channels !== replacement.channels) throw unverifiable('The audio channel layout changed and cannot be verified safely.');
  if (Math.abs(previous.durationMs - replacement.durationMs) > DURATION_TOLERANCE_MS) {
    throw timeline('The replacement has a different timeline length. Use a full caption reset for this file.');
  }
  if (Math.abs(previous.originMs - replacement.originMs) > ORIGIN_TOLERANCE_MS
    || Math.abs(previous.audioStartMs - replacement.audioStartMs) > ORIGIN_TOLERANCE_MS
    || (previous.videoStartMs === undefined) !== (replacement.videoStartMs === undefined)
    || (previous.videoStartMs !== undefined && replacement.videoStartMs !== undefined
      && Math.abs(previous.videoStartMs - replacement.videoStartMs) > ORIGIN_TOLERANCE_MS)) {
    throw timeline('The replacement has a different timeline origin or audio offset. Use a full caption reset for this file.');
  }
  if (previous.videoDurationMs !== undefined && replacement.videoDurationMs !== undefined
    && Math.abs(previous.videoDurationMs - replacement.videoDurationMs) > DURATION_TOLERANCE_MS) {
    throw timeline('The replacement video timeline length has changed. Use a full caption reset for this file.');
  }
  if (options.expectedDurationMs !== undefined
    && (!Number.isFinite(options.expectedDurationMs) || options.expectedDurationMs <= 0
      || Math.abs(previous.durationMs - options.expectedDurationMs) > DURATION_TOLERANCE_MS)) {
    throw timeline('The saved project duration does not match its source. The reviewed timeline cannot be verified safely.');
  }
  const end = Math.min(previous.durationMs, replacement.durationMs);
  for (const caption of options.captions ?? []) {
    if (!Number.isFinite(caption.startMs) || !Number.isFinite(caption.endMs)
      || caption.startMs < 0 || caption.endMs <= caption.startMs || caption.endMs > end + 1) {
      throw timeline('A reviewed caption falls outside the verified media timeline. The current media has not been replaced.');
    }
  }
}

async function* windows(chunks: AsyncIterable<Buffer>, bytesPerWindow: number) {
  let pending = Buffer.alloc(0);
  for await (const chunk of chunks) {
    let bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (bytes.length >= bytesPerWindow) {
      yield bytes.subarray(0, bytesPerWindow);
      bytes = bytes.subarray(bytesPerWindow);
    }
    // Copy at most one tiny window rather than retaining a large backing buffer.
    pending = Buffer.from(bytes);
  }
  if (pending.length) yield pending;
}

function compareWindow(left: Buffer, right: Buffer, channels: number) {
  if (left.length !== right.length || left.length % (2 * channels)) throw unverifiable();
  const samples = left.length / (2 * channels);
  let informative = false;
  for (let channel = 0; channel < channels; channel++) {
    let energyA = 0; let energyB = 0; let product = 0; let error = 0;
    let sumA = 0; let sumB = 0;
    for (let sample = 0; sample < samples; sample++) {
      const offset = (sample * channels + channel) * 2;
      const a = left.readInt16LE(offset) / 32768;
      const b = right.readInt16LE(offset) / 32768;
      energyA += a * a; energyB += b * b; product += a * b;
      error += (a - b) ** 2; sumA += a; sumB += b;
    }
    const rmsA = Math.sqrt(energyA / samples);
    const rmsB = Math.sqrt(energyB / samples);
    const maxRms = Math.max(rmsA, rmsB);
    const errorRms = Math.sqrt(error / samples);
    // Absolute and relative error both matter. This deliberately rejects gain
    // changes and localized edits, even when most of the clip matches perfectly.
    if (errorRms > Math.max(QUIET_RMS, maxRms * 0.06)) throw mismatch();
    if (maxRms >= INFORMATIVE_RMS) {
      const varianceA = energyA - sumA * sumA / samples;
      const varianceB = energyB - sumB * sumB / samples;
      const correlation = (product - sumA * sumB / samples) / Math.sqrt(varianceA * varianceB);
      if (!Number.isFinite(correlation) || correlation < 0.995) throw mismatch();
      // DC and almost-flat samples do not establish usable matching audio.
      if (Math.sqrt(Math.min(varianceA, varianceB) / samples) >= INFORMATIVE_RMS) informative = true;
    }
  }
  return { informative, samples };
}
function quietPadding(bytes: Buffer) {
  if (bytes.length % 2) return false;
  let energy = 0;
  for (let offset = 0; offset < bytes.length; offset += 2) energy += (bytes.readInt16LE(offset) / 32768) ** 2;
  return !bytes.length || Math.sqrt(energy / (bytes.length / 2)) <= QUIET_RMS;
}

/** Check original decoded frame PTS before resampling can conceal a gap. */
function frameClock(info: Probe) {
  let frames = 0;
  let expectedMs = info.audioStartMs;
  return {
    inspect(line: string) {
      if (!line.includes('Parsed_ashowinfo_')) return;
      const match = /pts:(-?\d+) pts_time:.*?rate:(\d+) nb_samples:(\d+)/.exec(line);
      if (!match) throw unverifiable('The source audio timestamps could not be verified.');
      const milliseconds = Number(match[1]) * 1000 / SAMPLE_RATE;
      const rate = Number(match[2]);
      const samples = Number(match[3]);
      if (!Number.isFinite(milliseconds) || rate < 8000 || rate > 192000 || samples <= 0
        || Math.abs(milliseconds - expectedMs) > ORIGIN_TOLERANCE_MS) {
        throw timeline('The audio contains a timestamp gap or discontinuity. Its reviewed timeline cannot be verified safely.');
      }
      expectedMs = milliseconds + samples * 1000 / rate;
      frames++;
    },
    finish() { if (!frames) throw unverifiable('The source audio timestamps could not be verified.'); },
  };
}

/**
 * Verify locally from the immutable old/new source files before any project
 * mutation. No PCM files or fingerprints are persisted; pipes are bounded by
 * backpressure. All windows must match at their original positions. A tiny
 * unequal codec-padding tail is allowed only if it is quiet on the longer side.
 */
export async function verifyReplacementAudio(currentPath: string, replacementPath: string, options: MediaCompatibilityOptions = {}): Promise<MediaCompatibilityEvidence> {
  checkAbort(options.signal);
  if (running >= MAX_CONCURRENT) throw unverifiable('Media verification is busy. Try again after the current check finishes.');
  running++;
  try {
    const previous = await probe(currentPath, options.signal);
    const replacement = await probe(replacementPath, options.signal);
    validateTimeline(previous, replacement, options);
    const channels = previous.channels;
    const maxSamples = Math.ceil((Math.max(previous.durationMs, replacement.durationMs) + 1000) * SAMPLE_RATE / 1000);
    const args = (source: string) => [
      '-hide_banner', '-loglevel', 'info', '-nostdin', '-threads', '1',
      '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', source,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-threads', '1',
      '-af', `asettb=1/${SAMPLE_RATE},ashowinfo,aresample=${SAMPLE_RATE}:async=1:first_pts=0`,
      '-ar', String(SAMPLE_RATE), '-ac', String(channels), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ];
    const oldClock = frameClock(previous);
    const newClock = frameClock(replacement);
    const oldProcess = localProcess(config.ffmpegPath, args(currentPath), maxSamples * channels * 2, MAX_PROCESS_MS, options.signal, oldClock.inspect);
    const newProcess = localProcess(config.ffmpegPath, args(replacementPath), maxSamples * channels * 2, MAX_PROCESS_MS, options.signal, newClock.inspect);
    const oldWindows = windows(oldProcess.output, WINDOW_SAMPLES * channels * 2);
    const newWindows = windows(newProcess.output, WINDOW_SAMPLES * channels * 2);
    let oldSamples = 0; let newSamples = 0; let comparedSamples = 0;
    let informativeSamples = 0; let checkedWindows = 0; let paddingSamples = 0;
    try {
      for (;;) {
        const [a, b] = await Promise.all([oldWindows.next(), newWindows.next()]);
        if (a.done && b.done) break;
        const left = a.done ? Buffer.alloc(0) : a.value;
        const right = b.done ? Buffer.alloc(0) : b.value;
        oldSamples += left.length / (2 * channels);
        newSamples += right.length / (2 * channels);
        const commonLength = Math.min(left.length, right.length);
        if (commonLength) {
          const checked = compareWindow(left.subarray(0, commonLength), right.subarray(0, commonLength), channels);
          comparedSamples += checked.samples;
          if (checked.informative) informativeSamples += checked.samples;
          checkedWindows++;
        }
        const extra = left.length > right.length ? left.subarray(commonLength) : right.subarray(commonLength);
        if (extra.length) {
          paddingSamples += extra.length / (2 * channels);
          if (!quietPadding(extra) || paddingSamples > SAMPLE_RATE * PADDING_TOLERANCE_MS / 1000) throw mismatch();
        }
      }
      await Promise.all([oldProcess.completion, newProcess.completion]);
      oldClock.finish(); newClock.finish();
      for (const [info, samples] of [[previous, oldSamples], [replacement, newSamples]] as const) {
        const decodedDuration = samples * 1000 / SAMPLE_RATE;
        // A container claiming a long video over a shorter audio track is not a
        // complete-timeline match. Do not pad or truncate to make it appear one.
        if (Math.abs(decodedDuration - info.durationMs) > DURATION_TOLERANCE_MS
          || (info.audioDurationMs !== undefined
            && Math.abs(decodedDuration - (info.audioDurationMs + info.audioStartMs)) > DURATION_TOLERANCE_MS)) {
          throw unverifiable('The full audio timeline could not be verified. Keep the current media or use a full caption reset.');
        }
      }
      const informativeDurationMs = informativeSamples * 1000 / SAMPLE_RATE;
      if (informativeDurationMs < Math.min(500, previous.durationMs * 0.1)) {
        throw unverifiable('There is not enough audible evidence to keep reviewed captions safely. Silence alone cannot verify this replacement.');
      }
      return {
        method: 'full-timeline-pcm-v1', durationMs: Math.round(replacement.durationMs),
        previousDurationMs: Math.round(previous.durationMs), audioDurationMs: Math.round(newSamples * 1000 / SAMPLE_RATE),
        comparedSamples, sampleRate: SAMPLE_RATE, channels, checkedWindows, informativeDurationMs,
      };
    } finally {
      oldProcess.stop(); newProcess.stop();
      await Promise.allSettled([oldProcess.completion, newProcess.completion]);
      await Promise.allSettled([oldWindows.return(), newWindows.return()]);
    }
  } catch (error) {
    if (error instanceof MediaCompatibilityError) throw error;
    throw unverifiable();
  } finally {
    running--;
  }
}
