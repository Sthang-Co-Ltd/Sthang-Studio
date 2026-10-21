import type { CaptionSegment, VideoResolutionPreset } from './index.js';
import type { CaptionAppearance } from './caption-settings.js';

export interface CaptionLayoutCheckInput {
  captions: CaptionSegment[];
  appearance: CaptionAppearance;
  resolution: VideoResolutionPreset;
  expectedMedia: { filename: string; size: number };
}

export interface CaptionLayoutCheckResult {
  status: 'passed' | 'blocked' | 'unavailable';
  issues: Array<{ code: string; captionIds: string[]; message: string }>;
  width: number;
  height: number;
}
