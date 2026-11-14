import type { CaptionFileFormat, CaptionLayoutCheckResult, VideoExportSettings } from '@kcs/shared';

export type CaptionDestinationId = 'capcut-desktop' | 'capcut-mobile' | 'premiere' | 'resolve' | 'final-cut' | 'web-other' | 'subtitle-tools';

export interface CaptionHandoffSession {
  destination: CaptionDestinationId;
  advancedFormat: Exclude<CaptionFileFormat, 'srt'> | null;
  advancedOpen: boolean;
}

/** Current export visit, combining remembered output choices with ephemeral diagnostic evidence. */
export interface ExportWorkspaceSession {
  outputMode: 'video' | 'captions';
  settings: VideoExportSettings;
  /** Stops an older profile response replacing settings edited during this visit or export repair. */
  settingsHydrated: boolean;
  /** Empty means customized; a saved preset selection is only a label for the loaded values. */
  selectedPresetId: string;
  /** Stored preset selected for management. Independent of compatible output settings. */
  managedPresetId: string;
  advancedOpen: boolean;
  handoff: CaptionHandoffSession;
  /** Visit-only diagnostic evidence. Never included in remembered output choices. */
  layoutCheck?: { key: string; result?: CaptionLayoutCheckResult; error?: string } | null;
  /** Keeps an explicit support recheck invalidating old diagnostics through tool changes. */
  layoutCapabilityRevision?: number;
}

export function createExportWorkspaceSession(videoProject: boolean): ExportWorkspaceSession {
  return {
    outputMode: videoProject ? 'video' : 'captions',
    settings: { resolution: 'source', frameRate: 'source', quality: 'recommended', codec: 'h264', encoder: 'auto' },
    settingsHydrated: false,
    selectedPresetId: '',
    managedPresetId: '',
    advancedOpen: false,
    handoff: { destination: 'capcut-desktop', advancedFormat: null, advancedOpen: false },
  };
}
