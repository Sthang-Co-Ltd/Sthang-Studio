import type { CaptionDataDocument, CaptionProject } from '@kcs/shared';

export type CaptionFileFormat = 'srt' | 'word-srt' | 'vtt' | 'word-vtt' | 'ttml' | 'ass' | 'data' | 'bundle';
export type HandoffSnapshot = CaptionDataDocument;
export interface HandoffSummary {
  revision: string;
  snapshot: HandoffSnapshot;
  captionCount: number;
  media: Pick<CaptionProject['media'], 'filename' | 'size'>;
}
export interface HandoffPrecondition {
  expectedMedia: Pick<CaptionProject['media'], 'filename' | 'size'>;
  expectedRevision: string;
}
export interface HandoffRestorePreview {
  revision: string;
  candidate: HandoffSnapshot;
  candidateDigest: string;
  warnings: string[];
}

async function checkedResponse(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `Caption transfer failed (${response.status}).`);
  }
  return response;
}

function post(value: unknown, signal?: AbortSignal): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal };
}

const endpoint = (projectId: string) => `/api/caption-handoff/${encodeURIComponent(projectId)}`;

export const captionHandoffApi = {
  summary: async (projectId: string, signal?: AbortSignal): Promise<HandoffSummary> => {
    const response = await checkedResponse(`${endpoint(projectId)}/summary`, { signal, cache: 'no-store' });
    return response.json();
  },
  export: async (projectId: string, format: CaptionFileFormat, basis: HandoffPrecondition, signal?: AbortSignal) => {
    const response = await checkedResponse(`${endpoint(projectId)}/export`, post({ format, ...basis }, signal));
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > 17 * 1024 * 1024) throw new Error('The caption handoff file exceeded its supported size.');
    const disposition = response.headers.get('content-disposition') || '';
    const proposed = /filename="([^"\r\n]+)"/i.exec(disposition)?.[1];
    // Download names never interpret remote paths, control characters, or HTML.
    const extension = format === 'bundle' ? 'zip' : format === 'data' ? 'json' : format.replace('word-', '');
    const filename = proposed && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(proposed) ? proposed : `captions.${extension}`;
    const blob = await response.blob();
    if (!blob.size) throw new Error('The caption file was empty. Retry the export.');
    if (blob.size > 17 * 1024 * 1024) throw new Error('The caption handoff file exceeded its supported size.');
    const warnings = (response.headers.get('x-sthang-handoff-warnings') || '').slice(0, 2048);
    return { blob, filename, warnings };
  },
  previewRestore: async (projectId: string, data: string, basis: HandoffPrecondition, signal?: AbortSignal): Promise<HandoffRestorePreview> => {
    const response = await checkedResponse(`${endpoint(projectId)}/restore-preview`, post({ data, ...basis }, signal));
    return response.json();
  },
  restore: async (projectId: string, data: string, basis: HandoffPrecondition, expectedCandidateDigest: string): Promise<CaptionProject> => {
    const response = await checkedResponse(`${endpoint(projectId)}/restore`, post({ data, ...basis, expectedCandidateDigest, confirmed: true }));
    return response.json();
  },
};

/** Called only after the owning editor session and snapshot are checked again. */
export function saveHandoffDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Browsers may start reading the object URL after the click handler returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
