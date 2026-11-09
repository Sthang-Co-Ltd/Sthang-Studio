import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  buildCaptionWordTimingForExactText,
  hydrateCaptionWordTimings,
  preserveManualCaptionWords,
  repairSmallWordTimingBoundaries,
  resolveCaptionWordTiming,
  type CaptionEdgeRepair,
  type CaptionWord,
  type CaptionProject,
  type CaptionSegment,
  type CaptionWordTiming,
  type TimedToken,
} from '@kcs/shared';
import { config } from '../config.js';
import { alignGeminiToTiming, MAX_DIRECT_UNION_GAP_MS } from './alignment.js';
import { ensureNormalizedAudio, mediaFingerprint, stageSignature } from './cache.js';
import { alignTimingLocally, type LocalTimingAlignOptions } from './local-timing.js';
import { makeAudioChunk, removeWorkingDir } from './media.js';
import { store } from './store.js';
import { offsetTokens } from './transcript.js';
import { tokenizeText } from './tokenizer.js';
import { parseVocabulary } from './vocabulary.js';
import type { TimingResult } from './timing-types.js';

type ExpectedMedia = Pick<CaptionProject['media'], 'filename' | 'size'>;

export const MAX_CAPTION_WORD_SYNC_DURATION_MS = 60_000;
export const MAX_CAPTION_WORD_SYNC_TEXT_CHARS = 2_000;
const MIN_CAPTION_WORD_TIMING_WINDOW_MS = 800;
const CAPTION_WORD_TIMING_PADDING_MS = 100;
const MAX_REMEASURED_SPAN_DRIFT_MS = 25;
const MAX_SHORT_CUE_MS = 380;
const MAX_SUGGESTED_EDGE_MOVE_MS = 350;
const MAX_NEIGHBORHOOD_MS = 8_000;
const MAX_NEIGHBORHOOD_TEXT = 350;
const MAX_MEASURED_EDGE_DRIFT_MS = 60;
const MAX_BOUNDED_CUE_EDGE_SPILL_MS = 25;

export interface CaptionWordTimingCandidate {
  basis: CaptionSegment;
  wordTiming: CaptionWordTiming;
  sourceRevision?: string;
  warnings?: string[];
  edgeRepair?: CaptionEdgeRepair;
}

export class CaptionWordTimingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionWordTimingConflictError';
  }
}

export class CaptionWordTimingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionWordTimingNotFoundError';
  }
}

export class CaptionWordTimingBusyError extends Error {
  constructor(message = 'Spoken-word timing is busy. Try again after the current sync finishes.') {
    super(message);
    this.name = 'CaptionWordTimingBusyError';
  }
}

export class CaptionWordTimingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionWordTimingInputError';
  }
}

export interface CaptionWordTimingDependencies {
  getProject(projectId: string): Promise<CaptionProject | null>;
  ensureNormalizedAudio(project: Pick<CaptionProject, 'id' | 'media'>): ReturnType<typeof ensureNormalizedAudio>;
  makeAudioChunk(sourceWav: string, outputPath: string, startMs: number, durationMs: number): ReturnType<typeof makeAudioChunk>;
  alignTimingLocally(
    wavPath: string,
    workDir: string,
    transcript: string,
    cacheNamespace?: string,
    options?: LocalTimingAlignOptions,
  ): ReturnType<typeof alignTimingLocally>;
  removeWorkingDir(workDir: string): Promise<void>;
}

const defaultDependencies: CaptionWordTimingDependencies = {
  getProject: (projectId) => store.get(projectId),
  ensureNormalizedAudio,
  makeAudioChunk,
  alignTimingLocally,
  removeWorkingDir,
};

let activeWordTimingRequest: symbol | null = null;

function acquireWordTimingSlot() {
  if (activeWordTimingRequest) throw new CaptionWordTimingBusyError();
  const token = Symbol('caption-word-timing');
  activeWordTimingRequest = token;
  return () => {
    if (activeWordTimingRequest === token) activeWordTimingRequest = null;
  };
}

function matchesMedia(project: Pick<CaptionProject, 'media'>, expected: ExpectedMedia) {
  return project.media.filename === expected.filename && project.media.size === expected.size;
}

function normalizedRevisionCaption(caption: CaptionSegment) {
  return {
    id: caption.id,
    startMs: caption.startMs,
    endMs: caption.endMs,
    text: caption.text,
    confidence: caption.confidence ?? null,
    timingQuality: caption.timingQuality ?? null,
    timingSource: caption.timingSource ?? null,
    approved: caption.approved ?? null,
    textLocked: caption.textLocked ?? null,
    timingLocked: caption.timingLocked ?? null,
    wordTiming: caption.wordTiming ?? null,
  };
}

/**
 * Revision identity for an exact editor cue. Word timing and locks are part of
 * the revision so a slow local alignment can never overwrite a newer word edit,
 * timing edit, approval/lock change, split/merge, or background word sync.
 */
export function captionWordTimingRevision(caption: CaptionSegment) {
  return stageSignature({ version: 1, caption: normalizedRevisionCaption(caption) });
}

/**
 * Older projects may not have persisted per-caption word timing yet. Hydrate it
 * only from canonical transcript tokens when the project still declares those
 * tokens synchronized with the captions. This mirrors the editor's safe legacy
 * hydration without inventing proportional timing for corrected wording.
 */
export function hydrateProjectWordTimings(project: CaptionProject): CaptionProject {
  return hydrateCaptionWordTimings(project);
}

function effectiveCaption(project: CaptionProject, caption: CaptionSegment) {
  if (caption.wordTiming || project.transcriptNeedsSync || !project.transcript?.tokens?.length) return caption;
  return hydrateProjectWordTimings(project).captions.find((item) => item.id === caption.id) || caption;
}

function captionById(project: CaptionProject, id: string) {
  const caption = project.captions.find((item) => item.id === id);
  return caption ? effectiveCaption(project, caption) : null;
}

function assertBasis(project: CaptionProject, basis: CaptionSegment, expectedMedia: ExpectedMedia) {
  if (!matchesMedia(project, expectedMedia)) {
    throw new CaptionWordTimingConflictError('This word timing request belongs to an older media version. Reload the project and try again.');
  }
  const current = captionById(project, basis.id);
  if (!current) {
    throw new CaptionWordTimingConflictError('This caption changed or was removed. Sync its words again from the current caption.');
  }
  if (captionWordTimingRevision(current) !== captionWordTimingRevision(basis)) {
    throw new CaptionWordTimingConflictError('This caption changed before word timing could be synced. Its newer edits were kept.');
  }
  if (current.timingLocked) {
    throw new CaptionWordTimingConflictError('Unlock this caption timing before syncing its spoken words.');
  }
  return current;
}

function validateBasis(value: CaptionSegment) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim()) {
    throw new CaptionWordTimingInputError('A valid caption is required for word timing.');
  }
  if (typeof value.text !== 'string' || !value.text.trim()) {
    throw new CaptionWordTimingInputError('Caption text is required for word timing.');
  }
  if (!Number.isFinite(value.startMs) || !Number.isFinite(value.endMs) || value.startMs < 0 || value.endMs <= value.startMs) {
    throw new CaptionWordTimingInputError('Caption timing is invalid.');
  }
  if (value.endMs - value.startMs > MAX_CAPTION_WORD_SYNC_DURATION_MS) {
    throw new CaptionWordTimingInputError('This caption is too long to sync word timing. Split it into captions under 60 seconds and try again.');
  }
  if ([...value.text].length > MAX_CAPTION_WORD_SYNC_TEXT_CHARS) {
    throw new CaptionWordTimingInputError('This caption has too much text to sync word timing. Split it into shorter captions and try again.');
  }
}

function captionWordTimingWindow(captionStart: number, captionEnd: number, mediaDurationMs: number) {
  const cueDuration = captionEnd - captionStart;
  const desiredDuration = Math.min(
    mediaDurationMs,
    Math.max(MIN_CAPTION_WORD_TIMING_WINDOW_MS, cueDuration + CAPTION_WORD_TIMING_PADDING_MS * 2),
  );
  const centeredStart = Math.round((captionStart + captionEnd - desiredDuration) / 2);
  const chunkStart = Math.max(0, Math.min(centeredStart, mediaDurationMs - desiredDuration));
  return { chunkStart, chunkEnd: chunkStart + desiredDuration };
}

function clipMeasuredCueEdges(caption: CaptionSegment, track: CaptionWordTiming): CaptionWordTiming {
  const words = track.words.map((word, index) => {
    if (word.source !== 'aligned' || word.needsReview || word.startMs === null || word.endMs === null) return word;
    // Forced alignment listens beyond the cue. Use only the measured part of
    // the first or last word that can be displayed within the saved cue.
    const startMs = index === 0 ? Math.max(word.startMs, caption.startMs) : word.startMs;
    const endMs = index === track.words.length - 1 ? Math.min(word.endMs, caption.endMs) : word.endMs;
    if (endMs - startMs < 10 || (startMs === word.startMs && endMs === word.endMs)) return word;
    return { ...word, startMs, endMs };
  });
  return { ...track, words };
}

function remeasuredSplitTokens(
  original: ReturnType<typeof alignGeminiToTiming>,
  refined: ReturnType<typeof alignGeminiToTiming>,
): TimedToken[] | undefined {
  const tokens = original.tokens.slice();
  for (const { tokenStart, tokenCount, startMs, endMs } of original.measuredSplitAnchors) {
    const measured = refined.tokens.slice(tokenStart, tokenStart + tokenCount);
    if (measured.length !== tokenCount || measured.some((word) => word.timingSource !== 'stt')
      || Math.abs(measured[0].startMs - startMs) > MAX_REMEASURED_SPAN_DRIFT_MS
      || Math.abs(measured[tokenCount - 1].endMs - endMs) > MAX_REMEASURED_SPAN_DRIFT_MS) return undefined;
    for (const [index, word] of measured.entries()) {
      const originalWord = tokens[tokenStart + index];
      tokens[tokenStart + index] = { ...originalWord, startMs: word.startMs, endMs: word.endMs, timingSource: 'stt' };
    }
  }
  // A refined split must fit between the original neighboring word anchors.
  return tokens.some((word, index) => index > 0 && tokens[index - 1].endMs > word.startMs) ? undefined : tokens;
}

function refineDisplayWordsAtMeasuredPauses(
  display: CaptionWordTiming,
  original: CaptionWordTiming,
  separated: CaptionWordTiming,
): CaptionWordTiming | undefined {
  const originalStarts = new Map(original.words.map((word) => [word.startOffset, word]));
  const originalEnds = new Map(original.words.map((word) => [word.endOffset, word]));
  const isMeasured = (word: CaptionWord | undefined) => word?.source === 'aligned' && !word.needsReview;
  const agrees = (a: number, b: number) => Math.abs(a - b) <= MAX_REMEASURED_SPAN_DRIFT_MS;
  const words: CaptionWord[] = [];
  let offset = 0;
  let confirmedPause = false;

  for (const [index, word] of display.words.entries()) {
    const first = offset;
    while (separated.words[offset] && separated.words[offset].startOffset < word.endOffset) offset += 1;
    const parts = separated.words.slice(first, offset);
    const start = parts[0];
    const end = parts.at(-1);
    // Retain every display boundary and any timing that was already measured.
    if (!start || !end || start.startOffset !== word.startOffset || end.endOffset !== word.endOffset) return undefined;
    if (isMeasured(word)) {
      if (parts.length !== 1) return undefined;
      words.push(word);
      continue;
    }

    // The separately measured run must stay within the same acoustic span.
    if (index === 0 || isMeasured(display.words[index - 1])) {
      const edge = originalStarts.get(start.startOffset);
      if (!edge || !agrees(edge.startMs!, start.startMs!)) return undefined;
    }
    if (index === display.words.length - 1 || isMeasured(display.words[index + 1])) {
      const edge = originalEnds.get(end.endOffset);
      if (!edge || !agrees(edge.endMs!, end.endMs!)) return undefined;
    }

    for (let part = 1; part < parts.length; part += 1) {
      const left = parts[part - 1];
      const right = parts[part];
      const originalLeft = originalEnds.get(left.endOffset);
      const originalRight = originalStarts.get(right.startOffset);
      if (!originalLeft || !originalRight
        || right.startMs! - left.endMs! <= MAX_DIRECT_UNION_GAP_MS
        || originalRight.startMs! - originalLeft.endMs! <= MAX_DIRECT_UNION_GAP_MS
        || !agrees(originalLeft.endMs!, left.endMs!) || !agrees(originalRight.startMs!, right.startMs!)) return undefined;
      confirmedPause = true;
    }
    words.push(...parts);
  }

  return confirmedPause && offset === separated.words.length ? { ...display, words } : undefined;
}

type ShortCueRecovery = ({ wordTiming: CaptionWordTiming } | { edgeRepair: CaptionEdgeRepair }) & { context: CaptionSegment[] };
type ShortCueEvidence = { wordTiming: CaptionWordTiming; alignmentText: string };

async function checkShortCueTiming(
  project: CaptionProject,
  basis: CaptionSegment,
  { wordTiming, alignmentText }: ShortCueEvidence,
  normalized: Awaited<ReturnType<typeof ensureNormalizedAudio>>,
  workDir: string,
  dependencies: CaptionWordTimingDependencies,
  suggestEdges: boolean,
): Promise<ShortCueRecovery | undefined> {
  if (basis.endMs - basis.startMs > MAX_SHORT_CUE_MS
    || wordTiming.words.some((word) => word.source !== 'aligned' || word.needsReview || word.startMs === null || word.endMs === null)
    || !wordTiming.words.some((word) => word.endMs! <= basis.startMs || word.startMs! >= basis.endMs)) return undefined;

  const ordered = hydrateProjectWordTimings(project).captions.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const index = ordered.findIndex((cue) => cue.id === basis.id);
  const previous = ordered[index - 1];
  const next = ordered[index + 1];
  if (index < 0 || (previous && previous.endMs > basis.startMs) || (next && next.startMs < basis.endMs)) return undefined;
  const hitsNeighbor = wordTiming.words.some((word) =>
    (previous && word.endMs! <= basis.startMs && word.startMs! < previous.endMs && word.endMs! > previous.startMs)
    || (next && word.startMs! >= basis.endMs && word.startMs! < next.endMs && word.endMs! > next.startMs));
  if (!suggestEdges && !hitsNeighbor) return undefined;

  const context = [...(previous ? [previous] : []), basis, ...(next ? [next] : [])];
  const transcript = context.map((cue) => cue.text).join('\n');
  const alignmentTranscript = context.map((cue) => cue.id === basis.id ? alignmentText : cue.text).join('\n');
  const { chunkStart, chunkEnd } = captionWordTimingWindow(context[0].startMs, context.at(-1)!.endMs, normalized.durationMs);
  if (chunkEnd - chunkStart > MAX_NEIGHBORHOOD_MS || [...transcript].length > MAX_NEIGHBORHOOD_TEXT) return undefined;
  const measure = async (text: string, input: string, startMs: number, endMs: number, file: string) => {
    const wav = path.join(workDir, file);
    const chunk = await dependencies.makeAudioChunk(normalized.outputPath, wav, startMs, endMs - startMs);
    const timing = await dependencies.alignTimingLocally(wav, workDir, input, project.id, { allowWhisperFallback: false });
    if (timing.engine !== 'kfa-local' || timing.directAlignment !== true) return undefined;
    const aligned = alignGeminiToTiming(text, timing, chunk.durationMs);
    return offsetTokens(aligned.tokens, startMs, normalized.durationMs);
  };
  const tokens = await measure(transcript, alignmentTranscript, chunkStart, chunkEnd, 'caption-neighborhood.wav');
  if (!tokens) return undefined;
  const tracks = new Map<string, CaptionWordTiming>();
  let offset = 0;
  for (const cue of context) {
    const end = offset + tokenizeText(cue.text).length;
    const clip = { ...cue, startMs: chunkStart, endMs: chunkEnd };
    const track = buildCaptionWordTimingForExactText(clip, tokens.slice(offset, end), { ignoreConfidenceForReview: true });
    if (!track || resolveCaptionWordTiming({ ...clip, wordTiming: track }).state !== 'ready') return undefined;
    tracks.set(cue.id, track);
    offset = end;
  }
  if (offset !== tokens.length) return undefined;

  const target = tracks.get(basis.id)!;
  if (hitsNeighbor && resolveCaptionWordTiming({ ...basis, wordTiming: clipMeasuredCueEdges(basis, target) }).state === 'ready') {
    // The padded clip can pick up a word from the adjoining caption. Check
    // a clip that excludes that speech, then compare every measured word
    // with the independent alignment that accounts for the neighbor's text.
    const window = captionWordTimingWindow(basis.startMs, basis.endMs, normalized.durationMs);
    const startMs = Math.max(window.chunkStart, previous?.endMs ?? 0);
    const endMs = Math.min(window.chunkEnd, next?.startMs ?? normalized.durationMs);
    try {
      const bounded = await measure(basis.text, alignmentText, startMs, endMs, 'caption-bounded.wav');
      const track = bounded && buildCaptionWordTimingForExactText(basis, bounded, { ignoreConfidenceForReview: true });
      if (track && track.words.length === target.words.length
        && basis.startMs - track.words[0].startMs! <= MAX_BOUNDED_CUE_EDGE_SPILL_MS
        && track.words.at(-1)!.endMs! - basis.endMs <= MAX_BOUNDED_CUE_EDGE_SPILL_MS
        && track.words.every((word, index) => {
          const other = target.words[index];
          return word.startMs !== null && word.endMs !== null
            && word.startOffset === other.startOffset && word.endOffset === other.endOffset
            && Math.abs(word.startMs! - other.startMs!) <= MAX_REMEASURED_SPAN_DRIFT_MS
            && Math.abs(word.endMs! - other.endMs!) <= MAX_REMEASURED_SPAN_DRIFT_MS;
        })) {
        const visible = clipMeasuredCueEdges(basis, track);
        if (resolveCaptionWordTiming({ ...basis, wordTiming: visible }).state === 'ready') return { wordTiming: visible, context };
      }
    } catch {
      // A short bounded clip may have too few frames. The optional edge
      // suggestion can still use the wider measurement below.
    }
  }
  if (!suggestEdges) return undefined;

  const start = target.words[0].startMs!;
  const end = target.words.at(-1)!.endMs!;
  if (Math.abs(start - wordTiming.words[0].startMs!) > MAX_MEASURED_EDGE_DRIFT_MS
    || Math.abs(end - wordTiming.words.at(-1)!.endMs!) > MAX_MEASURED_EDGE_DRIFT_MS) return undefined;

  const bounds = new Map<string, { startMs: number; endMs: number }>();
  let startMs = Math.min(basis.startMs, start);
  let endMs = Math.max(basis.endMs, end);
  if (previous && startMs < previous.endMs) {
    const leftSpeechEnd = tracks.get(previous.id)!.words.at(-1)!.endMs!;
    if (leftSpeechEnd > start || previous.timingLocked) return undefined;
    startMs = Math.round((leftSpeechEnd + start) / 2);
    bounds.set(previous.id, { startMs: previous.startMs, endMs: startMs });
  }
  if (next && endMs > next.startMs) {
    const rightSpeechStart = tracks.get(next.id)!.words[0].startMs!;
    if (rightSpeechStart < end || next.timingLocked) return undefined;
    endMs = Math.round((end + rightSpeechStart) / 2);
    bounds.set(next.id, { startMs: endMs, endMs: next.endMs });
  }
  if (startMs === basis.startMs && endMs === basis.endMs) return undefined;
  bounds.set(basis.id, { startMs, endMs });

  const before = context.filter((cue) => bounds.has(cue.id));
  const after: CaptionSegment[] = [];
  for (const cue of before) {
    const edges = bounds.get(cue.id)!;
    if (edges.startMs < 0 || edges.endMs > normalized.durationMs
      || edges.endMs - edges.startMs < Math.max(40, Math.min(MAX_SHORT_CUE_MS, cue.endMs - cue.startMs))
      || Math.abs(cue.startMs - edges.startMs) > MAX_SUGGESTED_EDGE_MOVE_MS
      || Math.abs(cue.endMs - edges.endMs) > MAX_SUGGESTED_EDGE_MOVE_MS) return undefined;
    const candidate = { ...cue, ...edges, approved: false, timingSource: 'manual' as const, timingQuality: 'medium' as const };
    const measured = clipMeasuredCueEdges(candidate, tracks.get(cue.id)!);
    const replacement = { ...candidate, wordTiming: preserveManualCaptionWords(cue, measured) };
    if (resolveCaptionWordTiming(replacement).state !== 'ready') return undefined;
    after.push(replacement);
  }
  const overlaps = (changes: CaptionSegment[]) => changes.some((cue) => ordered.some((prior) => {
    const other = changes.find((item) => item.id === prior.id) ?? prior;
    return cue.id !== other.id && cue.startMs < other.endMs && other.startMs < cue.endMs;
  }));
  if (overlaps(before) || overlaps(after)) return undefined;
  return { edgeRepair: { before, after, guards: context.filter((cue) => !bounds.has(cue.id)) }, context };
}

function alignmentWarnings(wordTiming: CaptionWordTiming, engineFallbackReason?: string) {
  const warnings: string[] = [];
  const reviewCount = wordTiming.words.filter((word) => word.needsReview || word.source === 'estimated').length;
  if (reviewCount > 0) {
    warnings.push(`${reviewCount} spoken word${reviewCount === 1 ? '' : 's'} could not be anchored confidently and should be checked.`);
  }
  if (engineFallbackReason) warnings.push('Studio used a local timing fallback for this caption. Check the spoken-word timing before export.');
  return warnings;
}

/**
 * Force-align one already-saved caption's exact wording against a small local
 * audio window. This never calls Gemini and never mutates project state. The
 * caller receives a candidate tied to the exact saved caption revision it was
 * prepared from and decides whether to apply/save it.
 */
export async function syncCaptionWordsLocally(
  projectId: string,
  basisInput: CaptionSegment,
  expectedMedia: ExpectedMedia,
  dependencies: CaptionWordTimingDependencies = defaultDependencies,
  suggestEdges = false,
): Promise<CaptionWordTimingCandidate> {
  validateBasis(basisInput);
  const initial = await dependencies.getProject(projectId);
  if (!initial) throw new CaptionWordTimingNotFoundError('Project not found');
  const basis = structuredClone(assertBasis(initial, basisInput, expectedMedia));
  const initialRevision = captionWordTimingRevision(basis);
  const initialMediaFingerprint = mediaFingerprint(initial);
  const releaseSlot = acquireWordTimingSlot();
  let workDir = '';

  try {
    const normalized = await dependencies.ensureNormalizedAudio(initial);
    const captionStart = Math.max(0, Math.min(normalized.durationMs, Math.round(basis.startMs)));
    const captionEnd = Math.max(captionStart + 1, Math.min(normalized.durationMs, Math.round(basis.endMs)));
    if (captionEnd <= captionStart || captionStart >= normalized.durationMs) {
      throw new CaptionWordTimingInputError('Caption timing falls outside the source audio.');
    }

    // Exact-word forced alignment needs enough acoustic frames to consume the
    // transcript. Very short cues can otherwise underflow KFA's CTC backtrack
    // before it reaches the first token. Keep the ordinary 100 ms margins for
    // longer cues, but clamp-and-shift short cues to a tight 800 ms minimum.
    const { chunkStart, chunkEnd } = captionWordTimingWindow(captionStart, captionEnd, normalized.durationMs);
    workDir = path.join(config.workingDir, `${initial.id}-word-timing-${nanoid(6)}`);
    const chunkPath = path.join(workDir, 'caption.wav');
    const chunk = await dependencies.makeAudioChunk(normalized.outputPath, chunkPath, chunkStart, chunkEnd - chunkStart);

    // Recheck before expensive alignment so media replacement or a concurrent
    // saved caption edit cannot waste work or produce a candidate for stale data.
    const beforeAlignment = await dependencies.getProject(projectId);
    if (!beforeAlignment) throw new CaptionWordTimingNotFoundError('Project not found');
    const beforeCaption = assertBasis(beforeAlignment, basis, expectedMedia);
    if (captionWordTimingRevision(beforeCaption) !== initialRevision || mediaFingerprint(beforeAlignment) !== initialMediaFingerprint) {
      throw new CaptionWordTimingConflictError('The project changed while word timing was being prepared. Its newer edits were kept.');
    }

    // Sync words already owns the exact saved wording. Keep this bounded action on
    // KFA instead of cold-loading unconstrained Whisper when exact forced alignment
    // cannot support the cue; manual word timing remains the recovery path.
    const alignExactWords = (text: string) => dependencies.alignTimingLocally(
      chunkPath, workDir, text, initial.id, { allowWhisperFallback: false },
    );
    const timing = await alignExactWords(basis.text);
    const aligned = alignGeminiToTiming(
      basis.text,
      timing,
      chunk.durationMs,
      parseVocabulary(initial.transcriptionContext?.vocabulary || []),
    );
    const direct = timing.engine === 'kfa-local' && timing.directAlignment === true;
    const buildTrack = (tokens: TimedToken[]) => {
      const absolute = offsetTokens(tokens, chunkStart, normalized.durationMs);
      return buildCaptionWordTimingForExactText(basis, absolute, { ignoreConfidenceForReview: direct });
    };
    const buildMeasuredTrack = (result: TimingResult) => {
      if (result.words.some((word) => word.derived)) return undefined;
      const track = buildTrack(result.words.map((word, index) => ({
        ...word, id: nanoid(8), spaceBefore: index > 0, timingSource: 'stt',
      })));
      if (!track || track.words.some((word, index) => word.source !== 'aligned' || word.needsReview
        || (index > 0 && word.startMs! < track.words[index - 1].endMs!))) return undefined;
      return track;
    };
    const fitTrack = (track: CaptionWordTiming) => {
      const fitted = direct ? clipMeasuredCueEdges(basis, track) : track;
      return repairSmallWordTimingBoundaries({ ...basis, wordTiming: fitted }) ?? fitted;
    };
    const measuredTrack = buildTrack(aligned.tokens);
    if (!measuredTrack) {
      throw new Error('Local timing could not map the exact caption wording to spoken-word anchors.');
    }
    let wordTiming = fitTrack(measuredTrack);
    let recoveryEvidence: ShortCueEvidence = { wordTiming: measuredTrack, alignmentText: basis.text };

    if (direct && measuredTrack.words.some((word) => word.source === 'estimated')
      && resolveCaptionWordTiming({ ...basis, wordTiming }).state === 'partial') {
      // KFA phonemizes each line independently. Give it the same display words
      // with explicit boundaries and reuse the acoustic evidence for this WAV.
      const separated = aligned.tokens.map((token) => token.text).join('\n');
      const originalMeasured = buildMeasuredTrack(timing);
      if (separated !== basis.text.trim() && (aligned.measuredSplitAnchors.length || originalMeasured)) {
        try {
          const timing = await alignExactWords(separated);
          if (timing.engine === 'kfa-local' && timing.directAlignment === true) {
            const refined = alignGeminiToTiming(basis.text, timing, chunk.durationMs);
            const tokens = aligned.measuredSplitAnchors.length ? remeasuredSplitTokens(aligned, refined) : undefined;
            const track = tokens && buildTrack(tokens);
            // A consistent, separately measured word may still land outside the
            // cue in the padded clip. Use it only as evidence for the next check.
            if (track) recoveryEvidence = { wordTiming: track, alignmentText: separated };
            const candidate = track && fitTrack(track);
            if (candidate && resolveCaptionWordTiming({ ...basis, wordTiming: candidate }).state === 'ready') {
              wordTiming = candidate;
            } else if (originalMeasured) {
              const separatedMeasured = buildMeasuredTrack(timing);
              const pausedTrack = separatedMeasured
                && refineDisplayWordsAtMeasuredPauses(measuredTrack, originalMeasured, separatedMeasured);
              const fitted = pausedTrack && fitTrack(pausedTrack);
              if (fitted && resolveCaptionWordTiming({ ...basis, wordTiming: fitted }).state === 'ready') wordTiming = fitted;
            }
          }
        } catch {
          // A second pass is optional. Keep the original tentative result for review.
        }
      }
    }

    let recovery: ShortCueRecovery | undefined;
    if (direct && resolveCaptionWordTiming({ ...basis, wordTiming }).state === 'partial') {
      try {
        recovery = await checkShortCueTiming(beforeAlignment, basis, recoveryEvidence, normalized, workDir, dependencies, suggestEdges);
      } catch {
        // Word sync can still return its tentative track if the wider pass fails.
      }
    }

    // The final guard deliberately rechecks the full saved cue revision, including
    // wordTiming contents and locks, rather than only checking media identity.
    const current = await dependencies.getProject(projectId);
    if (!current) throw new CaptionWordTimingNotFoundError('Project not found');
    const currentCaption = assertBasis(current, basis, expectedMedia);
    if (captionWordTimingRevision(currentCaption) !== initialRevision || mediaFingerprint(current) !== initialMediaFingerprint) {
      throw new CaptionWordTimingConflictError('The caption changed while word timing was running. Its newer edits were kept.');
    }
    let edgeRepair: CaptionEdgeRepair | undefined;
    if (recovery) {
      const latest = new Map(hydrateProjectWordTimings(current).captions.map((cue) => [cue.id, cue]));
      if (recovery.context.every((cue) => {
        const current = latest.get(cue.id);
        return current && captionWordTimingRevision(cue) === captionWordTimingRevision(current);
      })) {
        if ('wordTiming' in recovery) wordTiming = recovery.wordTiming;
        else edgeRepair = recovery.edgeRepair;
      }
    }

    const warnings = alignmentWarnings(wordTiming, aligned.diagnostics.fallbackReason);
    const resolution = resolveCaptionWordTiming({ ...basis, wordTiming });
    if (resolution.state === 'partial' && resolution.reason && !warnings.includes(resolution.reason)) {
      warnings.push(resolution.reason);
    }
    return {
      basis,
      wordTiming,
      sourceRevision: stageSignature({
        version: 1,
        mediaFingerprint: initialMediaFingerprint,
        captionRevision: initialRevision,
      }),
      ...(warnings.length ? { warnings } : {}),
      ...(edgeRepair ? { edgeRepair } : {}),
    };
  } catch (error) {
    if (error instanceof CaptionWordTimingConflictError || error instanceof CaptionWordTimingNotFoundError) throw error;

    // Cache invalidation during media replacement can surface as an I/O/timing
    // error. Prefer the actionable stale-media response when that is the cause.
    const current = await dependencies.getProject(projectId);
    if (!current) throw new CaptionWordTimingNotFoundError('Project not found');
    if (!matchesMedia(current, expectedMedia) || mediaFingerprint(current) !== initialMediaFingerprint) {
      throw new CaptionWordTimingConflictError('The source media changed while word timing was running. The older result was discarded.');
    }
    throw error;
  } finally {
    if (workDir) await dependencies.removeWorkingDir(workDir).catch(() => {});
    releaseSlot();
  }
}
