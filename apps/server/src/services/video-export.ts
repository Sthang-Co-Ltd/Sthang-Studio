import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import {
  normalizeCaptionAppearance, normalizeVideoExportSettings, resolveVideoDimensions,
  estimateVideoExportBytes, targetBitrateMbps,
  type CaptionAppearance,
  type CaptionProject,
  type CaptionSegment,
  type VideoCodec,
  type VideoExportCapabilities,
  type VideoExportEncoderCapability,
  type VideoExportResolutionOption,
  type VideoExportResult,
  type VideoExportSettings,
  type VideoExportSourceInfo,
  type VideoHdrKind,
  type VideoQualityPreset,
  type VideoResolutionPreset,
} from '@kcs/shared';
import { config } from '../config.js';
import { runCommand } from './media.js';
import { buildAssDocument, buildAssCaptionFilter, fontCapabilities, requireCaptionFont, prepareCaptionFonts } from './caption-renderer.js';
import { supportsComplexAssFilterHelp } from './caption-preview.js';
export { supportsComplexAssFilterHelp };

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  color_range?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<Record<string, unknown>>;
}

interface ProbePayload {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

interface RenderCallbacks {
  onProgress?: (progress: number, message: string) => Promise<void> | void;
  shouldCancel?: () => boolean;
}

const encoderProbeCache = new Map<string, Promise<boolean>>();
const capabilityCache = new Map<string, { at: number; value: VideoExportCapabilities }>();
const capabilityCacheMs = 30_000;

const resolutionLabels: Record<VideoResolutionPreset, string> = {
  source: 'Original',
  '720p': 'HD 720p',
  '1080p': 'Full HD 1080p',
  '1440p': 'QHD 1440p',
  '2160p': '4K UHD 2160p',
};

function even(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function ffmpegMetadataValue(value: string | undefined) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || ['unknown', 'unspecified', 'reserved', 'n/a'].includes(raw)) return undefined;
  return raw;
}

function cancellationError() {
  return new Error('Video export cancelled.');
}

function throwIfCancelled(callbacks: RenderCallbacks) {
  if (callbacks.shouldCancel?.()) throw cancellationError();
}

async function emitProgress(callbacks: RenderCallbacks, progress: number, message: string) {
  throwIfCancelled(callbacks);
  await callbacks.onProgress?.(progress, message);
  throwIfCancelled(callbacks);
}

export function parseRate(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw || raw === '0/0') return 0;
  if (raw.includes('/')) {
    const [num, den] = raw.split('/').map(Number);
    return Number.isFinite(num) && Number.isFinite(den) && den !== 0 ? num / den : 0;
  }
  const direct = Number(raw);
  return Number.isFinite(direct) ? direct : 0;
}

function parseSar(value: unknown) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d+):(\d+)$/);
  if (!match) return 1;
  const num = Number(match[1]);
  const den = Number(match[2]);
  return num > 0 && den > 0 ? num / den : 1;
}

function streamRotation(stream: ProbeStream) {
  const sideRotation = stream.side_data_list
    ?.map((entry) => Number(entry.rotation))
    .find((value) => Number.isFinite(value));
  const raw = Number.isFinite(sideRotation) ? sideRotation! : Number(stream.tags?.rotate || 0);
  if (!Number.isFinite(raw)) return 0;
  const normalized = Math.round(raw) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function classifyHdr(stream: Pick<ProbeStream, 'codec_tag_string' | 'color_transfer' | 'color_primaries' | 'side_data_list'>): VideoHdrKind {
  const tag = String(stream.codec_tag_string || '').toLowerCase();
  const sideDataText = JSON.stringify(stream.side_data_list || []).toLowerCase();
  if (tag.includes('dvh1') || tag.includes('dvhe') || sideDataText.includes('dovi')) return 'dolby-vision';
  const transfer = String(stream.color_transfer || '').toLowerCase();
  if (transfer === 'smpte2084') return 'hdr10';
  if (transfer === 'arib-std-b67') return 'hlg';
  const primaries = String(stream.color_primaries || '').toLowerCase();
  if (primaries === 'bt2020' && transfer && !['bt709', 'iec61966-2-1'].includes(transfer)) return 'unknown-hdr';
  return 'sdr';
}

function bitDepth(stream: ProbeStream) {
  const declared = Number(stream.bits_per_raw_sample);
  if (Number.isFinite(declared) && declared >= 8) return declared;
  const pix = String(stream.pix_fmt || '').toLowerCase();
  const match = pix.match(/(?:p|le|be)(10|12|14|16)(?:le|be)?$/) || pix.match(/(10|12|14|16)/);
  return match ? Number(match[1]) : 8;
}

function resolutionOptions(source: VideoExportSourceInfo): VideoExportResolutionOption[] {
  return (['source', '720p', '1080p', '1440p', '2160p'] as VideoResolutionPreset[]).map((id) => ({
    id,
    label: resolutionLabels[id],
    ...resolveVideoDimensions(source.displayWidth, source.displayHeight, id),
  }));
}

async function probeMedia(inputPath: string): Promise<VideoExportSourceInfo> {
  const { stdout } = await runCommand(config.ffprobePath, [
    '-v', 'error',
    '-show_streams', '-show_format',
    '-of', 'json',
    inputPath,
  ], 'Video metadata probe', 20_000);
  const payload = JSON.parse(stdout) as ProbePayload;
  const video = payload.streams?.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height) throw new Error('The source does not contain a usable video stream.');
  const rotation = streamRotation(video);
  const sar = parseSar(video.sample_aspect_ratio);
  let displayWidth = even(video.width * sar);
  let displayHeight = even(video.height);
  if (rotation === 90 || rotation === 270) [displayWidth, displayHeight] = [displayHeight, displayWidth];
  const avgFrameRate = parseRate(video.avg_frame_rate);
  const nominalFrameRate = parseRate(video.r_frame_rate);
  const frameRate = avgFrameRate || nominalFrameRate || 30;
  const durationSeconds = Number(video.duration || payload.format?.duration || 0);
  const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : 0;
  const audio = (payload.streams || []).filter((stream) => stream.codec_type === 'audio');
  return {
    width: even(video.width),
    height: even(video.height),
    displayWidth,
    displayHeight,
    rotation,
    durationMs,
    frameRate,
    variableFrameRate: avgFrameRate > 0 && nominalFrameRate > 0 && Math.abs(avgFrameRate - nominalFrameRate) > 0.02,
    videoCodec: String(video.codec_name || 'unknown'),
    pixelFormat: String(video.pix_fmt || 'unknown'),
    bitDepth: bitDepth(video),
    colorPrimaries: ffmpegMetadataValue(video.color_primaries),
    colorTransfer: ffmpegMetadataValue(video.color_transfer),
    colorSpace: ffmpegMetadataValue(video.color_space),
    colorRange: ffmpegMetadataValue(video.color_range),
    hdr: classifyHdr(video),
    audioCodecs: audio.map((stream) => String(stream.codec_name || 'unknown')),
    audioStreams: audio.length,
  };
}

async function hasComplexAssFilter() {
  try {
    const { stdout, stderr } = await runCommand(config.ffmpegPath, ['-hide_banner', '-h', 'filter=ass'], 'FFmpeg ASS shaping probe', 12_000);
    return supportsComplexAssFilterHelp(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

async function probeEncoderUsable(encoder: string) {
  let pending = encoderProbeCache.get(encoder);
  if (pending) return pending;
  pending = (async () => {
    try {
      await runCommand(config.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1',
        '-frames:v', '1', '-an', '-pix_fmt', 'yuv420p',
        '-c:v', encoder,
        '-f', 'null', '-',
      ], `${encoder} encoder probe`, 12_000);
      return true;
    } catch {
      return false;
    }
  })();
  encoderProbeCache.set(encoder, pending);
  return pending;
}

async function encoderCapabilities(): Promise<VideoExportEncoderCapability[]> {
  const definitions: Array<Omit<VideoExportEncoderCapability, 'available'>> = [
    { id: 'software', label: 'Software', encoder: 'libx264', codec: 'h264', hardware: false },
    { id: 'nvidia', label: 'NVIDIA GPU', encoder: 'h264_nvenc', codec: 'h264', hardware: true },
    { id: 'intel', label: 'Intel GPU', encoder: 'h264_qsv', codec: 'h264', hardware: true },
    { id: 'amd', label: 'AMD GPU', encoder: 'h264_amf', codec: 'h264', hardware: true },
    { id: 'software', label: 'Software', encoder: 'libx265', codec: 'hevc', hardware: false },
    { id: 'nvidia', label: 'NVIDIA GPU', encoder: 'hevc_nvenc', codec: 'hevc', hardware: true },
    { id: 'intel', label: 'Intel GPU', encoder: 'hevc_qsv', codec: 'hevc', hardware: true },
    { id: 'amd', label: 'AMD GPU', encoder: 'hevc_amf', codec: 'hevc', hardware: true },
  ];
  const available = await Promise.all(definitions.map((item) => probeEncoderUsable(item.encoder)));
  return definitions.map((item, index) => ({ ...item, available: available[index] }));
}

async function diskFreeBytes(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
    const stat = await fs.statfs(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return 0;
  }
}

function projectMediaPath(project: CaptionProject) {
  return path.join(config.uploadDir, project.media.filename);
}

export async function probeVideoExportCapabilities(project: CaptionProject, force = false): Promise<VideoExportCapabilities> {
  const cacheKey = `${project.id}:${project.media.filename}:${project.media.size}`;
  if (force) {
    capabilityCache.delete(cacheKey);
    encoderProbeCache.clear();
  }
  const cached = capabilityCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < capabilityCacheMs) return cached.value;
  const [source, complexAssFilter, encoders, fonts, availableDiskBytes] = await Promise.all([
    probeMedia(projectMediaPath(project)),
    hasComplexAssFilter(),
    encoderCapabilities(),
    fontCapabilities(),
    diskFreeBytes(config.exportDir),
  ]);
  const warnings: string[] = [];
  if (source.variableFrameRate) warnings.push('Variable-frame-rate source detected. Match source preserves source timestamps; a fixed frame rate converts to CFR.');
  if (source.bitDepth > 8 && source.hdr === 'sdr') warnings.push(`${source.bitDepth}-bit SDR source detected. H.264 compatibility output is 8-bit; HEVC software export can preserve 10-bit when available.`);
  if (source.audioStreams > 1) warnings.push(`${source.audioStreams} audio tracks detected. Studio preserves all tracks, transcoding to AAC only when MP4 compatibility requires it.`);
  if (source.hdr !== 'sdr') warnings.push('HDR source detected. Captioned-video export is blocked until Studio can preserve HDR appearance without color damage.');
  if (!complexAssFilter) warnings.push('This FFmpeg build does not expose the native ASS/libass complex shaping required for correct Khmer captions.');
  if (!fonts.some((font) => font.available)) warnings.push('No reviewed Khmer export font was found on this system.');
  if (!encoders.some((item) => item.codec === 'h264' && item.available)) warnings.push('No usable H.264 encoder was detected.');
  const blockingReason = source.hdr !== 'sdr'
    ? `This source is ${source.hdr === 'hlg' ? 'HLG HDR' : source.hdr === 'hdr10' ? 'HDR10/PQ' : source.hdr === 'dolby-vision' ? 'Dolby Vision' : 'HDR'}. Studio will not silently flatten HDR during caption rendering. Export SRT instead, or convert the source to SDR in a color-managed editor first.`
    : !complexAssFilter
      ? 'This FFmpeg installation cannot guarantee correct Khmer shaping. Studio requires the native ASS/libass filter with complex shaping; install the reviewed FFmpeg runtime or point FFMPEG_PATH to a compatible build.'
      : !fonts.some((font) => font.available)
        ? 'No reviewed Khmer font is available to the local renderer. Windows Khmer UI is the default supported font.'
        : !encoders.some((item) => item.codec === 'h264' && item.available)
          ? 'No usable H.264 video encoder was detected in this FFmpeg installation.'
          : undefined;
  const value: VideoExportCapabilities = {
    supported: !blockingReason,
    blockingReason,
    source,
    resolutions: resolutionOptions(source),
    encoders,
    fonts: fonts.map(({ name, available, boldAvailable, source }) => ({ name, available, boldAvailable, source })),
    subtitlesFilter: complexAssFilter,
    availableDiskBytes,
    warnings,
  };
  for (const [key, entry] of capabilityCache) if (Date.now() - entry.at >= capabilityCacheMs) capabilityCache.delete(key);
  if (capabilityCache.size >= 32) capabilityCache.delete(capabilityCache.keys().next().value!);
  capabilityCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function qualityCrf(codec: VideoCodec, quality: VideoQualityPreset) {
  if (codec === 'hevc') return quality === 'high' ? 18 : quality === 'smaller' ? 25 : 21;
  return quality === 'high' ? 17 : quality === 'smaller' ? 23 : 19;
}

function chooseEncoder(capabilities: VideoExportCapabilities, settings: VideoExportSettings) {
  const available = capabilities.encoders.filter((item) => item.codec === settings.codec && item.available);
  if (!available.length) throw new Error(`No usable ${settings.codec === 'hevc' ? 'HEVC' : 'H.264'} encoder is available.`);
  if (settings.encoder === 'auto') {
    return available.find((item) => item.hardware) || available.find((item) => item.id === 'software') || available[0];
  }
  const requested = available.find((item) => item.id === settings.encoder);
  if (!requested) throw new Error(`${settings.encoder} ${settings.codec.toUpperCase()} encoding is not available on this PC. Choose Auto or another encoder.`);
  return requested;
}

function softwareEncoder(capabilities: VideoExportCapabilities, codec: VideoCodec) {
  return capabilities.encoders.find((item) => item.codec === codec && item.id === 'software' && item.available);
}

function encoderArgs(capability: VideoExportEncoderCapability, settings: VideoExportSettings, width: number, height: number, fps: number, sourceBitDepth: number) {
  const args = ['-c:v', capability.encoder];
  if (!capability.hardware) {
    args.push('-preset', settings.quality === 'high' ? 'slow' : settings.quality === 'smaller' ? 'fast' : 'medium');
    if (settings.customBitrateMbps) {
      const target = settings.customBitrateMbps;
      args.push('-b:v', `${target.toFixed(2)}M`, '-maxrate', `${(target * 1.5).toFixed(2)}M`, '-bufsize', `${(target * 2).toFixed(2)}M`);
    } else {
      args.push('-crf', String(qualityCrf(settings.codec, settings.quality)));
    }
  } else {
    const target = settings.customBitrateMbps || targetBitrateMbps(width, height, fps, settings.codec, settings.quality);
    args.push('-b:v', `${target.toFixed(2)}M`, '-maxrate', `${(target * 1.5).toFixed(2)}M`, '-bufsize', `${(target * 2).toFixed(2)}M`);
  }
  const preserve10Bit = settings.codec === 'hevc' && !capability.hardware && sourceBitDepth > 8;
  args.push('-pix_fmt', preserve10Bit ? 'yuv420p10le' : 'yuv420p');
  if (settings.codec === 'hevc') args.push('-tag:v', 'hvc1');
  return args;
}

function parseProgressTime(value: string) {
  const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
}

async function runFfmpegRender(args: string[], durationMs: number, callbacks: RenderCallbacks) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let stderr = '';
    let cancelled = false;
    let lastReported = -1;
    let progressError: unknown = null;
    let progressPromise: Promise<void> = Promise.resolve();
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(cancelTimer);
      operation();
    };
    const requestStop = () => {
      if (cancelled) return;
      cancelled = true;
      child.kill();
    };
    const cancelTimer = setInterval(() => {
      if (callbacks.shouldCancel?.()) requestStop();
    }, 250);
    const report = (line: string) => {
      if (!line.startsWith('out_time=')) return;
      const elapsed = parseProgressTime(line.slice('out_time='.length));
      const progress = Math.max(3, Math.min(96, Math.round(elapsed / Math.max(1, durationMs) * 96)));
      if (progress === lastReported) return;
      lastReported = progress;
      progressPromise = progressPromise
        .then(() => emitProgress(callbacks, progress, `Rendering captioned video… ${progress}%`))
        .catch((error) => {
          progressError = error;
          requestStop();
        });
    };
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += String(chunk);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      lines.forEach(report);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
    });
    child.on('error', (error) => finish(() => reject(new Error(`FFmpeg could not start. ${error.message}`))));
    child.on('close', (code) => finish(() => {
      void progressPromise.finally(() => {
        if (progressError) {
          reject(progressError);
          return;
        }
        if (cancelled || callbacks.shouldCancel?.()) {
          reject(cancellationError());
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(`Video render failed (exit ${code}). ${stderr.trim() || 'FFmpeg did not provide an error message.'}`));
      });
    }));
  });
}

function outputName(project: CaptionProject, preset: VideoResolutionPreset) {
  const base = project.title.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'Sthang-Studio';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${base}-captioned-${preset}-${stamp}-${nanoid(5)}.mp4`;
}

function verifyDefinedMetadata(label: string, expected: string | undefined, actual: string | undefined) {
  if (!expected) return;
  if (actual !== expected) throw new Error(`Export verification failed: ${label} changed from ${expected} to ${actual || 'unspecified'}.`);
}

export function validateVideoExportProbe(
  result: VideoExportSourceInfo,
  expectedWidth: number,
  expectedHeight: number,
  source: VideoExportSourceInfo,
  settings: VideoExportSettings,
) {
  if (result.displayWidth !== expectedWidth || result.displayHeight !== expectedHeight) {
    throw new Error(`Export verification failed: expected ${expectedWidth}×${expectedHeight}, received ${result.displayWidth}×${result.displayHeight}.`);
  }
  const durationTolerance = Math.max(750, Math.ceil(1000 / Math.max(1, result.frameRate)) * 2);
  if (source.durationMs > 0 && Math.abs(result.durationMs - source.durationMs) > durationTolerance) {
    throw new Error(`Export verification failed: output duration differs from the source by ${Math.abs(result.durationMs - source.durationMs)} ms.`);
  }
  if (result.audioStreams !== source.audioStreams) {
    throw new Error(`Export verification failed: expected ${source.audioStreams} audio track${source.audioStreams === 1 ? '' : 's'}, received ${result.audioStreams}.`);
  }
  if (settings.frameRate !== 'source') {
    const expectedFrameRate = Number(settings.frameRate);
    const tolerance = Math.max(0.05, expectedFrameRate * 0.002);
    if (Math.abs(result.frameRate - expectedFrameRate) > tolerance) {
      throw new Error(`Export verification failed: requested ${expectedFrameRate} fps, received ${result.frameRate.toFixed(3)} fps.`);
    }
  }
  if (result.rotation !== 0) throw new Error(`Export verification failed: unexpected ${result.rotation}° rotation metadata remains on the output.`);
  if (source.hdr === 'sdr') {
    verifyDefinedMetadata('color primaries', source.colorPrimaries, result.colorPrimaries);
    verifyDefinedMetadata('color transfer', source.colorTransfer, result.colorTransfer);
    verifyDefinedMetadata('color space', source.colorSpace, result.colorSpace);
    verifyDefinedMetadata('color range', source.colorRange, result.colorRange);
  }
  const expectedCodec = settings.codec === 'hevc' ? ['hevc', 'h265'] : ['h264', 'avc1'];
  if (!expectedCodec.some((value) => result.videoCodec.toLowerCase().includes(value))) {
    throw new Error(`Export verification failed: unexpected output video codec ${result.videoCodec}.`);
  }
}

async function validateRenderedVideo(outputPath: string, expectedWidth: number, expectedHeight: number, source: VideoExportSourceInfo, settings: VideoExportSettings) {
  const result = await probeMedia(outputPath);
  validateVideoExportProbe(result, expectedWidth, expectedHeight, source, settings);
  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || stat.size === 0) throw new Error('Export verification failed: output file is empty or incomplete.');
  return { result, sizeBytes: stat.size };
}

async function decodeSpotCheck(outputPath: string, durationMs: number) {
  const points = Array.from(new Set([0, Math.max(0, Math.round(durationMs / 2 - 100)), Math.max(0, durationMs - 1000)]));
  for (const point of points) {
    await runCommand(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', (point / 1000).toFixed(3), '-i', outputPath,
      '-frames:v', '1', '-an', '-f', 'null', '-',
    ], 'Export decode verification', 30_000);
  }
}

function buildRenderArgs(
  project: CaptionProject,
  assPath: string,
  partialPath: string,
  fontDirectory: string,
  settings: VideoExportSettings,
  source: VideoExportSourceInfo,
  encoder: VideoExportEncoderCapability,
  width: number,
  height: number,
  outputFps: number,
) {
  const filters = [
    `scale=${width}:${height}:flags=lanczos`,
    'setsar=1',
    ...(settings.frameRate === 'source' ? [] : [`fps=fps=${settings.frameRate}`]),
    buildAssCaptionFilter(assPath, fontDirectory),
  ];
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-progress', 'pipe:1', '-stats_period', '0.5',
    '-i', projectMediaPath(project),
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', filters.join(','),
    ...encoderArgs(encoder, settings, width, height, outputFps, source.bitDepth),
  ];
  if (source.audioStreams > 0) {
    const canCopyAudio = source.audioCodecs.every((codec) => codec.toLowerCase() === 'aac');
    args.push(...(canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
  }
  if (source.colorPrimaries) args.push('-color_primaries', source.colorPrimaries);
  if (source.colorTransfer) args.push('-color_trc', source.colorTransfer);
  if (source.colorSpace) args.push('-colorspace', source.colorSpace);
  if (source.colorRange) args.push('-color_range', source.colorRange);
  args.push(
    '-map_metadata', '0',
    '-metadata:s:v:0', 'rotate=0',
    '-movflags', '+faststart',
    '-fps_mode', settings.frameRate === 'source' ? 'vfr' : 'cfr',
    partialPath,
  );
  return args;
}

export async function renderCaptionedVideo(
  project: CaptionProject,
  captions: CaptionSegment[],
  appearanceInput: Partial<CaptionAppearance> | undefined,
  settingsInput: Partial<VideoExportSettings> | undefined,
  callbacks: RenderCallbacks = {},
): Promise<VideoExportResult> {
  if (!captions.some((caption) => caption.text.trim())) throw new Error('There are no captions to burn into this video.');
  const settings = normalizeVideoExportSettings(settingsInput);
  const appearance = normalizeCaptionAppearance(appearanceInput);
  const capabilities = await probeVideoExportCapabilities(project, true);
  if (!capabilities.supported) throw new Error(capabilities.blockingReason || 'Captioned-video export is not available on this PC.');
  requireCaptionFont(capabilities.fonts, appearance);
  const dimensions = resolveVideoDimensions(capabilities.source.displayWidth, capabilities.source.displayHeight, settings.resolution);
  const outputFps = settings.frameRate === 'source' ? capabilities.source.frameRate : settings.frameRate;
  let encoder = chooseEncoder(capabilities, settings);
  const estimatedBytes = estimateVideoExportBytes(capabilities.source, settings);
  const freeBytes = await diskFreeBytes(config.exportDir);
  const reserveBytes = Math.max(256 * 1024 * 1024, Math.ceil(estimatedBytes * 1.25));
  if (freeBytes > 0 && freeBytes < reserveBytes) {
    throw new Error(`Not enough free disk space for this export. Studio estimates about ${Math.ceil(estimatedBytes / 1024 / 1024)} MB and keeps extra safety space while rendering.`);
  }

  const workDir = path.join(config.exportDir, '.working', `${project.id}-${nanoid(8)}`);
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(config.exportDir, { recursive: true });
  const assPath = path.join(workDir, 'captions.ass');
  const filename = outputName(project, settings.resolution);
  const finalPath = path.join(config.exportDir, filename);
  const partialPath = path.join(workDir, `${filename}.partial.mp4`);
  try {
    await emitProgress(callbacks, 2, 'Preparing caption appearance and output settings…');
    const fontDirectory = await prepareCaptionFonts(workDir, appearance);
    await fs.writeFile(assPath, buildAssDocument(captions, appearance, dimensions.width, dimensions.height), 'utf8');
    throwIfCancelled(callbacks);

    const render = async () => {
      await fs.rm(partialPath, { force: true }).catch(() => {});
      await runFfmpegRender(
        buildRenderArgs(project, assPath, partialPath, fontDirectory, settings, capabilities.source, encoder, dimensions.width, dimensions.height, outputFps),
        capabilities.source.durationMs,
        callbacks,
      );
    };

    try {
      await render();
    } catch (error) {
      throwIfCancelled(callbacks);
      const fallback = settings.encoder === 'auto' && encoder.hardware ? softwareEncoder(capabilities, settings.codec) : undefined;
      if (!fallback || error instanceof Error && error.message === 'Video export cancelled.') throw error;
      encoder = fallback;
      await emitProgress(callbacks, 3, `The preferred GPU encoder could not finish this render. Retrying safely with ${fallback.label.toLowerCase()} encoding…`);
      await render();
    }

    throwIfCancelled(callbacks);
    await emitProgress(callbacks, 97, 'Verifying video, audio, dimensions, and duration…');
    const verified = await validateRenderedVideo(partialPath, dimensions.width, dimensions.height, capabilities.source, settings);
    throwIfCancelled(callbacks);
    await decodeSpotCheck(partialPath, verified.result.durationMs);
    throwIfCancelled(callbacks);
    await emitProgress(callbacks, 99, 'Finalizing export…');
    throwIfCancelled(callbacks);
    await fs.rename(partialPath, finalPath);
    return {
      filename,
      url: `/exports/${encodeURIComponent(filename)}`,
      sizeBytes: verified.sizeBytes,
      width: verified.result.displayWidth,
      height: verified.result.displayHeight,
      frameRate: verified.result.frameRate,
      videoCodec: settings.codec,
      encoder: encoder.encoder,
      audioCodec: verified.result.audioCodecs[0] || null,
      durationMs: verified.result.durationMs,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}