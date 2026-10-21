import type { CaptionFileFormat, VideoExportSettings } from '@kcs/shared';

export type CaptionDestinationId = 'capcut-desktop' | 'capcut-mobile' | 'premiere' | 'resolve' | 'final-cut' | 'web-other' | 'subtitle-tools';

export interface CaptionHandoffSession {
  destination: CaptionDestinationId;
  advancedFormat: Exclude<CaptionFileFormat, 'srt'> | null;
  advancedOpen: boolean;
}

/** Kept only while repairing this project's export in the current editor visit. */
export interface ExportWorkspaceSession {
  outputMode: 'video' | 'captions';
  settings: VideoExportSettings;
  advancedOpen: boolean;
  handoff: CaptionHandoffSession;
}

export function createExportWorkspaceSession(videoProject: boolean): ExportWorkspaceSession {
  return {
    outputMode: videoProject ? 'video' : 'captions',
    settings: { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' },
    advancedOpen: false,
    handoff: { destination: 'capcut-desktop', advancedFormat: null, advancedOpen: false },
  };
}
