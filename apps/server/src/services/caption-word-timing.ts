import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  buildCaptionWordTimingForExactText,
  hydrateCaptionWordTimings,
  resolveCaptionWordTiming,
  type CaptionProject,
  type CaptionSegment,
  type CaptionWordTiming,
  type TimedToken,
} from '@kcs/shared';
import { config } from '../config.js';
import { alignGeminiToTiming } from './alignment.js';
import { ensureNormalizedAudio, mediaFingerprint, stageSignature } from './cache.js';
import { alignTimingLocally, type LocalTimingAlignOptions } from './local-timing.js';
import { makeAudioChunk, removeWorkingDir } from './media.js';
import { store } from './store.js';
import { offsetTokens } from './transcript.js';
import { parseVocabulary } from './vocabulary.js';

type ExpectedMedia = Pick<CaptionProject['media'], 'filename' | 'size'>;

export const MAX_CAPTION_WORD_SYNC_DURATION_MS = 60_000;
export const MAX_CAPTION_WORD_SYNC_TEXT_CHARS = 2_000;
const MIN_CAPTION_WORD_TIMING_WINDOW_MS = 800;
const CAPTION_WORD_TIMING_PADDING_MS = 100;

export interface CaptionWordTimingCandidate {
  basis: CaptionSegment;
  wordTiming: CaptionWordTiming;
  sourceRevision?: string;
  warnings?: string[];
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

function fitAlignedTokensToCaption(tokens: TimedToken[], caption: CaptionSegment, directAlignment: boolean) {
  if (!directAlignment) return tokens;
  return tokens.map((token, index) => {
    if (token.timingSource !== 'stt') return token;
    if (!Number.isFinite(token.startMs) || !Number.isFinite(token.endMs) || token.endMs <= token.startMs) return token;
    const startMs = index === 0 ? Math.max(token.startMs, caption.startMs) : token.startMs;
    const endMs = index === tokens.length - 1 ? Math.min(token.endMs, caption.endMs) : token.endMs;
    // Only trim evidence that still overlaps the cue. A word wholly outside the
    // caption is genuinely unresolved and must remain review-required instead of
    // being pulled into the cue programmatically.
    if (endMs <= startMs) return token;
    if (startMs === token.startMs && endMs === token.endMs) return token;
    return { ...token, startMs, endMs };
  });
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
    const timing = await dependencies.alignTimingLocally(
      chunkPath,
      workDir,
      basis.text,
      initial.id,
      { allowWhisperFallback: false },
    );
    const aligned = alignGeminiToTiming(
      basis.text,
      timing,
      chunk.durationMs,
      parseVocabulary(initial.transcriptionContext?.vocabulary || []),
    );
    const absoluteTokens = offsetTokens(aligned.tokens, chunkStart, normalized.durationMs);
    const fittedTokens = fitAlignedTokensToCaption(absoluteTokens, basis, Boolean(aligned.diagnostics.directAlignment));
    const wordTiming = buildCaptionWordTimingForExactText(basis, fittedTokens, {
      ignoreConfidenceForReview: aligned.diagnostics.directAlignment === true,
    });
    if (!wordTiming) {
      throw new Error('Local timing could not map the exact caption wording to spoken-word anchors.');
    }

    // The final guard deliberately rechecks the full saved cue revision, including
    // wordTiming contents and locks, rather than only checking media identity.
    const current = await dependencies.getProject(projectId);
    if (!current) throw new CaptionWordTimingNotFoundError('Project not found');
    const currentCaption = assertBasis(current, basis, expectedMedia);
    if (captionWordTimingRevision(currentCaption) !== initialRevision || mediaFingerprint(current) !== initialMediaFingerprint) {
      throw new CaptionWordTimingConflictError('The caption changed while word timing was running. Its newer edits were kept.');
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
