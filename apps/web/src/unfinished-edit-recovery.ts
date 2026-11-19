import { demoteRecoveredMarkedWordTiming, hasWordTimingEvidence, normalizeCaptionAppearance, reconcileCaptionWordTiming, validateMarkedWordTiming,
  type CaptionAppearance, type CaptionProject, type CaptionSegment } from '@kcs/shared';
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

export type RecoveryStatus = 'matching' | 'already-saved' | 'changed' | 'media-changed';

export interface RecoveryDraft {
  version: 1 | 2 | 3;
  ownerId: string;
  projectId: string;
  mediaKey: string;
  snapshotId: string;
  savedAt: number;
  /** Opaque equality tokens, never parsed into recovered caption evidence. */
  basis: { captions?: string; context?: string; appearance?: string };
  captions?: RecoveryCaption[];
  accuracy?: AccuracyFields;
  appearance?: CaptionAppearance;
}

export interface RecoveryEntry { key: string; raw: string; draft: RecoveryDraft }
export interface RecoveryWriteInput {
  project: CaptionProject;
  captions?: CaptionSegment[];
  accuracy?: AccuracyFields;
  /** Canonical appearance values, with their independently acknowledged saved basis. */
  appearance?: CaptionAppearance;
  appearanceBasis?: CaptionAppearance;
  /** A conflicted baseline is no longer proof that these captions are saved. */
  keepUnchangedCaptions?: boolean;
}
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
const whole = (value: unknown): value is number => time(value) && Number.isInteger(value);
const bitFlags = (value: unknown, mask: number): value is number => whole(value) && value <= mask;
/** v4 expands only bounded, validated tuples into the legacy field-scoped in-memory draft. */
const maxExpandedBasisChars = 4 * limits.maxEntryBytes;

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

/** Recovery accepts only the complete normalized visual settings, never extra
 * project data, credentials, unknown fields or values silently repaired on read. */
function validAppearance(value: unknown): value is CaptionAppearance {
  if (!isRecord(value)) return false;
  const normalized = normalizeCaptionAppearance(value as Partial<CaptionAppearance>);
  return Object.keys(value).length === Object.keys(normalized).length
    && Object.entries(normalized).every(([key, expected]) => Object.hasOwn(value, key) && Object.is(value[key], expected));
}

function appearanceBasis(value: CaptionProject['captionAppearance']) {
  return JSON.stringify(normalizeCaptionAppearance(value));
}

function validAppearanceBasis(value: unknown): value is string {
  if (!textWithin(value, 4096, false)) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return validAppearance(parsed) && value === appearanceBasis(parsed);
  } catch { return false; }
}

/** The v4 wire keeps saved evidence in compact tuples, without granting any of it
 * restoration authority. The only editable content remains IDs/text/edges/locks.
 * Array indices refer to the full saved cue list, never to other edited rows. */
function compactCaptionWire(draft: RecoveryDraft): Record<string, unknown> | undefined {
  if (draft.version !== 3 || !draft.basis.captions || !draft.captions) return undefined;
  try {
    const basis: unknown = JSON.parse(draft.basis.captions);
    if (!Array.isArray(basis) || basis.length !== 3 || !Array.isArray(basis[2])) return undefined;
    const cues: unknown[][] = basis[2];
    const savedCues = cues.map((cue) => {
      if (!Array.isArray(cue) || cue.length !== 11) throw new Error('Invalid saved cue.');
      const track = cue[10];
      if (track !== null && (!Array.isArray(track) || !Array.isArray(track[2])
        || (track.length !== 3 && (track.length !== 4 || track[3] !== 2)))) throw new Error('Invalid word timing.');
      const marked = Array.isArray(track) && track[3] === 2;
      const compactTrack = Array.isArray(track) ? [
        track[0], track[1], track[2].map((word: unknown) => {
          if (!Array.isArray(word) || word.length !== (marked ? 10 : 7)) throw new Error('Invalid timed word.');
          return [word[0], word[1], word[2], word[3], word[4], word[5], word[6] ? 1 : 0, ...word.slice(7)];
        }),
        ...(marked ? [2] : []),
      ] : null;
      const packed = [
        cue[0], cue[1], cue[2], cue[3],
        (cue[4] ? 1 : 0) | (cue[5] ? 2 : 0) | (cue[6] ? 4 : 0),
        cue[7], cue[8], cue[9], compactTrack,
      ];
      while (packed.length > 5 && packed[packed.length - 1] === null) packed.pop();
      return packed;
    });
    const byId = new Map<string, number>(cues.map((cue, index) => [String(cue[0]), index]));
    const edits = draft.captions.map((caption) => {
      const index = byId.get(caption.id);
      const cue = index === undefined ? undefined : cues[index];
      if (cue && caption.text === cue[1] && caption.startMs === cue[2] && caption.endMs === cue[3]
        && caption.textLocked === Boolean(cue[5]) && caption.timingLocked === Boolean(cue[6])) return index;
      return [caption.id, caption.text, caption.startMs, caption.endMs,
        (caption.textLocked ? 1 : 0) | (caption.timingLocked ? 2 : 0)];
    });
    return {
      ...draft, version: 4,
      basis: { ...draft.basis, captions: [basis[0] ? 1 : 0, basis[1], savedCues] },
      captions: edits,
    };
  } catch { return undefined; }
}

function packedMediaAlignment(value: unknown): boolean {
  return value === null || isRecord(value) && hasOnly(value, ['state', 'acceptedAt', 'sourceRevision'])
    && Object.keys(value).length === 3 && value.state === 'unverified-audio-change'
    && textWithin(value.acceptedAt, 256, false) && textWithin(value.sourceRevision, 16_384, false);
}

function expandCompactCaptions(basis: unknown, edits: unknown): { basis: string; captions: RecoveryCaption[] } | undefined {
  if (!Array.isArray(basis) || basis.length !== 3 || !bitFlags(basis[0], 1)
    || !packedMediaAlignment(basis[1]) || !Array.isArray(basis[2]) || basis[2].length > limits.maxCaptions
    || !Array.isArray(edits) || edits.length > limits.maxCaptions) return undefined;
  const ids = new Set<string>();
  let wordCount = 0;
  const saved: unknown[][] = [];
  for (const row of basis[2]) {
    if (!Array.isArray(row) || row.length < 5 || row.length > 9
      || !identity(row[0]) || ids.has(row[0]) || !textWithin(row[1], limits.maxFieldChars)
      || !time(row[2]) || !time(row[3]) || row[3] <= row[2] || !bitFlags(row[4], 7)
      || (row.length > 5 && row[row.length - 1] === null)) return undefined;
    ids.add(row[0]);
    const confidence = row[5] ?? null;
    const quality = row[6] ?? null;
    const source = row[7] ?? null;
    if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      || quality !== null && quality !== 'high' && quality !== 'medium' && quality !== 'low'
      || source !== null && source !== 'stt' && source !== 'stt-split' && source !== 'interpolated' && source !== 'manual') return undefined;
    let track: unknown = null;
    if (row.length === 9) {
      const packed = row[8];
      if (!Array.isArray(packed) || (packed.length !== 3 && (packed.length !== 4 || packed[3] !== 2)) || packed[0] !== 1
        || !textWithin(packed[1], limits.maxFieldChars) || !Array.isArray(packed[2])) return undefined;
      const marked = packed[3] === 2;
      wordCount += packed[2].length;
      if (wordCount > 100_000) return undefined;
      const wordIds = new Set<string>();
      const words: unknown[][] = [];
      for (const word of packed[2]) {
        if (!Array.isArray(word) || word.length !== (marked ? 10 : 7) || !identity(word[0]) || wordIds.has(word[0])
          || !whole(word[1]) || !whole(word[2]) || word[2] <= word[1] || word[2] > packed[1].length
          || word[3] !== null && !time(word[3]) || word[4] !== null && !time(word[4])
          || word[3] !== null && word[4] !== null && word[4] < word[3]
          || word[5] !== 'aligned' && word[5] !== 'manual' && word[5] !== 'estimated'
          || !bitFlags(word[6], 1)) return undefined;
        wordIds.add(word[0]);
        words.push([word[0], word[1], word[2], word[3], word[4], word[5], Boolean(word[6]), ...word.slice(7)]);
      }
      if (marked && !validateMarkedWordTiming(row[1], {
        version: 1, evidence: 2, text: packed[1],
        words: words.map(([id, startOffset, endOffset, startMs, endMs, source, needsReview, method, issue, members]) => ({
          id, startOffset, endOffset, startMs, endMs, source, needsReview,
          method: method ?? undefined, issue: issue ?? undefined, members: members ?? undefined,
        })),
      }).ok) return undefined;
      track = [packed[0], packed[1], words, ...(marked ? [2] : [])];
    }
    saved.push([row[0], row[1], row[2], row[3],
      Boolean(row[4] & 1), Boolean(row[4] & 2), Boolean(row[4] & 4),
      confidence, quality, source, track]);
  }
  const seenEdits = new Set<string>();
  const captions: RecoveryCaption[] = [];
  for (const row of edits) {
    let caption: RecoveryCaption;
    if (typeof row === 'number') {
      if (!whole(row) || row >= saved.length) return undefined;
      const cue = saved[row];
      caption = {
        id: cue[0] as string, text: cue[1] as string,
        startMs: cue[2] as number, endMs: cue[3] as number,
        textLocked: cue[5] as boolean, timingLocked: cue[6] as boolean,
      };
    } else {
      if (!Array.isArray(row) || row.length !== 5 || !identity(row[0])
        || !textWithin(row[1], limits.maxFieldChars) || !time(row[2]) || !time(row[3])
        || row[3] <= row[2] || !bitFlags(row[4], 3)) return undefined;
      caption = { id: row[0], text: row[1], startMs: row[2], endMs: row[3],
        textLocked: Boolean(row[4] & 1), timingLocked: Boolean(row[4] & 2) };
    }
    if (seenEdits.has(caption.id)) return undefined;
    seenEdits.add(caption.id);
    captions.push(caption);
  }
  const expanded = JSON.stringify([Boolean(basis[0]), basis[1], saved]);
  if (expanded.length > maxExpandedBasisChars || !validCaptions(captions)) return undefined;
  return { basis: expanded, captions };
}

function parseCompactDraft(wire: Record<string, unknown>): RecoveryDraft | undefined {
  if (!hasOnly(wire, ['version', 'ownerId', 'projectId', 'mediaKey', 'snapshotId', 'savedAt', 'basis', 'captions', 'accuracy', 'appearance'])
    || wire.version !== 4 || !identity(wire.ownerId) || !identity(wire.projectId)
    || !identity(wire.snapshotId) || !validMediaKey(wire.mediaKey, wire.projectId)
    || !whole(wire.savedAt) || !isRecord(wire.basis)
    || !hasOnly(wire.basis, ['captions', 'context', 'appearance'])
    || (wire.accuracy !== undefined && !validAccuracy(wire.accuracy))
    || (wire.appearance !== undefined && !validAppearance(wire.appearance))) return undefined;
  const expanded = expandCompactCaptions(wire.basis.captions, wire.captions);
  if (!expanded
    || (wire.accuracy !== undefined ? !textWithin(wire.basis.context, limits.maxEntryBytes / 2, false) : wire.basis.context !== undefined)
    || (wire.appearance !== undefined ? !validAppearanceBasis(wire.basis.appearance) : wire.basis.appearance !== undefined)) return undefined;
  return {
    version: 3, ownerId: wire.ownerId, projectId: wire.projectId,
    mediaKey: wire.mediaKey, snapshotId: wire.snapshotId, savedAt: wire.savedAt,
    basis: { captions: expanded.basis,
      ...(wire.accuracy !== undefined ? { context: wire.basis.context as string } : {}),
      ...(wire.appearance !== undefined ? { appearance: wire.basis.appearance as string } : {}) },
    captions: expanded.captions,
    ...(wire.accuracy !== undefined ? { accuracy: wire.accuracy as unknown as AccuracyFields } : {}),
    ...(wire.appearance !== undefined ? { appearance: wire.appearance as CaptionAppearance } : {}),
  };
}

function parseEntry(key: string, raw: string, now: number, checkAge = true): RecoveryEntry | undefined {
  if (!key.startsWith(UNFINISHED_EDIT_RECOVERY_PREFIX) || bytes(key, raw) > limits.maxEntryBytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const compact = isRecord(parsed) && parsed.version === 4;
    const draft: unknown = compact ? parseCompactDraft(parsed as Record<string, unknown>) : parsed;
    if (!isRecord(draft) || !hasOnly(draft, ['version', 'ownerId', 'projectId', 'mediaKey', 'snapshotId', 'savedAt', 'basis', 'captions', 'accuracy', 'appearance'])
      || draft.version !== 1 && draft.version !== 2 && draft.version !== 3
      || !identity(draft.ownerId) || !identity(draft.projectId) || !identity(draft.snapshotId)
      || !validMediaKey(draft.mediaKey, draft.projectId) || !time(draft.savedAt) || !Number.isInteger(draft.savedAt)
      || !isRecord(draft.basis) || !hasOnly(draft.basis, ['captions', 'context', 'appearance'])
      || (draft.captions !== undefined && !validCaptions(draft.captions))
      || (draft.accuracy !== undefined && !validAccuracy(draft.accuracy))) return undefined;
    const legacyPayload = draft.captions !== undefined || draft.accuracy !== undefined;
    if (draft.version === 3) {
      // A field-specific record carries only the saved values it may replace.
      // Legacy records retain their original, conservative two-field contract.
      if (!legacyPayload
        || (draft.captions !== undefined ? !textWithin(draft.basis.captions, compact ? maxExpandedBasisChars : limits.maxEntryBytes / 2, false) : draft.basis.captions !== undefined)
        || (draft.accuracy !== undefined ? !textWithin(draft.basis.context, limits.maxEntryBytes / 2, false) : draft.basis.context !== undefined)
        || (draft.appearance !== undefined ? !validAppearance(draft.appearance) || !validAppearanceBasis(draft.basis.appearance) : draft.basis.appearance !== undefined)) return undefined;
    } else if (legacyPayload && (!textWithin(draft.basis.captions, limits.maxEntryBytes / 2, false)
      || !textWithin(draft.basis.context, limits.maxEntryBytes / 2, false))) return undefined;
    if (draft.version === 1) {
      if (!legacyPayload || draft.appearance !== undefined || draft.basis.appearance !== undefined) return undefined;
    } else if (draft.version === 2) {
      if (!validAppearance(draft.appearance) || !validAppearanceBasis(draft.basis.appearance)
        || (!legacyPayload && (draft.basis.captions !== undefined || draft.basis.context !== undefined))) return undefined;
    }
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
      ...(hasWordTimingEvidence(caption.wordTiming) ? [word.method ?? null, word.issue ?? null, word.members ?? null] : []),
    ]), ...(hasWordTimingEvidence(caption.wordTiming) ? [caption.wordTiming.evidence] : [])] : null,
  ])]);
}

function contextBasis(project: CaptionProject) {
  return JSON.stringify([project.transcriptionContext?.description || '', project.transcriptionContext?.vocabulary || []]);
}

export function assessRecovery(entry: RecoveryEntry, canonical: CaptionProject): RecoveryStatus {
  const validated = parseEntry(entry.key, entry.raw, Date.now());
  if (!validated) return 'changed';
  if (validated.draft.projectId !== canonical.id || validated.draft.mediaKey !== projectMediaKey(canonical)) return 'media-changed';
  try {
    const { draft } = validated;
    const legacyPayload = draft.captions !== undefined || draft.accuracy !== undefined;
    if (draft.version === 3) {
      if (draft.captions !== undefined && draft.basis.captions !== captionsBasis(canonical)
        || draft.accuracy !== undefined && draft.basis.context !== contextBasis(canonical)) return 'changed';
    } else if (legacyPayload && (draft.basis.captions !== captionsBasis(canonical) || draft.basis.context !== contextBasis(canonical))) return 'changed';
    if (draft.appearance) {
      const current = appearanceBasis(canonical.captionAppearance);
      if (current === appearanceBasis(draft.appearance)) return legacyPayload ? 'matching' : 'already-saved';
      if (current !== draft.basis.appearance) return 'changed';
    }
    return 'matching';
  } catch { return 'changed'; }
}

/** A fresh read may prove a lost acknowledgement already saved this look. Keep
 * its exact recovery copy for Download/Discard, and never submit an identical write. */
export function restoredAppearance(entry: RecoveryEntry, canonical: CaptionProject): CaptionAppearance | undefined {
  if (assessRecovery(entry, canonical) !== 'matching') return undefined;
  const recovered = parseEntry(entry.key, entry.raw, Date.now())?.draft.appearance;
  return recovered && appearanceBasis(recovered) !== appearanceBasis(canonical.captionAppearance) ? { ...recovered } : undefined;
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
    if (before && JSON.stringify(editableCaption(before)) === JSON.stringify(caption)) return demoteRecoveredMarkedWordTiming({ ...before });
    const sameContent = before && before.text === caption.text && before.startMs === caption.startMs && before.endMs === caption.endMs;
    const after: CaptionSegment = { ...(sameContent ? before : {}), ...caption, approved: false };
    return before ? demoteRecoveredMarkedWordTiming(reconcileCaptionWordTiming(before, after)) : after;
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
        const changedCaptions = captions !== undefined && (input.keepUnchangedCaptions
          || JSON.stringify(captions) !== JSON.stringify(input.project.captions.map(editableCaption))) ? captions : undefined;
        if (input.appearance !== undefined && (!validAppearance(input.appearance) || !validAppearance(input.appearanceBasis))
          || input.appearance === undefined && input.appearanceBasis !== undefined) return { status: 'unavailable' };
        if (changedCaptions === undefined && input.accuracy === undefined && input.appearance === undefined) {
          return { status: clearOwn(input.project.id, mediaKey) ? 'cleared' : 'unavailable' };
        }
        const legacyPayload = changedCaptions !== undefined || input.accuracy !== undefined;
        const draft: RecoveryDraft = {
          version: legacyPayload ? 3 : 2, ownerId, projectId: input.project.id, mediaKey,
          snapshotId: `${now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`,
          savedAt: now(), basis: {
            ...(changedCaptions !== undefined ? { captions: captionsBasis(input.project) } : {}),
            ...(input.accuracy !== undefined ? { context: contextBasis(input.project) } : {}),
            ...(input.appearance !== undefined ? { appearance: appearanceBasis(input.appearanceBasis) } : {}),
          },
          ...(changedCaptions !== undefined ? { captions: changedCaptions } : {}),
          ...(input.accuracy !== undefined ? { accuracy: { description: input.accuracy.description, vocabulary: input.accuracy.vocabulary } } : {}),
          ...(input.appearance !== undefined ? { appearance: { ...input.appearance } } : {}),
        };
        const key = keyFor(draft);
        if (changedCaptions && !validCaptions(changedCaptions)
          || draft.accuracy && !validAccuracy(draft.accuracy)) return { status: 'too-large' };
        let raw = JSON.stringify(draft);
        if (bytes(key, raw) > limits.maxEntryBytes && changedCaptions) {
          const compact = compactCaptionWire(draft);
          if (!compact) return { status: 'too-large' };
          raw = JSON.stringify(compact);
        }
        if (bytes(key, raw) > limits.maxEntryBytes) return { status: 'too-large' };
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
    contains(entry: RecoveryEntry): boolean {
      const target = storage();
      if (!target) return false;
      try { return Boolean(parseEntry(entry.key, entry.raw, now())) && target.getItem(entry.key) === entry.raw; }
      catch { return false; }
    },
    remove(entry: RecoveryEntry): boolean {
      const target = storage();
      return target ? removeExact(target, entry) : false;
    },
    clearOwn,
  };
}
