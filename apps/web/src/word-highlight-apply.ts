import { compileHighlightPlan, highlightAttention, type CaptionProject, type CaptionSegment, type Coverage } from '@kcs/shared';
import { ApiRequestError, WordHighlightPublicationError, type WordHighlightAppliedChange, type WordHighlightReceipt } from './api';

export type WordHighlightIntent = 'apply' | 'follow';
export type WordHighlightDisposition = 'candidate' | 'reused' | 'locked' | 'outside-media' | 'budget' | 'error' | 'stale' | 'non-speech';
export interface WordHighlightCandidateResult {
  id: string;
  status: Exclude<WordHighlightDisposition, 'non-speech'>;
  preparedKey?: string;
  consulted?: string[];
}

export type WordHighlightPause = 'busy' | 'connection' | 'unavailable' | 'project-changed' | 'edits';
export interface WordHighlightProgress {
  status: 'idle' | 'arming' | 'preparing-audio' | 'checking' | 'waiting-for-save' | 'publishing' | 'complete' | 'paused';
  completed: number;
  total: number;
  pauseReason?: WordHighlightPause;
}

export const EMPTY_HIGHLIGHT_PROGRESS: WordHighlightProgress = { status: 'idle', completed: 0, total: 0 };

const chronological = (captions: CaptionSegment[]) => [...captions].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
const planFor = (caption: CaptionSegment) => compileHighlightPlan(caption, 'measured-and-manual');
const hasSpokenText = (caption: CaptionSegment) => /[^\s\p{Z}\p{Cf}\p{P}\p{S}]/u.test(caption.text);

export function classifyHighlightTargets(captions: CaptionSegment[], ids?: string[], attempted?: ReadonlySet<string>) {
  const dispositions = new Map<string, WordHighlightDisposition>();
  const selected = ids && new Set(ids);
  const targets: string[] = [];
  for (const caption of chronological(captions)) {
    if (selected && !selected.delete(caption.id)) continue;
    if (!hasSpokenText(caption)) dispositions.set(caption.id, 'non-speech');
    else if (caption.timingLocked) dispositions.set(caption.id, 'locked');
    else if (!ids && (attempted?.has(caption.id) || highlightAttention(caption) !== 'needs-attention')) dispositions.set(caption.id, 'reused');
    else targets.push(caption.id);
  }
  for (const id of selected ?? []) dispositions.set(id, 'stale');
  return { targets, dispositions };
}

const sameCue = (a: CaptionSegment, b: CaptionSegment) => a.text === b.text
  && a.startMs === b.startMs && a.endMs === b.endMs && Boolean(a.timingLocked) === Boolean(b.timingLocked);
const overlaps = (a: CaptionSegment, b: CaptionSegment) => a.startMs < b.endMs && b.startMs < a.endMs;

export function affectedHighlightIds(before: CaptionSegment[], after: CaptionSegment[]) {
  const oldOrder = chronological(before.filter(hasSpokenText));
  const newOrder = chronological(after.filter(hasSpokenText));
  const oldIndex = new Map(oldOrder.map((caption, index) => [caption.id, index]));
  const newIndex = new Map(newOrder.map((caption, index) => [caption.id, index]));
  const affected = new Set<string>();
  function addNeighbors(order: CaptionSegment[], index: number | undefined) {
    if (index === undefined) return;
    for (const caption of [order[index - 1], order[index + 1]]) if (caption) affected.add(caption.id);
  }

  for (const id of new Set([...oldIndex.keys(), ...newIndex.keys()])) {
    const priorIndex = oldIndex.get(id);
    const nextIndex = newIndex.get(id);
    const old = priorIndex === undefined ? undefined : oldOrder[priorIndex];
    const next = nextIndex === undefined ? undefined : newOrder[nextIndex];
    if (old && next && sameCue(old, next)) continue;
    if (next) affected.add(id);
    addNeighbors(oldOrder, priorIndex);
    addNeighbors(newOrder, nextIndex);
    // Both newly overlapping cues and former overlaps can change the guard.
    for (const peer of newOrder) {
      if ((old && overlaps(old, peer)) || (next && overlaps(next, peer))) affected.add(peer.id);
    }
  }
  return newOrder.filter(({ id }) => affected.has(id)).map(({ id }) => id);
}

const issueSeverity = ['text-mismatch', 'no-fit', 'discontinuous', 'outside-cue', 'missing', 'grid-collapse', 'edited'];
const urgentIssues = new Set(['ambiguous-occurrence', 'manual-conflict', 'stale']);

export function wordHighlightCoverage(captions: CaptionSegment[]) {
  const counts: Record<Coverage, number> = { 'full-individual': 0, 'full-with-groups': 0, partial: 0, none: 0 };
  const exceptions = captions.flatMap((caption) => {
    if (!hasSpokenText(caption)) return [];
    const plan = planFor(caption);
    counts[plan.coverage]++;
    if (plan.coverage === 'full-individual' || plan.coverage === 'full-with-groups') return [];
    const urgent = plan.issues.find(({ code }) => urgentIssues.has(code));
    const rank = caption.timingLocked ? 4 : urgent ? 1 : plan.coverage === 'none' ? 2 : 3;
    const missing = plan.spokenUnits ? 1 - plan.paintedUnits / plan.spokenUnits : 1;
    const severity = (code: string) => {
      const index = issueSeverity.indexOf(code);
      return index < 0 ? issueSeverity.length : index;
    };
    const issue = urgent ?? [...plan.issues].sort((a, b) => severity(a.code) - severity(b.code))[0];
    const offsets = issue?.offsets;
    const wordId = offsets && caption.wordTiming?.text === caption.text
      ? caption.wordTiming.words.find((word) => word.startOffset < offsets[1] && offsets[0] < word.endOffset)?.id : undefined;

    return [{ id: caption.id, startMs: caption.startMs, endMs: caption.endMs, rank, missing,
      severity: severity(issue?.code ?? ''), wordId, locked: Boolean(caption.timingLocked) }];
  }).sort((a, b) => a.rank - b.rank || (a.rank === 3 ? b.missing - a.missing || a.severity - b.severity : 0)
    || a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1));
  return { counts, exceptions };
}

export async function highlightMediaFingerprint({ media }: Pick<CaptionProject, 'media'>) {
  const bytes = new TextEncoder().encode(`${media.filename}:${media.size}:${media.originalName}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes), 0, 12);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Publication {
  project: CaptionProject;
  applied: WordHighlightAppliedChange[];
}

interface PassOptions {
  intent: WordHighlightIntent;
  signal: AbortSignal;
  ids?: string[];
  attempted?: ReadonlySet<string>;
  waitForClean(revision?: string): Promise<CaptionProject>;
  waitForJob(): Promise<boolean>;
  arm(): Promise<string | null>;
  prepare(signal: AbortSignal): Promise<{ mediaFingerprint: string }>;
  candidates(ids: string[], signal: AbortSignal): Promise<{ results: WordHighlightCandidateResult[] }>;
  inPublicationLane(operation: (adopt: (result: Publication) => void) => Promise<void>): Promise<boolean>;
  publish(epoch: string, keys: string[], requestId: string): Promise<Publication>;
  readReceipt(requestId: string): Promise<WordHighlightReceipt>;
  readProject(): Promise<CaptionProject>;
  onProgress(progress: WordHighlightProgress): void;
  onHistoryRecovery(): void;
  onUnconfirmedPublication(): void;
  newRequestId(): string;
  delay(ms: number): Promise<void>;
}

function classifyPause(error: unknown): WordHighlightPause {
  if (error instanceof ApiRequestError) {
    if (error.code === 'WORD_TIMING_PROJECT_BUSY') return 'busy';
    if ([404, 409, 428].includes(error.status)) return 'project-changed';
    return 'unavailable';
  }
  return 'connection';
}

function isUnknownPublication(error: unknown) {
  return !(error instanceof ApiRequestError) || error.status >= 500;
}

class UnconfirmedPublication extends Error {}

/** Recovery remains inside the mutation lane after Cancel. The server receipt
 * can contain a different track than the one originally prepared. */
async function publishWithReceipt(options: PassOptions, epoch: string, keys: string[]) {
  const requestId = options.newRequestId();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (options.signal.aborted) return;
    try {
      return await options.publish(epoch, keys, requestId);
    } catch (error) {
      if (!isUnknownPublication(error)) throw error;
      let knownAbsent = false;
      for (const delay of [0, 150, 450]) {
        if (delay) await options.delay(delay);
        try {
          const receipt = await options.readReceipt(requestId);
          if (!receipt.committed) { knownAbsent = true; continue; }
          if (!('applied' in receipt)) {
            options.onHistoryRecovery();
            return { project: await options.readProject(), applied: [] };
          }
          if (receipt.intent !== options.intent) break;
          return { project: await options.readProject(), applied: receipt.applied };
        } catch {
          knownAbsent = false;
        }
      }
      if (knownAbsent && options.signal.aborted) return;
      if (!knownAbsent || attempt === 1) {
        options.onUnconfirmedPublication();
        throw new UnconfirmedPublication();
      }
    }
  }
}

export async function runWordHighlightPass(options: PassOptions) {
  const { intent, signal } = options;
  let targets: string[] = [];
  let dispositions = new Map<string, WordHighlightDisposition>();
  const candidates = new Map<string, WordHighlightCandidateResult>();
  let busyRetry = false;
  const progress = (status: WordHighlightProgress['status'], pauseReason?: WordHighlightPause) => options.onProgress({
    status, total: targets.length, completed: targets.filter((id) => dispositions.has(id)).length, pauseReason,
  });
  const clean = async (afterRevision?: string) => {
    const project = await options.waitForClean(afterRevision);
    signal.throwIfAborted();
    return project;
  };
  const retryWhenFree = async <T,>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      if (classifyPause(error) !== 'busy' || busyRetry) throw error;
      busyRetry = true;
      progress('paused', 'busy');
      if (!await options.waitForJob()) throw error;
      signal.throwIfAborted();
      return run();
    }
  };
  const check = async (ids: string[]) => {
    for (let index = 0; index < ids.length; index += 32) {
      signal.throwIfAborted();
      progress('checking');
      const chunk = ids.slice(index, index + 32);
      const { results } = await retryWhenFree(() => options.candidates(chunk, signal));
      signal.throwIfAborted();
      const byId = new Map(results.map((result) => [result.id, result]));
      for (const id of chunk) {
        const result = byId.get(id);
        candidates.delete(id);
        if (result?.status === 'candidate' && result.preparedKey) candidates.set(id, result);
        dispositions.set(id, result?.status === 'candidate' && !result.preparedKey ? 'error' : result?.status ?? 'error');
      }
      progress('checking');
    }
  };

  try {
    let saved = await clean();
    const fingerprint = await highlightMediaFingerprint(saved);
    let epoch = saved.wordHighlightFollow?.epoch;
    if (intent === 'apply') {
      progress('arming');
      while (!signal.aborted) {
        const armed = await options.arm();
        if (armed) { epoch = armed; break; }
        saved = await clean();
      }
      saved = await clean();
    } else if (!saved.wordHighlightFollow?.enabled || saved.wordHighlightFollow.mediaFingerprint !== fingerprint) return;
    if (!epoch) return;

    ({ targets, dispositions } = classifyHighlightTargets(saved.captions, options.ids, options.attempted));
    if (targets.length) {
      await retryWhenFree(async () => {
        progress('preparing-audio');
        const prepared = await options.prepare(signal);
        if (prepared.mediaFingerprint !== fingerprint) throw new ApiRequestError('Source media changed.', 409);
      });
      await check(targets);
    }

    let refreshedExpired = false;
    let conflictRevision: string | undefined;
    let contextRetries = 0;
    while (candidates.size) {
      const revision = (await clean()).updatedAt;
      if (revision !== conflictRevision) { conflictRevision = revision; contextRetries = 0; }
      const keys = [...candidates.values()].map(({ preparedKey }) => preparedKey!);
      try {
        const entered = await retryWhenFree(() => options.inPublicationLane(async (adopt) => {
          progress('publishing');
          const response = await publishWithReceipt(options, epoch, keys);
          if (response) adopt(response);
        }));
        if (entered) break;
      } catch (error) {
        if (!(error instanceof WordHighlightPublicationError)) throw error;
        if (error.code === 'WORD_HIGHLIGHT_INTENT_CHANGED') return;
        if (error.code === 'WORD_HIGHLIGHT_PREPARED_EXPIRED' && !refreshedExpired) {
          refreshedExpired = true;
          const expired = new Set(error.expiredKeys);
          const ids = [...candidates.values()].filter(({ preparedKey }) => expired.has(preparedKey!)).map(({ id }) => id);
          if (!ids.length) throw error;
          await check(ids);
        } else if (error.code === 'WORD_HIGHLIGHT_CONTEXT_CHANGED') {
          const changed = new Set(error.changedIds);
          const ids = [...candidates.values()]
            .filter(({ id, consulted }) => changed.has(id) || consulted?.some((peer) => changed.has(peer))).map(({ id }) => id);
          if (!ids.length) throw error;
          if (contextRetries++ >= 3) await clean(revision);
          else await clean();
          await check(ids);
        } else throw error;
      }
    }
    signal.throwIfAborted();
    progress('complete');
    return { dispositions, captions: saved.captions };
  } catch (error) {
    if (signal.aborted || (error instanceof ApiRequestError && error.code === 'WORD_HIGHLIGHT_INTENT_CHANGED')) return;
    progress('paused', error instanceof UnconfirmedPublication ? 'connection' : classifyPause(error));
  }
}
