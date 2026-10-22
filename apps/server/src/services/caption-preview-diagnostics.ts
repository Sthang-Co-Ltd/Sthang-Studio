import type { CaptionPreviewResult } from '@kcs/shared';

/** Raw local evidence is opt-in through trusted in-process callers only. Never
 * populate this option from an HTTP request or enable it for user projects. */
export interface CaptionPreviewProcessDiagnostic {
  executable: string;
  args: string[];
  startedAt: string;
  closedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  stderr: string;
  parserStderr?: string;
  startErrorCode?: string;
}

export interface CaptionPreviewDiagnosticSnapshot {
  startedAt: string;
  finishedAt: string;
  completed: boolean;
  input: unknown;
  dimensions?: { width: number; height: number };
  workDirectory?: string;
  fontDirectory?: string;
  process?: CaptionPreviewProcessDiagnostic;
  parsedBboxes?: string[][];
  frames?: Array<Omit<CaptionPreviewResult['frames'][number], 'png'>>;
}

export interface CaptionPreviewDiagnostics {
  capture(snapshot: CaptionPreviewDiagnosticSnapshot): void | Promise<void>;
  captureFailed?(): void;
}

/** Evidence failure must not replace a renderer result, cancellation, or error. */
export async function captureCaptionPreviewDiagnostics(options: CaptionPreviewDiagnostics, snapshot: CaptionPreviewDiagnosticSnapshot) {
  try { await options.capture(snapshot); }
  catch {
    try { options.captureFailed?.(); } catch { /* Preserve the original outcome. */ }
  }
}
