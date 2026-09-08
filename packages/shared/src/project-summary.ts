import type { CaptionProject } from './index.js';

/** Home needs metadata, not a second copy of every transcript and caption. */
export interface CaptionProjectSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  captionCount: number;
}

export function summarizeProject(project: CaptionProject): CaptionProjectSummary {
  return {
    id: project.id,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    captionCount: project.captions.length,
  };
}
