import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import {
  DEFAULT_CAPTION_APPEARANCE,
  type CaptionAppearance,
  type CaptionProject,
  type CaptionSegment,
  type VideoCodec,
  type VideoEncoderPreference,
  type VideoExportCapabilities,
  type VideoExportEncoderCapability,
  type VideoExportFontCapability,
  type VideoExportResolutionOption,
  type VideoExportResult,
  type VideoExportSettings,
  type VideoExportSourceInfo,
  type VideoFrameRatePreset,
  type VideoHdrKind,
  type VideoQualityPreset,
  type VideoResolutionPreset,
} from '@kcs/shared';
import { config } from '../config.js';
import { runCommand } from './media.js';

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

const resolutionBounds: Record<Exclude<VideoResolutionPreset, 'source'>, { landscape: [number, number]; portrait: [number, number] }> = {
  '720p': { landscape: [1280, 720], portrait: [720, 1280] },
  '1080p': { landscape: [1920, 1080], portrait: [1080, 1920] },
  '1440p': { landscape: [2560, 1440], portrait: [1440, 2560] },
  '2160p': { landscape: [3840, 2160], portrait: [2160, 3840] },
};

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

function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function safeHex(value: unknown, fallback: string) {
  const raw = String(value || '').trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(raw) ? raw : fallback;
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

export function normalizeCaptionAppearance(value: Partial<CaptionAppearance> | null | undefined): CaptionAppearance {
  const raw = value || {};
  return {
    fontFamily: String(raw.fontFamily || DEFAULT_CAPTION_APPEARANCE.fontFamily).trim().slice(0, 80) || DEFAULT_CAPTION_APPEARANCE.fontFamily,
    fontSize1080: clamp(Number(raw.fontSize1080), 22, 120, DEFAULT_CAPTION_APPEARANCE.fontSize1080),
    bold: raw.bold !== false,
    textColor: safeHex(raw.textColor, DEFAULT_CAPTION_APPEARANCE.textColor),
    outlineColor: safeHex(raw.outlineColor, DEFAULT_CAPTION_APPEARANCE.outlineColor),
    outlineWidth1080: clamp(Number(raw.outlineWidth1080), 0, 12, DEFAULT_CAPTION_APPEARANCE.outlineWidth1080),
    shadowWidth1080: clamp(Number(raw.shadowWidth1080), 0, 12, DEFAULT_CAPTION_APPEARANCE.shadowWidth1080),
    backgroundEnabled: raw.backgroundEnabled === true,
    backgroundColor: safeHex(raw.backgroundColor, DEFAULT_CAPTION_APPEARANCE.backgroundColor),
    backgroundOpacity: clamp(Number(raw.backgroundOpacity), 0.05, 1, DEFAULT_CAPTION_APPEARANCE.backgroundOpacity),
    backgroundPadding1080: clamp(Number(raw.backgroundPadding1080), 0, 28, DEFAULT_CAPTION_APPEARANCE.backgroundPadding1080),
    alignment: ['left', 'center', 'right'].includes(String(raw.alignment)) ? raw.alignment! : DEFAULT_CAPTION_APPEARANCE.alignment,
    positionBottomPct: clamp(Number(raw.positionBottomPct), 3, 82, DEFAULT_CAPTION_APPEARANCE.positionBottomPct),
    maxWidthPct: clamp(Number(raw.maxWidthPct), 45, 96, DEFAULT_CAPTION_APPEARANCE.maxWidthPct),
  };
}

export function normalizeVideoExportSettings(value: Partial<VideoExportSettings> | null | undefined): VideoExportSettings {
  const raw = value || {};
  const resolution = ['source', '720p', '1080p', '1440p', '2160p'].includes(String(raw.resolution))
    ? raw.resolution as VideoResolutionPreset
    : 'source';
  const frameRate = raw.frameRate === 'source' || [24, 25, 30, 50, 60].includes(Number(raw.frameRate))
    ? raw.frameRate as VideoFrameRatePreset
    : 'source';
  const quality = ['smaller', 'recommended', 'high'].includes(String(raw.quality))
    ? raw.quality as VideoQualityPreset
    : 'recommended';
  const codec = ['h264', 'hevc'].includes(String(raw.codec)) ? raw.codec as VideoCodec : 'h264';
  const encoder = ['auto', 'software', 'nvidia', 'intel', 'amd'].includes(String(raw.encoder))
    ? raw.encoder as VideoEncoderPreference
    : 'auto';
  const customBitrate = Number(raw.customBitrateMbps);
  return {
    resolution,
    frameRate,
    quality,
    codec,
    encoder,
    ...(Number.isFinite(customBitrate) && customBitrate >= 1 && customBitrate <= 200 ? { customBitrateMbps: customBitrate } : {}),
  };
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

export function resolveVideoDimensions(sourceWidth: number, sourceHeight: number, preset: VideoResolutionPreset) {
  const width = even(sourceWidth);
  const height = even(sourceHeight);
  if (preset === 'source') return { width, height, upscaled: false };
  const portrait = height > width;
  const bounds = portrait ? resolutionBounds[preset].portrait : resolutionBounds[preset].landscape;
  const scale = Math.min(bounds[0] / width, bounds[1] / height);
  const outputWidth = even(width * scale);
  const outputHeight = even(height * scale);
  return {
    width: outputWidth,
    height: outputHeight,
    upscaled: outputWidth > width * 1.01 || outputHeight > height * 1.01,
  };
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

async function hasSubtitlesFilter() {
  try {
    const { stdout, stderr } = await runCommand(config.ffmpegPath, ['-hide_banner', '-filters'], 'FFmpeg filter probe', 12_000);
    return /\bsubtitles\b/i.test(`${stdout}\n${stderr}`);
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

async function candidateFont(name: string, regularPath: string, boldPath?: string, source: VideoExportFontCapability['source'] = 'windows-system') {
  const available = await fs.stat(regularPath).then((stat) => stat.isFile()).catch(() => false);
  const boldAvailable = boldPath ? await fs.stat(boldPath).then((stat) => stat.isFile()).catch(() => false) : available;
  return { name, available, boldAvailable, source } satisfies VideoExportFontCapability;
}

async function fontCapabilities() {
  const fonts: VideoExportFontCapability[] = [];
  if (process.platform === 'win32') {
    const windows = process.env.WINDIR || 'C:\\Windows';
    const systemFonts = path.join(windows, 'Fonts');
    fonts.push(await candidateFont('Khmer UI', path.join(systemFonts, 'KhmerUI.ttf'), path.join(systemFonts, 'KhmerUIB.ttf')));
    fonts.push(await candidateFont('DaunPenh', path.join(systemFonts, 'Daunpenh.ttf')));
    fonts.push(await candidateFont('MoolBoran', path.join(systemFonts, 'Moolbor.ttf')));
    const userFonts = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts');
    if (process.env.LOCALAPPDATA) {
      try {
        const names = await fs.readdir(userFonts);
        const regular = names.find((name) => /^NotoSansKhmer(?:-Regular)?\.(?:ttf|otf)$/i.test(name));
        const bold = names.find((name) => /^NotoSansKhmer-Bold\.(?:ttf|otf)$/i.test(name));
        if (regular) fonts.push(await candidateFont('Noto Sans Khmer', path.join(userFonts, regular), bold ? path.join(userFonts, bold) : undefined, 'user-installed'));
      } catch { /* optional user font directory */ }
    }
  } else {
    const linuxCandidates = [
      ['/usr/share/fonts/truetype/noto/NotoSansKhmer-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSansKhmer-Bold.ttf'],
      ['/usr/share/fonts/opentype/noto/NotoSansKhmer-Regular.ttf', '/usr/share/fonts/opentype/noto/NotoSansKhmer-Bold.ttf'],
    ];
    for (const [regular, bold] of linuxCandidates) {
      const item = await candidateFont('Noto Sans Khmer', regular, bold, 'linux-system');
      if (item.available) { fonts.push(item); break; }
    }
  }
  return fonts.filter((font, index, all) => all.findIndex((item) => item.name === font.name) === index);
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
  const [source, subtitlesFilter, encoders, fonts, availableDiskBytes] = await Promise.all([
    probeMedia(projectMediaPath(project)),
    hasSubtitlesFilter(),
    encoderCapabilities(),
    fontCapabilities(),
    diskFreeBytes(config.exportDir),
  ]);
  const warnings: string[] = [];
  if (source.variableFrameRate) warnings.push('Variable-frame-rate source detected. Match source preserves source timestamps; a fixed frame rate converts to CFR.');
  if (source.bitDepth > 8 && source.hdr === 'sdr') warnings.push(`${source.bitDepth}-bit SDR source detected. H.264 compatibility output is 8-bit; HEVC software export can preserve 10-bit when available.`);
  if (source.audioStreams > 1) warnings.push(`${source.audioStreams} audio tracks detected. Studio preserves all tracks, transcoding to AAC only when MP4 compatibility requires it.`);
  if (source.hdr !== 'sdr') warnings.push('HDR source detected. Captioned-video export is blocked until Studio can preserve HDR appearance without color damage.');
  if (!subtitlesFilter) warnings.push('This FFmpeg build does not expose the libass subtitles filter required for burned-in captions.');
  if (!fonts.some((font) => font.available)) warnings.push('No reviewed Khmer export font was found on this system.');
  if (!encoders.some((item) => item.codec === 'h264' && item.available)) warnings.push('No usable H.264 encoder was detected.');
  const blockingReason = source.hdr !== 'sdr'
    ? `This source is ${source.hdr === 'hlg' ? 'HLG HDR' : source.hdr === 'hdr10' ? 'HDR10/PQ' : source.hdr === 'dolby-vision' ? 'Dolby Vision' : 'HDR'}. Studio will not silently flatten HDR during caption rendering. Export SRT instead, or convert the source to SDR in a color-managed editor first.`
    : !subtitlesFilter
      ? 'This FFmpeg installation does not include the subtitles/libass filter required for Khmer burned-in captions.'
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
    fonts,
    subtitlesFilter,
    availableDiskBytes,
    warnings,
  };
  capabilityCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function assTimestamp(ms: number) {
  const totalCentiseconds = Math.max(0, Math.round(ms / 10));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

export function escapeAssText(text: string) {
  return String(text || '')
    .replace(/\\/g, '＼')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\r?\n/g, '\\N')
    .trim();
}

function assColor(hex: string, opacity = 1) {
  const value = safeHex(hex, '#FFFFFF').slice(1);
  const rr = value.slice(0, 2);
  const gg = value.slice(2, 4);
  const bb = value.slice(4, 6);
  const alpha = Math.round((1 - clamp(opacity, 0, 1, 1)) * 255).toString(16).toUpperCase().padStart(2, '0');
  return `&H${alpha}${bb}${gg}${rr}`;
}

function wrapCaptionText(text: string, maxGraphemesPerLine: number) {
  const lines = String(text || '').split(/\r?\n/);
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('km', { granularity: 'grapheme' }) : null;
  const output: string[] = [];
  for (const line of lines) {
    const graphemes = segmenter ? Array.from(segmenter.segment(line), (item) => item.segment) : Array.from(line);
    if (graphemes.length <= maxGraphemesPerLine) {
      output.push(line);
      continue;
    }
    let cursor = 0;
    while (cursor < graphemes.length) {
      const hardEnd = Math.min(graphemes.length, cursor + maxGraphemesPerLine);
      let end = hardEnd;
      if (hardEnd < graphemes.length) {
        const floor = cursor + Math.max(1, Math.floor(maxGraphemesPerLine * 0.62));
        for (let index = hardEnd - 1; index >= floor; index -= 1) {
          if (/\s|[។៕៖!?.,:;]/u.test(graphemes[index] || '')) {
            end = index + 1;
            break;
          }
        }
      }
      output.push(graphemes.slice(cursor, end).join('').trim());
      cursor = end;
      while (cursor < graphemes.length && /\s/u.test(graphemes[cursor] || '')) cursor += 1;
    }
  }
  return output.filter(Boolean).join('\n');
}

export function buildAssDocument(captions: CaptionSegment[], appearanceInput: Partial<CaptionAppearance> | undefined, width: number, height: number) {
  const appearance = normalizeCaptionAppearance(appearanceInput);
  const scale = height / 1080;
  const fontSize = Math.round(appearance.fontSize1080 * scale * 10) / 10;
  const outline = Math.round(appearance.outlineWidth1080 * scale * 10) / 10;
  const shadow = Math.round(appearance.shadowWidth1080 * scale * 10) / 10;
  const boxPadding = Math.round(appearance.backgroundPadding1080 * scale * 10) / 10;
  const sideMargin = Math.max(8, Math.round(width * (100 - appearance.maxWidthPct) / 200));
  const marginV = Math.max(8, Math.round(height * appearance.positionBottomPct / 100));
  const usableWidth = width * appearance.maxWidthPct / 100;
  const maxGraphemesPerLine = Math.max(6, Math.floor(usableWidth / Math.max(1, fontSize * 0.72)));
  const alignment = appearance.alignment === 'left' ? 1 : appearance.alignment === 'right' ? 3 : 2;
  const borderStyle = appearance.backgroundEnabled ? 3 : 1;
  const styleOutline = appearance.backgroundEnabled ? Math.max(boxPadding, outline) : outline;
  const backColor = assColor(appearance.backgroundColor, appearance.backgroundEnabled ? appearance.backgroundOpacity : 0);
  const events = captions
    .filter((caption) => caption.text.trim() && caption.endMs > caption.startMs)
    .map((caption) => `Dialogue: 0,${assTimestamp(caption.startMs)},${assTimestamp(caption.endMs)},Default,,0,0,0,,${escapeAssText(wrapCaptionText(caption.text, maxGraphemesPerLine))}`)
    .join('\n');
  return `\uFEFF[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${appearance.fontFamily.replace(/,/g, ' ')},${fontSize},${assColor(appearance.textColor)},${assColor(appearance.textColor)},${assColor(appearance.outlineColor)},${backColor},${appearance.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${styleOutline},${shadow},${alignment},${sideMargin},${sideMargin},${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events}\n`;
}

function filterPath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function selectedFontDirectory(fontName: string) {
  if (process.platform === 'win32') {
    if (fontName === 'Noto Sans Khmer' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts');
    return path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  }
  return '/usr/share/fonts';
}

function qualityCrf(codec: VideoCodec, quality: VideoQualityPreset) {
  if (codec === 'hevc') return quality === 'high' ? 18 : quality === 'smaller' ? 25 : 21;
  return quality === 'high' ? 17 : quality === 'smaller' ? 23 : 19;
}

function targetBitrateMbps(width: number, height: number, fps: number, codec: VideoCodec, quality: VideoQualityPreset) {
  const bpp = quality === 'high' ? 0.15 : quality === 'smaller' ? 0.065 : 0.1;
  const efficiency = codec === 'hevc' ? 0.72 : 1;
  return clamp(width * height * Math.max(12, fps) * bpp * efficiency / 1_000_000, 1.5, codec === 'hevc' ? 100 : 140, 8);
}

export function estimateVideoExportBytes(source: VideoExportSourceInfo, settingsInput: Partial<VideoExportSettings> | undefined) {
  const settings = normalizeVideoExportSettings(settingsInput);
  const dims = resolveVideoDimensions(source.displayWidth, source.displayHeight, settings.resolution);
  const fps = settings.frameRate === 'source' ? source.frameRate : settings.frameRate;
  const mbps = settings.customBitrateMbps || targetBitrateMbps(dims.width, dims.height, fps, settings.codec, settings.quality);
  const audioMbps = source.audioStreams ? 0.256 * source.audioStreams : 0;
  return Math.ceil((mbps + audioMbps) * 1_000_000 / 8 * source.durationMs / 1000 * 1.04);
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
  if (!stat.isFile() || stat.size < 16_384) throw new Error('Export verification failed: output file is empty or incomplete.');
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
  appearance: CaptionAppearance,
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
    `subtitles=filename='${filterPath(assPath)}':fontsdir='${filterPath(selectedFontDirectory(appearance.fontFamily))}'`,
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
  const font = capabilities.fonts.find((item) => item.name === appearance.fontFamily && item.available)
    || capabilities.fonts.find((item) => item.available);
  if (!font) throw new Error('No reviewed Khmer font is available for video export.');
  appearance.fontFamily = font.name;
  if (appearance.bold && !font.boldAvailable) appearance.bold = false;
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
    await fs.writeFile(assPath, buildAssDocument(captions, appearance, dimensions.width, dimensions.height), 'utf8');
    throwIfCancelled(callbacks);

    const render = async () => {
      await fs.rm(partialPath, { force: true }).catch(() => {});
      await runFfmpegRender(
        buildRenderArgs(project, assPath, partialPath, appearance, settings, capabilities.source, encoder, dimensions.width, dimensions.height, outputFps),
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
