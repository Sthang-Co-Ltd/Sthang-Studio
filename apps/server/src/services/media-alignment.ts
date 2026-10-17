import type { CaptionProject } from '@kcs/shared';

export class MediaAlignmentUnverifiedError extends Error {
  constructor() {
    super('The audio changed and your existing caption and word times were kept. Automatic timing cleanup and regrouping are unavailable because the saved transcript belongs to the previous audio. Edit timing manually, or review an explicit word sync or regeneration preview.');
    this.name = 'MediaAlignmentUnverifiedError';
  }
}

/** Old transcript anchors remain exportable, but must not silently re-time cues. */
export function assertRetainedTimingCanBeDerived(project: CaptionProject) {
  if (project.mediaAlignment?.state === 'unverified-audio-change') {
    throw new MediaAlignmentUnverifiedError();
  }
}
