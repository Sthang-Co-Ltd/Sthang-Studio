/** Explicitly installed by the isolated diagnostic child only. No paths or
 * project contents cross this observer. Disabled observers do not read a clock.
 */
export type ProjectLoadingPhase = 'directory-create' | 'metadata' | 'directory' | 'file-read' | 'parse' | 'shape-validation' | 'scan' | 'publication' | 'summary';
export interface ProjectLoadingEvent {
  phase: ProjectLoadingPhase;
  startedAtMs: number;
  durationMs: number;
  items?: number;
}
type Observer = (event: ProjectLoadingEvent) => void;
interface Span { phase: ProjectLoadingPhase; startedAtMs: number; observer: Observer }
let observer: Observer | undefined;

export function installProjectLoadingObserver(next: Observer): () => void {
  if (observer) throw new Error('A project loading observer is already installed.');
  observer = next;
  return () => { if (observer === next) observer = undefined; };
}

export function beginProjectLoadingPhase(phase: ProjectLoadingPhase): Span | undefined {
  return observer ? { phase, startedAtMs: performance.now(), observer } : undefined;
}

export function endProjectLoadingPhase(span: Span | undefined, items?: number): void {
  if (!span) return;
  const event: ProjectLoadingEvent = { phase: span.phase, startedAtMs: span.startedAtMs,
    durationMs: performance.now() - span.startedAtMs, ...(items === undefined ? {} : { items }) };
  // Optional instrumentation must never affect loading or recovery behavior.
  try { span.observer(event); } catch { /* Diagnostic collection is fail-open. */ }
}
