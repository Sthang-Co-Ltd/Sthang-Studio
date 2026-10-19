import { reconcileCaptionWordTiming, type CaptionProject, type CaptionSegment } from '@kcs/shared';
import type { AccuracyFields } from './accuracy-context-draft';
import { projectMediaKey } from './project-scope';

/** Limits count UTF-16 storage bytes, including the key. No source media is copied. */
export const UNFINISHED_EDIT_RECOVERY_LIMITS = Object.freeze({
  maxEntryBytes: 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024,
  maxEntries: 10,
  maxProjectEntries: 5,
  maxCaptions: 10_000,
  maxFieldChars: 128 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  futureClockAllowanceMs: 5 * 60 * 1000,
});

export const UNFINISHED_EDIT_RECOVERY_PREFIX = 'sthang-studio:unfinished-edits:v1:';
type RecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
type RecoveryCaption = Pick<CaptionSegment, 'id' | 'text' | 'startMs' | 'endMs'> & {
  textLocked: boolean;
  timingLocked: boolean;
};

export interface RecoveryDraft {
  version: 1;
  ownerId: string;
  projectId: string;
  mediaKey: string;
  snapshotId: string;
  savedAt: number;
  /** Opaque equality tokens, never parsed into recovered caption evidence. */
  basis: { captions: string; context: string };
  captions?: RecoveryCaption[];
  accuracy?: AccuracyFields;
}

export interface RecoveryEntry { key: string; raw: string; draft: RecoveryDraft }
export interface RecoveryWriteInput { project: CaptionProject; captions?: CaptionSegment[]; accuracy?: AccuracyFields }
export interface RecoveryWriteResult {
  status: 'saved' | 'cleared' | 'unavailable' | 'too-large';
  entry?: RecoveryEntry;
}

const limits = UNFINISHED_EDIT_RECOVERY_LIMITS;
const bytes = (key: string, raw: string) => 2 * (key.length + raw.length);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const textWithin = (value: unknown, max: number, allowEmpty = true): value is string => typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
const identity = (value: unknown): value is string => textWithin(value, 512, false) && !/[\u0000-\u001f\u007f]/u.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function keyFor(draft: Pick<RecoveryDraft, 'ownerId' | 'projectId' | 'mediaKey' | 'snapshotId'>) {
  return UNFINISHED_EDIT_RECOVERY_PREFIX + [draft.ownerId, draft.projectId, draft.mediaKey, draft.snapshotId].map(encodeURIComponent).join(':');
}

function validMediaKey(value: unknown, projectId: string): value is string {
  if (!textWithin(value, 16_384, false)) return false;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 5 && parts[0] === projectId
      && textWithin(parts[1], 2048, false) && time(parts[2])
      && textWithin(parts[3], 8192, false) && textWithin(parts[4], 256, false)
      && JSON.stringify(parts) === value;
  } catch { return false; }
}

function validCaptions(value: unknown): value is RecoveryCaption[] {
  if (!Array.isArray(value) || value.length > limits.maxCaptions) return false;
  const ids = new Set<string>();
  return value.every((caption: unknown) => {
    if (!isRecord(caption) || !hasOnly(caption, ['id', 'text', 'startMs', 'endMs', 'textLocked', 'timingLocked'])
      || !identity(caption.id) || ids.has(caption.id) || !textWithin(caption.text, limits.maxFieldChars)
      || !time(caption.startMs) || !time(caption.endMs) || caption.endMs <= caption.startMs
      || typeof caption.textLocked !== 'boolean' || typeof caption.timingLocked !== 'boolean') return false;
    ids.add(caption.id);
    return true;
  });
}

function validAccuracy(value: unknown): value is AccuracyFields {
  return isRecord(value) && hasOnly(value, ['description', 'vocabulary'])
    && textWithin(value.description, limits.maxFieldChars) && textWithin(value.vocabulary, limits.maxFieldChars);
}

function parseEntry(key: string, raw: string, now: number, checkAge = true): RecoveryEntry | undefined {
  if (!key.startsWith(UNFINISHED_EDIT_RECOVERY_PREFIX) || bytes(key, raw) > limits.maxEntryBytes) return undefined;
  try {
    const draft: unknown = JSON.parse(raw);
    if (!isRecord(draft) || !hasOnly(draft, ['version', 'ownerId', 'projectId', 'mediaKey', 'snapshotId', 'savedAt', 'basis', 'captions', 'accuracy'])
      || draft.version !== 1 || !identity(draft.ownerId) || !identity(draft.projectId) || !identity(draft.snapshotId)
      || !validMediaKey(draft.mediaKey, draft.projectId) || !time(draft.savedAt) || !Number.isInteger(draft.savedAt)
      || !isRecord(draft.basis) || !hasOnly(draft.basis, ['captions', 'context'])
      || !textWithin(draft.basis.captions, limits.maxEntryBytes / 2, false)
      || !textWithin(draft.basis.context, limits.maxEntryBytes / 2, false)
      || (draft.captions !== undefined && !validCaptions(draft.captions))
      || (draft.accuracy !== undefined && !validAccuracy(draft.accuracy))
      || (draft.captions === undefined && draft.accuracy === undefined)) return undefined;
    if (checkAge && (draft.savedAt < now - limits.ttlMs || draft.savedAt > now + limits.futureClockAllowanceMs)) return undefined;
    const validated = draft as unknown as RecoveryDraft;
    return key === keyFor(validated) ? { key, raw, draft: validated } : undefined;
  } catch { return undefined; }
}

function editableCaption(caption: CaptionSegment): RecoveryCaption {
  return { id: caption.id, text: caption.text, startMs: caption.startMs, endMs: caption.endMs,
    textLocked: Boolean(caption.textLocked), timingLocked: Boolean(caption.timingLocked) };
}

/** Excludes unrelated appearance/title timestamps; includes saved trust and timing evidence. */
function captionsBasis(project: CaptionProject) {
  return JSON.stringify([Boolean(project.transcriptNeedsSync), project.mediaAlignment || null, project.captions.map((caption) => [
    caption.id, caption.text, caption.startMs, caption.endMs, Boolean(caption.approved), Boolean(caption.textLocked), Boolean(caption.timingLocked),
    caption.confidence ?? null, caption.timingQuality ?? null, caption.timingSource ?? null,
    caption.wordTiming ? [caption.wordTiming.version, caption.wordTiming.text, caption.wordTiming.words.map((word) => [
      word.id, word.startOffset, word.endOffset, word.startMs, word.endMs, word.source, Boolean(word.needsReview),
    ])] : null,
  ])]);
}

function contextBasis(project: CaptionProject) {
  return JSON.stringify([project.transcriptionContext?.description || '', project.transcriptionContext?.vocabulary || []]);
}

export function assessRecovery(entry: RecoveryEntry, canonical: CaptionProject): 'matching' | 'changed' | 'media-changed' {
  const validated = parseEntry(entry.key, entry.raw, Date.now());
  if (!validated) return 'changed';
  if (validated.draft.projectId !== canonical.id || validated.draft.mediaKey !== projectMediaKey(canonical)) return 'media-changed';
  try {
    return validated.draft.basis.captions === captionsBasis(canonical) && validated.draft.basis.context === contextBasis(canonical)
      ? 'matching' : 'changed';
  } catch { return 'changed'; }
}

/** The caller explicitly chooses Restore after a fresh canonical read. This helper performs no writes.
 * Persisted approval/confidence/word tracks are not accepted. Only fresh saved timing may be reconciled. */
export function restoredCaptions(entry: RecoveryEntry, canonical: CaptionProject): CaptionSegment[] | undefined {
  if (assessRecovery(entry, canonical) !== 'matching') return undefined;
  const recovered = parseEntry(entry.key, entry.raw, Date.now())?.draft.captions;
  if (!recovered) return undefined;
  const current = new Map(canonical.captions.map((caption) => [caption.id, caption]));
  return recovered.map((caption) => {
    const before = current.get(caption.id);
    if (before && JSON.stringify(editableCaption(before)) === JSON.stringify(caption)) return { ...before };
    const sameContent = before && before.text === caption.text && before.startMs === caption.startMs && before.endMs === caption.endMs;
    const after: CaptionSegment = { ...(sameContent ? before : {}), ...caption, approved: false };
    return before ? reconcileCaptionWordTiming(before, after) : after;
  });
}

/** Per-page writers use immutable snapshot keys. A late acknowledgement or another tab's discard
 * can therefore never delete a newer snapshot at the same key. Storage is optional and fail-open. */
export function createUnfinishedEditRecoveryStore(storageGetter: () => RecoveryStorage | null, ownerId: string, now: () => number = Date.now) {
  const owned = new Map<string, RecoveryEntry>();
  let sequence = 0;
  const ownKey = (projectId: string, mediaKey: string) => JSON.stringify([projectId, mediaKey]);
  const storage = () => { try { return storageGetter(); } catch { return null; } };

  function removeExact(target: RecoveryStorage, entry: RecoveryEntry) {
    try {
      if (!parseEntry(entry.key, entry.raw, now(), false)) return false;
      const current = target.getItem(entry.key);
      if (current === null) return true;
      if (current !== entry.raw) return false;
      target.removeItem(entry.key);
      return target.getItem(entry.key) === null;
    } catch { return false; }
  }

  function scan(target: RecoveryStorage, cleanupExpired: boolean) {
    const found: Array<{ key: string; raw: string; entry?: RecoveryEntry }> = [];
    const count = target.length;
    if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error('Storage inventory is unavailable.');
    const keys = Array.from({ length: count }, (_, index) => target.key(index)).filter((key): key is string => Boolean(key?.startsWith(UNFINISHED_EDIT_RECOVERY_PREFIX)));
    const timestamp = now();
    for (const key of keys) {
      const raw = target.getItem(key);
      if (raw === null) continue;
      const entry = parseEntry(key, raw, timestamp);
      if (!entry && cleanupExpired) {
        const expired = parseEntry(key, raw, timestamp, false);
        if (expired && expired.draft.savedAt < timestamp - limits.ttlMs && removeExact(target, expired)) continue;
      }
      found.push({ key, raw, entry });
    }
    return found;
  }

  function clearOwn(projectId: string, mediaKey: string): boolean {
    const key = ownKey(projectId, mediaKey);
    const entry = owned.get(key);
    if (!entry) return true;
    const target = storage();
    if (!target || !removeExact(target, entry)) return false;
    owned.delete(key);
    return true;
  }

  return {
    write(input: RecoveryWriteInput): RecoveryWriteResult {
      const target = storage();
      if (!target || !identity(ownerId)) return { status: 'unavailable' };
      try {
        const mediaKey = projectMediaKey(input.project);
        const ownerKey = ownKey(input.project.id, mediaKey);
        const captions = input.captions?.map(editableCaption);
        const changedCaptions = captions !== undefined && JSON.stringify(captions) !== JSON.stringify(input.project.captions.map(editableCaption)) ? captions : undefined;
        if (changedCaptions === undefined && input.accuracy === undefined) {
          return { status: clearOwn(input.project.id, mediaKey) ? 'cleared' : 'unavailable' };
        }
        const draft: RecoveryDraft = {
          version: 1, ownerId, projectId: input.project.id, mediaKey,
          snapshotId: `${now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`,
          savedAt: now(), basis: { captions: captionsBasis(input.project), context: contextBasis(input.project) },
          ...(changedCaptions !== undefined ? { captions: changedCaptions } : {}),
          ...(input.accuracy !== undefined ? { accuracy: { description: input.accuracy.description, vocabulary: input.accuracy.vocabulary } } : {}),
        };
        const key = keyFor(draft);
        const raw = JSON.stringify(draft);
        if (bytes(key, raw) > limits.maxEntryBytes || (changedCaptions && !validCaptions(changedCaptions))
          || (draft.accuracy && !validAccuracy(draft.accuracy))) return { status: 'too-large' };
        const entry = parseEntry(key, raw, now());
        if (!entry) return { status: 'unavailable' };
        const previous = owned.get(ownerKey);
        const retained = scan(target, true).filter((item) => !previous || item.key !== previous.key || item.raw !== previous.raw);
        // Fresh copies in other tabs are never evicted to make room. Aggregate limits are
        // admission checks; each immutable entry remains bounded across concurrent writers.
        if (retained.length >= limits.maxEntries
          || retained.filter((item) => item.entry?.draft.projectId === input.project.id).length >= limits.maxProjectEntries
          || retained.reduce((sum, item) => sum + bytes(item.key, item.raw), bytes(key, raw)) > limits.maxTotalBytes) return { status: 'too-large' };
        target.setItem(key, raw);
        if (target.getItem(key) !== raw) return { status: 'unavailable' };
        owned.set(ownerKey, entry);
        if (previous) removeExact(target, previous);
        return { status: 'saved', entry };
      } catch { return { status: 'unavailable' }; }
    },
    list(projectId: string): RecoveryEntry[] {
      const target = storage();
      if (!target) return [];
      try {
        return scan(target, true).flatMap(({ entry }) => entry && entry.draft.projectId === projectId ? [entry] : [])
          .sort((left, right) => right.draft.savedAt - left.draft.savedAt || right.key.localeCompare(left.key))
          .slice(0, limits.maxProjectEntries);
      } catch { return []; }
    },
    remove(entry: RecoveryEntry): boolean {
      const target = storage();
      return target ? removeExact(target, entry) : false;
    },
    clearOwn,
  };
}
