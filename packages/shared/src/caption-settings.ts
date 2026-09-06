import {
  type CaptionProject, type VideoCodec, type VideoEncoderPreference,
  type VideoExportSettings, type VideoExportSourceInfo, type VideoFrameRatePreset,
  type VideoQualityPreset, type VideoResolutionPreset,
} from './index.js';

export type CaptionHorizontalAlignment = 'left' | 'center' | 'right';

export interface CaptionAppearance {
  /** Font family resolved against reviewed local/system Khmer fonts at export time. */
  fontFamily: string;
  /** Reference size at 1080px frame height. Export scales this with output resolution. */
  fontSize1080: number;
  bold: boolean;
  textColor: string;
  outlineColor: string;
  outlineWidth1080: number;
  shadowWidth1080: number;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundPadding1080: number;
  alignment: CaptionHorizontalAlignment;
  /** Distance from the bottom of the frame, expressed as a percent of frame height. */
  positionBottomPct: number;
  /** Maximum caption region width as a percent of frame width. */
  maxWidthPct: number;
}

export const DEFAULT_CAPTION_APPEARANCE: CaptionAppearance = {
  fontFamily: 'Khmer UI',
  fontSize1080: 56,
  bold: true,
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth1080: 3,
  shadowWidth1080: 2,
  backgroundEnabled: false,
  backgroundColor: '#000000',
  backgroundOpacity: 0.58,
  backgroundPadding1080: 8,
  alignment: 'center',
  positionBottomPct: 12,
  maxWidthPct: 82,
};


const resolutionBounds: Record<Exclude<VideoResolutionPreset, 'source'>, { landscape: [number, number]; portrait: [number, number] }> = {
  '720p': { landscape: [1280, 720], portrait: [720, 1280] },
  '1080p': { landscape: [1920, 1080], portrait: [1080, 1920] },
  '1440p': { landscape: [2560, 1440], portrait: [1440, 2560] },
  '2160p': { landscape: [3840, 2160], portrait: [2160, 3840] },
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
  const frameRate = [24, 25, 30, 50, 60].includes(Number(raw.frameRate))
    ? Number(raw.frameRate) as VideoFrameRatePreset
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

export function targetBitrateMbps(width: number, height: number, fps: number, codec: VideoCodec, quality: VideoQualityPreset) {
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

/** One media-kind contract for editor availability and server routes. */
export function isVideoProject(project: Pick<CaptionProject, 'media'>) {
  return project.media.mimeType.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(project.media.originalName);
}

/** The renderer, preview clock and tests use the same ASS centisecond boundary. */
export function captionRenderTime(ms: number) {
  return Math.max(0, Math.round(ms / 10) * 10);
}

export interface CaptionPreviewFrame {
  atMs: number;
  png: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** Editor-only bounds of selected cues inside an overlapping caption block. */
  focusBounds?: CaptionPreviewFrame['bounds'];
}

export interface CaptionPreviewResult {
  width: number;
  height: number;
  frames: CaptionPreviewFrame[];
}
