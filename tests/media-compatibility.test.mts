import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-compatibility-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { verifyReplacementAudio, MediaCompatibilityError } = await import('../apps/server/src/services/media-compatibility.js');
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
const rate = 48_000;
const duration = 4;

// Deterministic speech-like syllables: changing pitch/formants, breath noise,
// plosive-like envelopes and pauses. Never real/private recordings or models.
function speechLike(seconds = duration, seed = 72) {
  const samples = new Float64Array(rate * seconds);
  let noise = 0; let phase = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const syllable = Math.floor(t / 0.23);
    const within = (t % 0.23) / 0.23;
    const envelope = (syllable % 7 === 3 ? 0 : Math.sin(Math.PI * within) ** 2) * Math.min(1, t * 40, (seconds - t) * 40);
    seed = (1664525 * seed + 1013904223) >>> 0;
    noise = noise * 0.7 + (seed / 0xffffffff - 0.5) * 0.3;
    phase += 2 * Math.PI * (112 + 13 * (syllable % 5) + 18 * Math.sin(t * 3.1)) / rate;
    samples[i] = envelope * (0.16 * Math.sin(phase) + 0.1 * Math.sin(phase * 3) + 0.06 * Math.sin(phase * 7) + 0.04 * noise);
  }
  return samples;
}
async function wav(name: string, values: Float64Array, channels = 1) {
  const data = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, values[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(root, name);
  await fs.writeFile(file, Buffer.concat([header, data])); return file;
}
function ffmpeg(args: string[]) {
  execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 30_000, stdio: 'pipe' });
}
const signal = speechLike();
const original = await wav('source.wav', signal);
const captions = [{ startMs: 100, endMs: 1500 }, { startMs: 1800, endMs: 3900 }];
async function rejectsAudio(file: string, expectedCode?: string) {
  await assert.rejects(verifyReplacementAudio(original, file, { captions, expectedDurationMs: 4000 }), (error: any) => {
    assert.ok(error instanceof MediaCompatibilityError);
    assert.equal(error.httpStatus, 422);
    if (expectedCode) assert.equal(error.code, expectedCode);
    assert.ok(!error.message.includes(root), 'diagnostics must not leak source paths');
    return true;
  });
}

test('full-length evidence checks every window, preserves bounds and is serializable', async () => {
  const evidence = await verifyReplacementAudio(original, original, { captions, expectedDurationMs: 4000 });
  assert.equal(evidence.method, 'full-timeline-pcm-v1');
  assert.equal(evidence.comparedSamples, 4 * 48_000);
  assert.equal(evidence.checkedWindows, 200);
  assert.equal(evidence.durationMs, 4000);
  assert.ok(evidence.informativeDurationMs > 2500);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
});

test('same aligned audio survives AAC encoding and a second lossy encode', async () => {
  const aac = path.join(root, 'encoded.m4a');
  ffmpeg(['-i', original, '-c:a', 'aac', '-b:a', '128k', aac]);
  const aacAgain = path.join(root, 'encoded-again.m4a');
  ffmpeg(['-i', aac, '-c:a', 'aac', '-b:a', '128k', '-t', '4', aacAgain]);
  const first = await verifyReplacementAudio(original, aac, { captions });
  assert.ok(first.comparedSamples >= 4 * 48_000);
  const second = await verifyReplacementAudio(aac, aacAgain, { captions });
  assert.ok(second.checkedWindows >= 200);
});

test('resolution/frame-rate changes preserve aligned video audio', async () => {
  const old = path.join(root, 'video-old.mp4');
  const next = path.join(root, 'video-new.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=4', '-i', original, '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', '-t', '4', old]);
  ffmpeg(['-i', old, '-vf', 'scale=320:180', '-r', '30', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', '-t', '4', next]);
  assert.equal((await verifyReplacementAudio(old, next, { captions })).durationMs, 4000);
});

test('same-duration shifts, reorders and speed changes fail', async () => {
  const shifted = new Float64Array(signal.length);
  shifted.set(signal.subarray(0, signal.length - 1200), 1200); // 25 ms, no duration change.
  await rejectsAudio(await wav('shifted.wav', shifted), 'MEDIA_AUDIO_MISMATCH');
  const reordered = signal.slice();
  reordered.set(signal.subarray(rate, 2 * rate), 2 * rate);
  reordered.set(signal.subarray(2 * rate, 3 * rate), rate);
  await rejectsAudio(await wav('reordered.wav', reordered), 'MEDIA_AUDIO_MISMATCH');
  const speed = path.join(root, 'speed.wav');
  ffmpeg(['-i', original, '-af', 'atempo=1.01,apad', '-t', '4', '-c:a', 'pcm_s16le', speed]);
  await rejectsAudio(speed, 'MEDIA_AUDIO_MISMATCH');
});

test('a tiny localized cut/repeat or addition cannot hide inside an otherwise matching clip', async () => {
  const dropped = signal.slice();
  const at = Math.round(rate * 1.31);
  const length = Math.round(rate * 0.008);
  dropped.set(signal.subarray(at + length, at + length * 2), at);
  await rejectsAudio(await wav('eight-ms-edit.wav', dropped), 'MEDIA_AUDIO_MISMATCH');
  const repeated = signal.slice();
  repeated.set(signal.subarray(at - length, at), at);
  await rejectsAudio(await wav('eight-ms-repeat.wav', repeated), 'MEDIA_AUDIO_MISMATCH');
  const music = signal.slice();
  for (let i = rate * 2; i < rate * 3; i++) music[i] += 0.025 * Math.sin(2 * Math.PI * 1234 * i / rate);
  await rejectsAudio(await wav('new-background.wav', music), 'MEDIA_AUDIO_MISMATCH');
});

test('a matching beginning cannot substitute for a full-length match', async () => {
  const tail = signal.slice();
  const unrelated = speechLike(1, 91);
  tail.set(unrelated, 3 * rate);
  await rejectsAudio(await wav('different-tail.wav', tail), 'MEDIA_AUDIO_MISMATCH');
  await rejectsAudio(await wav('short.wav', signal.slice(0, 3 * rate)), 'MEDIA_TIMELINE_MISMATCH');
});

test('changed gain, channel cancellation and silent or missing evidence fail closed', async () => {
  await rejectsAudio(await wav('gain.wav', signal.map((value) => value * 0.8)), 'MEDIA_AUDIO_MISMATCH');
  const silent = await wav('silent.wav', new Float64Array(signal.length));
  await assert.rejects(verifyReplacementAudio(silent, silent), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  const dc = await wav('dc.wav', new Float64Array(signal.length).fill(0.1));
  await assert.rejects(verifyReplacementAudio(dc, dc), MediaCompatibilityError);
  const stereo = new Float64Array(signal.length * 2);
  for (let i = 0; i < signal.length; i++) { stereo[i * 2] = signal[i]; stereo[i * 2 + 1] = -signal[i]; }
  const inverted = await wav('opposite-channels.wav', stereo, 2);
  assert.equal((await verifyReplacementAudio(inverted, inverted)).channels, 2);
  const swapped = new Float64Array(stereo.length);
  for (let i = 0; i < signal.length; i++) { swapped[i * 2] = -signal[i]; swapped[i * 2 + 1] = signal[i]; }
  await assert.rejects(verifyReplacementAudio(inverted, await wav('swapped.wav', swapped, 2)), { code: 'MEDIA_AUDIO_MISMATCH' });
  const noAudio = path.join(root, 'no-audio.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=160x90:d=4', '-c:v', 'libx264', '-threads', '1', noAudio]);
  await assert.rejects(verifyReplacementAudio(noAudio, noAudio), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
});

test('timeline origins and caption bounds are checked before preservation', async () => {
  const offset = path.join(root, 'offset.m4a');
  ffmpeg(['-i', original, '-c:a', 'aac', '-b:a', '128k', '-output_ts_offset', '0.1', offset]);
  await rejectsAudio(offset, 'MEDIA_TIMELINE_MISMATCH');
  for (const invalid of [[{ startMs: -1, endMs: 200 }], [{ startMs: 200, endMs: 200 }], [{ startMs: 100, endMs: 4002 }], [{ startMs: 100, endMs: NaN }]]) {
    await assert.rejects(verifyReplacementAudio(original, original, { captions: invalid }), { code: 'MEDIA_TIMELINE_MISMATCH' });
  }
  await assert.rejects(verifyReplacementAudio(original, original, { expectedDurationMs: 3000 }), { code: 'MEDIA_TIMELINE_MISMATCH' });
});

test('missing, corrupt, symlinked and cancelled sources fail without leaving artifacts', async () => {
  await assert.rejects(verifyReplacementAudio(original, path.join(root, 'missing.mp4')), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  const corrupt = path.join(root, 'corrupt.mp4'); await fs.writeFile(corrupt, 'not media');
  await assert.rejects(verifyReplacementAudio(original, corrupt), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  if (process.platform !== 'win32') {
    const link = path.join(root, 'link.wav'); await fs.symlink(original, link);
    await assert.rejects(verifyReplacementAudio(original, link), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  }
  const before = await fs.readdir(root);
  await assert.rejects(verifyReplacementAudio(original, original, { signal: AbortSignal.abort() }), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  assert.deepEqual(await fs.readdir(root), before);
});

test('high-frequency-only additions are checked instead of disappearing in a speech-band downmix', async () => {
  const highBand = signal.slice();
  for (let i = rate; i < 2 * rate; i++) highBand[i] += 0.035 * Math.sin(2 * Math.PI * 12500 * i / rate);
  await rejectsAudio(await wav('high-band-addition.wav', highBand), 'MEDIA_AUDIO_MISMATCH');
});

test('original frame timestamp gaps are rejected before any resampling repair', async () => {
  const normal = path.join(root, 'clock-normal.mkv');
  const gap = path.join(root, 'clock-gap.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=160x90:r=25:d=4', '-i', original, '-c:v', 'libx264', '-threads', '1', '-c:a', 'pcm_s16le', '-t', '4', normal]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=160x90:r=25:d=4', '-i', original, '-af', "asetpts=PTS+if(between(T\\,1\\,2)\\,0.01/TB\\,0)", '-c:v', 'libx264', '-threads', '1', '-c:a', 'pcm_s16le', '-t', '4', gap]);
  await assert.rejects(verifyReplacementAudio(normal, gap), { code: 'MEDIA_TIMELINE_MISMATCH' });
});

test('matching short audio under a longer video is not treated as a full timeline match', async () => {
  const short = path.join(root, 'short-audio.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=160x90:r=25:d=5', '-i', original, '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', short]);
  await assert.rejects(verifyReplacementAudio(short, short), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
});

test('probe output and active decoder cancellation are bounded and release admission', { skip: process.platform === 'win32' }, async () => {
  const oldProbe = config.ffprobePath;
  const oldDecoder = config.ffmpegPath;
  const hugeProbe = path.join(root, 'huge-probe');
  const waitingDecoder = path.join(root, 'waiting-decoder');
  await fs.writeFile(hugeProbe, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(300000));\n`, { mode: 0o700 });
  try {
    config.ffprobePath = hugeProbe;
    await assert.rejects(verifyReplacementAudio(original, original), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  } finally { config.ffprobePath = oldProbe; }
  await fs.writeFile(waitingDecoder, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(root)} + '/decoder-' + process.pid + '.pid', String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const abort = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    config.ffmpegPath = waitingDecoder;
    pending = verifyReplacementAudio(original, original, { signal: abort.signal });
    void pending.catch(() => {});
    const deadline = Date.now() + 5000;
    let markers: string[] = [];
    while (Date.now() < deadline) {
      markers = (await fs.readdir(root)).filter((name) => name.startsWith('decoder-') && name.endsWith('.pid'));
      if (markers.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(markers.length, 2, 'both bounded local decoders started');
    abort.abort();
    await assert.rejects(pending, { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
    for (const marker of markers) {
      const pid = Number(await fs.readFile(path.join(root, marker), 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'cancelled decoder is terminated');
    }
  } finally {
    abort.abort(); await pending?.catch(() => {});
    config.ffmpegPath = oldDecoder;
  }
  assert.equal((await verifyReplacementAudio(original, original)).durationMs, 4000);
});

test('explicit audio-change checking keeps the verified path and reports complete mismatching evidence honestly', async () => {
  const verified = await verifyReplacementAudio(original, original, { captions, allowAudioChanges: true });
  assert.equal(verified.audioMatches, true);
  const changed = signal.map((sample, i) => sample * 1.7 + 0.025 * Math.sin(2 * Math.PI * 1234 * i / rate));
  const replacement = await wav('accepted-gain-and-music.wav', changed);
  const accepted = await verifyReplacementAudio(original, replacement, { captions, expectedDurationMs: 4000, allowAudioChanges: true });
  assert.equal(accepted.audioMatches, false);
  assert.equal(accepted.comparedSamples, signal.length, 'an early mismatch must not stop validation of the remaining source');
  assert.equal(accepted.checkedWindows, 200);
  assert.equal(accepted.audioDurationMs, 4000);
  assert.deepEqual(JSON.parse(JSON.stringify(accepted)), accepted);
  await assert.rejects(verifyReplacementAudio(original, replacement, { captions }), (error: any) => {
    assert.equal(error.code, 'MEDIA_AUDIO_MISMATCH');
    assert.equal(error.audioChangeEvidence?.comparedSamples, signal.length, 'a confirmation challenge requires complete decode evidence');
    assert.equal(error.audioChangeEvidence?.audioMatches, false);
    return true;
  });
});

test('audio-change permission cannot bypass duration, invalid caption bounds, corruption, decoder failures or cancellation', async () => {
  const replacement = await wav('unsafe-override-gain.wav', signal.map((sample) => sample * 0.4));
  for (const options of [
    { captions: [{ startMs: 10, endMs: 4100 }] },
    { captions: [{ startMs: -1, endMs: 100 }] },
    { captions: [{ startMs: 10, endMs: NaN }] },
    { expectedDurationMs: 3000 },
  ]) await assert.rejects(verifyReplacementAudio(original, replacement, { ...options, allowAudioChanges: true }), { code: 'MEDIA_TIMELINE_MISMATCH' });
  const short = await wav('unsafe-override-short.wav', signal.slice(0, rate * 3));
  await assert.rejects(verifyReplacementAudio(original, short, { allowAudioChanges: true }), { code: 'MEDIA_TIMELINE_MISMATCH' });
  const corrupt = path.join(root, 'unsafe-override-corrupt.wav');
  await fs.writeFile(corrupt, 'not decodable media');
  await assert.rejects(verifyReplacementAudio(original, corrupt, { allowAudioChanges: true }), (error: any) => {
    assert.equal(error.code, 'MEDIA_AUDIO_UNVERIFIABLE');
    assert.equal(error.audioChangeEvidence, undefined);
    return true;
  });
  const dc = await wav('unsafe-override-dc.wav', new Float64Array(signal.length).fill(0.1));
  await assert.rejects(verifyReplacementAudio(dc, dc, { allowAudioChanges: true }), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  const decoder = config.ffmpegPath;
  try {
    config.ffmpegPath = path.join(root, 'nonexistent-decoder');
    await assert.rejects(verifyReplacementAudio(original, replacement, { allowAudioChanges: true }), (error: any) => {
      assert.equal(error.code, 'MEDIA_AUDIO_UNVERIFIABLE');
      assert.equal(error.audioChangeEvidence, undefined);
      return true;
    });
  } finally { config.ffmpegPath = decoder; }
  await assert.rejects(verifyReplacementAudio(original, replacement, { allowAudioChanges: true, signal: AbortSignal.abort() }), { code: 'MEDIA_AUDIO_UNVERIFIABLE' });
  assert.equal((await verifyReplacementAudio(original, original)).comparedSamples, signal.length, 'decoder failure/cancellation release admission');
});

test('a late timestamp discontinuity cannot become an accepted mismatch after an earlier audio edit', async () => {
  const normal = path.join(root, 'override-clock-normal.mkv');
  const gap = path.join(root, 'override-clock-gap.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=160x90:r=25:d=4', '-i', original, '-c:v', 'libx264', '-threads', '1', '-c:a', 'pcm_s16le', '-t', '4', normal]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=s=160x90:r=25:d=4', '-i', original, '-af', "volume=1.7,asetpts=PTS+if(between(T\\,2\\,3)\\,0.01/TB\\,0)", '-c:v', 'libx264', '-threads', '1', '-c:a', 'pcm_s16le', '-t', '4', gap]);
  for (const allowAudioChanges of [false, true]) await assert.rejects(verifyReplacementAudio(normal, gap, { allowAudioChanges }), (error: any) => {
    assert.equal(error.code, 'MEDIA_TIMELINE_MISMATCH');
    assert.equal(error.audioChangeEvidence, undefined, 'unsafe full timeline must never issue confirmation evidence');
    return true;
  });
});

test('an audible flat window remains unverifiable even when the rest of the timeline contains enough voice evidence', async () => {
  const flat = signal.slice();
  const start = rate;
  const end = start + 2 * 960;
  flat.fill(0.125, start, end);
  const slightlyDifferent = flat.slice();
  slightlyDifferent.fill(0.13, start, end); // Residual below 6%; correlation is undefined for both flat windows.
  const sourceWithDc = await wav('voice-and-dc.wav', flat);
  const changedDc = await wav('voice-and-different-dc.wav', slightlyDifferent);
  for (const replacement of [sourceWithDc, changedDc]) for (const allowAudioChanges of [false, true]) {
    await assert.rejects(verifyReplacementAudio(sourceWithDc, replacement, { captions, allowAudioChanges }), (error: any) => {
      assert.equal(error.code, 'MEDIA_AUDIO_UNVERIFIABLE');
      assert.equal(error.audioChangeEvidence, undefined, 'undefined audible correlation must never certify audio or offer confirmation');
      return true;
    });
  }
});

test('added music and SFX over exact source silence are explicit audio differences after complete safe decoding', async () => {
  const paused = signal.slice();
  paused.fill(0, rate, rate * 1.5);
  const pausedSource = await wav('voice-with-zero-pause.wav', paused);
  for (const kind of ['music', 'sfx'] as const) {
    const changed = paused.map((sample) => sample * 1.4);
    const start = kind === 'music' ? rate : Math.round(rate * 1.2);
    const end = kind === 'music' ? rate * 1.5 : start + 2 * 960;
    for (let i = start; i < end; i++) changed[i] += 0.08 * Math.sin(2 * Math.PI * (kind === 'music' ? 367 : 2300) * i / rate);
    const replacement = await wav(`pause-with-${kind}.wav`, changed);
    await assert.rejects(verifyReplacementAudio(pausedSource, replacement, { captions }), (error: any) => {
      assert.equal(error.code, 'MEDIA_AUDIO_MISMATCH', `${kind}: a proven signal addition may offer explicit confirmation`);
      assert.equal(error.audioChangeEvidence?.audioMatches, false);
      assert.equal(error.audioChangeEvidence?.comparedSamples, signal.length);
      return true;
    });
    const accepted = await verifyReplacementAudio(pausedSource, replacement, { captions, allowAudioChanges: true });
    assert.equal(accepted.audioMatches, false, `${kind}: explicit acceptance must never certify the new audio as matching`);
    assert.equal(accepted.comparedSamples, signal.length);
  }
});
