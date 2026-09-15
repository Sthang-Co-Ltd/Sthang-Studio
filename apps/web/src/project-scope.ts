import type { CaptionProject, RegenerationProposal } from '@kcs/shared';

type MediaProject = Pick<CaptionProject, 'id' | 'media'>;
export interface ProjectTicket { readonly key: string }

/** Media identity, not updatedAt: caption saves must never reload the video. */
export function projectMediaKey(project: MediaProject | null): string {
  return project ? JSON.stringify([project.id, project.media.filename, project.media.size, project.media.url, project.media.mimeType]) : '';
}

/** An epoch also rejects A → Home → A responses, even with identical media. */
export function createProjectScope() {
  let current: ProjectTicket = Object.freeze({ key: '' });
  return {
    capture: () => current,
    isCurrent: (ticket: ProjectTicket) => ticket === current,
    invalidate() { current = Object.freeze({ key: current.key }); },
    select(project: MediaProject | null) {
      const key = projectMediaKey(project);
      if (key !== current.key) current = Object.freeze({ key });
    },
  };
}

export function proposalForProject(
  entry: { ticket: ProjectTicket; value: RegenerationProposal } | null,
  ticket: ProjectTicket,
  project: MediaProject | null,
): RegenerationProposal | null {
  return entry && entry.ticket === ticket && project
    && entry.value.projectId === project.id && ticket.key === projectMediaKey(project)
    ? entry.value : null;
}

/** Compare wording, not grouping spaces. Never silently rebuild corrected text. */
export function groupingChangesWording(project: CaptionProject, draft: CaptionProject['captions']) {
  const normalize = (text: string) => text.normalize('NFC').replace(/\s/gu, '');
  return Boolean(project.transcriptNeedsSync) || normalize(draft.map((cue) => cue.text).join(''))
    !== normalize((project.transcript?.tokens || []).map((token) => token.text).join(''));
}
