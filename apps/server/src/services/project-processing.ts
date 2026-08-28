import path from 'node:path';
import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type {
  CaptionProject,
  CaptionSegment,
  QaProfileSettings,
  RegenerationApplyMode,
  RegenerationCandidateSummary,
  RegenerationDiffItem,
  RegenerationProposal,
  RegenerationRefinementInput,
  RegenerationStrategy,
  TranscriptionContext,
} from '@kcs/shared';
import { config } from '../config.js';
import { store } from './store.js';
import { profileStore } from './profile-store.js';
import { transcribeTextWithGemini, type GeminiTranscript, type GeminiTranscriptionGuidance } from './gemini.js';
import { alignTimingLocally } from './local-timing.js';
import { alignGeminiToTiming } from './alignment.js';
import { makeAudioChunk, removeWorkingDir } from './media.js';
import { ensureNormalizedAudio, readStageCache, stageSignature, writeStageCache } from './cache.js';
import { segmentTimedTokens } from './segmenter.js';
import { normalizeTranscriptionContext, parseVocabulary } from './vocabulary.js';
import { joinTokens, levenshteinSimilarity, normalizeForMatch, normalizeKhmerDisplayText, tokenizeText } from './tokenizer.js';
import { offsetTokens, rebuildDiagnostics, replaceTimedRange, transcriptText } from './transcript.js';
import type { TimingResult } from './timing-types.js';
import { captionsInRange, preserveCaptionLocks } from './caption-locks.js';
import { proposalStore, type StoredRegenerationProposal } from './proposal-store.js';
import { historyStore } from './history-store.js';
import { resolveGeminiSettings } from './llm-settings.js';

export type ProgressReporter = (stage: string, progress: number, message: string) => Promise<void> | void;

function uniqueVocabulary(...groups: Array<string[] | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group || []) {
      const line = String(raw || '').trim();
      if (!line) continue;
      const key = line.toLocaleLowerCase('en');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

export async function resolveRequestedContext(project: CaptionProject, value: unknown): Promise<TranscriptionContext> {
  const profile = await profileStore.get();
  const requested = value != null
    ? normalizeTranscriptionContext(value)
    : normalizeTranscriptionContext(project.transcriptionContext);
  return {
    description: requested.description,
    vocabulary: uniqueVocabulary(profile.defaultVocabulary, requested.vocabulary),
  };
}

function currentCacheInfo(project: CaptionProject, normalized: Awaited<ReturnType<typeof ensureNormalizedAudio>>) {
  return {
    mediaFingerprint: normalized.fingerprint,
    normalizedAudioCached: true,
    normalizedAudioDurationMs: normalized.durationMs,
    normalizedAudioCachedAt: normalized.cachedAt,
    textStageCachedAt: project.pipelineCache?.textStageCachedAt,
    timingStageCachedAt: project.pipelineCache?.timingStageCachedAt,
    lastRangeRegeneratedAt: project.pipelineCache?.lastRangeRegeneratedAt,
  };
}

export async function transcribeProject(
  projectId: string,
  contextValue: unknown,
  force = false,
  progress: ProgressReporter = () => {},
) {
  const project = await store.get(projectId);
  if (!project) throw new Error('Project not found');
  const previousCaptions = structuredClone(project.captions);
  if (project.captions.length || project.transcript) {
    await historyStore.checkpoint(project, 'Before full regeneration', 'regeneration');
  }

  await progress('audio', 8, 'Preparing normalized audio…');
  const normalized = await ensureNormalizedAudio(project);
  const context = await resolveRequestedContext(project, contextValue);
  project.transcriptionContext = context;
  project.pipelineCache = currentCacheInfo(project, normalized);

  await progress('transcription', 22, 'Transcribing Khmer text with Gemini…');
  const llm = await resolveGeminiSettings();
  if (!llm.configured) {
    throw new Error('Connect Gemini in Settings → AI connection before generating captions.');
  }
  const geminiSignature = stageSignature({
    version: 3,
    mediaFingerprint: normalized.fingerprint,
    context,
    primaryModel: llm.model,
    fallbackModel: llm.fallbackModel,
    nativeVocabularyBias: config.geminiNativeVocabularyBias,
  });
  const cachedGemini = force ? null : await readStageCache<GeminiTranscript>(project.id, 'gemini', geminiSignature);
  const gemini = cachedGemini?.value || await transcribeTextWithGemini(normalized.outputPath, context);
  if (cachedGemini) {
    await progress('transcription', 43, 'Resumed from saved Gemini transcript checkpoint.');
    project.pipelineCache.textStageCachedAt = cachedGemini.createdAt;
  } else {
    const saved = await writeStageCache(project.id, 'gemini', geminiSignature, gemini);
    project.pipelineCache.textStageCachedAt = saved.createdAt;
  }

  await progress('alignment', 52, 'Force-aligning exact words with local Khmer timing…');
  const timingSignature = stageSignature({
    version: 2,
    mediaFingerprint: normalized.fingerprint,
    alignmentText: gemini.alignmentText,
    kfaEnabled: config.localKfaEnabled,
    whisperFallbackEnabled: config.localWhisperFallbackEnabled,
    whisperModel: config.localWhisperModel,
    whisperLanguage: config.localWhisperLanguage,
  });
  const cachedTiming = force ? null : await readStageCache<TimingResult>(project.id, 'timing', timingSignature);
  const timing = cachedTiming?.value || await alignTimingLocally(normalized.outputPath, normalized.dir, gemini.alignmentText);
  if (cachedTiming) {
    await progress('alignment', 74, 'Resumed from saved local timing checkpoint.');
    project.pipelineCache.timingStageCachedAt = cachedTiming.createdAt;
  } else {
    const saved = await writeStageCache(project.id, 'timing', timingSignature, timing);
    project.pipelineCache.timingStageCachedAt = saved.createdAt;
  }

  await progress('grouping', 82, 'Combining wording, timing and reviewed locks…');
  const aligned = alignGeminiToTiming(gemini.fullText, timing, normalized.durationMs, parseVocabulary(context.vocabulary));
  const naturalSegments = segmentTimedTokens(aligned.tokens, {
    mode: 'single-line',
    protectedPhrases: gemini.vocabularyTerms,
  });
  project.transcript = {
    language: gemini.language,
    fullText: transcriptText(aligned.tokens),
    textModel: gemini.textModel,
    textModelFallback: gemini.fallbackUsed,
    nativeVocabularyBias: gemini.nativeVocabularyBias,
    vocabularyTerms: gemini.vocabularyTerms,
    tokens: aligned.tokens,
    segments: naturalSegments,
    timing: aligned.diagnostics,
  };
  const generated = segmentTimedTokens(aligned.tokens, {
    mode: project.mode,
    protectedPhrases: gemini.vocabularyTerms,
  });
  project.captions = preserveCaptionLocks(previousCaptions, generated);
  project.engineVersion = '0.7.10';
  project.transcriptNeedsSync = false;
  project.updatedAt = new Date().toISOString();
  await store.upsert(project);
  await progress('complete', 100, 'Captions are ready for review.');
  return project;
}

function center(caption: CaptionSegment) {
  return (caption.startMs + caption.endMs) / 2;
}

function overlapMs(a: CaptionSegment, b: CaptionSegment) {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

function buildDiff(original: CaptionSegment[], proposed: CaptionSegment[]) {
  const unused = new Set(original.map((caption) => caption.id));
  const changes: RegenerationDiffItem[] = [];
  let unchangedCount = 0;

  for (const next of proposed) {
    let match: CaptionSegment | undefined;
    let best = Number.NEGATIVE_INFINITY;
    for (const current of original) {
      if (!unused.has(current.id)) continue;
      const overlap = overlapMs(current, next);
      const score = overlap > 0 ? overlap + 100000 : -Math.abs(center(current) - center(next));
      if (score > best) { best = score; match = current; }
    }
    if (match) unused.delete(match.id);
    const beforeText = match?.text || '';
    const afterText = next.text;
    const beforeStartMs = match?.startMs ?? next.startMs;
    const beforeEndMs = match?.endMs ?? next.startMs;
    const textChanged = normalizeKhmerDisplayText(beforeText) !== normalizeKhmerDisplayText(afterText);
    const timingDeltaMs = Math.max(Math.abs(beforeStartMs - next.startMs), Math.abs(beforeEndMs - next.endMs));
    const timingChanged = timingDeltaMs > 40;
    if (!textChanged && !timingChanged) { unchangedCount += 1; continue; }
    changes.push({
      id: nanoid(10),
      startMs: Math.min(beforeStartMs, next.startMs),
      endMs: Math.max(beforeEndMs, next.endMs),
      beforeText,
      afterText,
      beforeStartMs,
      beforeEndMs,
      afterStartMs: next.startMs,
      afterEndMs: next.endMs,
      textChanged,
      timingChanged,
      timingDeltaMs,
      confidence: next.timingQuality === 'high' ? 'high' : next.timingQuality === 'low' ? 'low' : 'medium',
      protectedByLock: Boolean(match?.textLocked || match?.timingLocked || next.textLocked || next.timingLocked),
    });
  }

  for (const current of original) {
    if (!unused.has(current.id)) continue;
    changes.push({
      id: nanoid(10),
      startMs: current.startMs,
      endMs: current.endMs,
      beforeText: current.text,
      afterText: '',
      beforeStartMs: current.startMs,
      beforeEndMs: current.endMs,
      afterStartMs: current.startMs,
      afterEndMs: current.startMs,
      textChanged: true,
      timingChanged: true,
      timingDeltaMs: current.endMs - current.startMs,
      confidence: 'medium',
      protectedByLock: Boolean(current.textLocked || current.timingLocked),
    });
  }

  return { changes, unchangedCount };
}

interface ProposalCandidate {
  id: string;
  label: string;
  gemini: GeminiTranscript;
  aligned: ReturnType<typeof alignGeminiToTiming>;
  advisoryScore: number;
}

interface GeminiCandidateDraft {
  label: string;
  gemini: GeminiTranscript;
}

interface ProposalBuildOptions {
  strategy: RegenerationStrategy;
  parent?: StoredRegenerationProposal;
  accuracyHint?: string;
  editedText?: string;
  useProposalAsBaseline?: boolean;
}

function captionsText(captions: CaptionSegment[]) {
  return normalizeKhmerDisplayText(captions.map((caption) => caption.text).filter(Boolean).join(' ')).trim();
}

function candidateAdvisoryScore(
  aligned: ReturnType<typeof alignGeminiToTiming>,
  candidateText: string,
  acceptedBaselineText?: string,
) {
  const diagnostics = aligned.diagnostics;
  const lowRatio = diagnostics.totalTokens
    ? diagnostics.lowConfidenceTokens / diagnostics.totalTokens
    : 1;
  const acoustic = diagnostics.alignmentCoverage * 0.55
    + diagnostics.meanAlignmentScore * 0.35
    + Math.max(0, 1 - lowRatio) * 0.10;
  if (!acceptedBaselineText?.trim()) return acoustic;
  const continuity = levenshteinSimilarity(
    normalizeForMatch(candidateText),
    normalizeForMatch(acceptedBaselineText),
  );
  // Accepted continuity is useful evidence but never outweighs poor acoustic alignment.
  return acoustic * 0.92 + continuity * 0.08;
}

function candidateSummary(candidate: ProposalCandidate, selected: boolean): RegenerationCandidateSummary {
  const diagnostics = candidate.aligned.diagnostics;
  return {
    id: candidate.id,
    label: candidate.label,
    text: candidate.gemini.fullText,
    selected,
    model: candidate.gemini.textModel,
    alignmentCoverage: diagnostics.alignmentCoverage,
    meanAlignmentScore: diagnostics.meanAlignmentScore,
    lowConfidenceTokens: diagnostics.lowConfidenceTokens,
    totalTokens: diagnostics.totalTokens,
    advisoryScore: candidate.advisoryScore,
  };
}

async function transcribeGeminiCandidate(
  chunkPath: string,
  context: TranscriptionContext,
  guidance: GeminiTranscriptionGuidance,
  label: string,
): Promise<GeminiCandidateDraft> {
  return {
    label,
    gemini: await transcribeTextWithGemini(chunkPath, context, guidance),
  };
}

async function alignGeminiCandidate(
  draft: GeminiCandidateDraft,
  chunkPath: string,
  candidateDir: string,
  chunkDuration: number,
  context: TranscriptionContext,
  acceptedBaselineText?: string,
): Promise<ProposalCandidate> {
  await fs.mkdir(candidateDir, { recursive: true });
  const timing = await alignTimingLocally(chunkPath, candidateDir, draft.gemini.alignmentText);
  const aligned = alignGeminiToTiming(draft.gemini.fullText, timing, chunkDuration, parseVocabulary(context.vocabulary));
  return {
    id: nanoid(8),
    label: draft.label,
    gemini: draft.gemini,
    aligned,
    advisoryScore: candidateAdvisoryScore(aligned, draft.gemini.fullText, acceptedBaselineText),
  };
}

async function generateGeminiCandidate(
  chunkPath: string,
  candidateDir: string,
  chunkDuration: number,
  context: TranscriptionContext,
  guidance: GeminiTranscriptionGuidance,
  label: string,
  acceptedBaselineText?: string,
): Promise<ProposalCandidate> {
  const draft = await transcribeGeminiCandidate(chunkPath, context, guidance, label);
  return alignGeminiCandidate(draft, chunkPath, candidateDir, chunkDuration, context, acceptedBaselineText);
}

async function generateManualCandidate(
  chunkPath: string,
  candidateDir: string,
  chunkDuration: number,
  context: TranscriptionContext,
  exactText: string,
  project: CaptionProject,
): Promise<ProposalCandidate> {
  await fs.mkdir(candidateDir, { recursive: true });
  const fullText = normalizeKhmerDisplayText(exactText).trim();
  if (!fullText) throw new Error('Type the exact wording you want before choosing Realign exact wording.');
  const timing = await alignTimingLocally(chunkPath, candidateDir, fullText);
  const aligned = alignGeminiToTiming(fullText, timing, chunkDuration, parseVocabulary(context.vocabulary));
  const gemini: GeminiTranscript = {
    language: project.transcript?.language || 'km-KH',
    fullText,
    alignmentText: fullText,
    textModel: 'manual exact wording',
    fallbackUsed: false,
    attempts: 0,
    nativeVocabularyBias: false,
    vocabularyTerms: parseVocabulary(context.vocabulary).map((entry) => entry.canonical),
  };
  return {
    id: nanoid(8),
    label: 'Your exact wording',
    gemini,
    aligned,
    advisoryScore: candidateAdvisoryScore(aligned, fullText, fullText),
  };
}

async function buildRangeRegenerationProposal(
  project: CaptionProject,
  requestedStart: number,
  requestedEnd: number,
  contextValue: unknown,
  options: ProposalBuildOptions,
  progress: ProgressReporter,
) {
  if (!project.transcript?.tokens?.length || !project.transcript.timing) {
    throw new Error('Generate the full transcript before regenerating a selected range.');
  }
  if (options.parent && options.parent.sourceUpdatedAt !== project.updatedAt) {
    throw new Error('The project changed after this proposal was created. Open a fresh regeneration preview so newer edits stay safe.');
  }

  const rawStart = Math.max(0, Math.round(Number(requestedStart)));
  const rawEnd = Math.max(rawStart + 200, Math.round(Number(requestedEnd)));
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) throw new Error('A valid selected time range is required.');

  const workDir = path.join(config.workingDir, `${project.id}-proposal-${nanoid(6)}`);
  try {
    await progress('audio', 8, 'Preparing the selected audio region…');
    const normalized = await ensureNormalizedAudio(project);
    const startMs = Math.min(rawStart, Math.max(0, normalized.durationMs - 200));
    const endMs = Math.min(normalized.durationMs, rawEnd);
    // Gemini benefits from surrounding context, but exact-text forced alignment
    // should not be stretched across unrelated speech before/after the range.
    const contextPaddingMs = options.strategy === 'manual-realign'
      ? Math.min(100, config.rangeContextPaddingMs)
      : config.rangeContextPaddingMs;
    const chunkStart = Math.max(0, startMs - contextPaddingMs);
    const chunkEnd = Math.min(normalized.durationMs, endMs + contextPaddingMs);
    const chunkDuration = Math.max(300, chunkEnd - chunkStart);
    const chunkPath = path.join(workDir, 'selected-range.wav');
    await makeAudioChunk(normalized.outputPath, chunkPath, chunkStart, chunkDuration);

    const context = await resolveRequestedContext(project, contextValue ?? options.parent?.context);
    const parentText = options.parent ? captionsText(options.parent.summary.proposedCaptions) : '';
    const acceptedBaselineText = options.useProposalAsBaseline
      ? normalizeKhmerDisplayText(options.editedText?.trim() || parentText).trim()
      : undefined;
    const passNumber = Math.max(1, (options.parent?.summary.passNumber || 0) + 1);
    const guidanceBase: GeminiTranscriptionGuidance = {
      acceptedBaselineText,
      previousProposalText: parentText || undefined,
      accuracyHint: options.accuracyHint?.trim() || undefined,
      passNumber,
    };

    const candidates: ProposalCandidate[] = [];
    if (options.strategy === 'manual-realign') {
      await progress('alignment', 35, 'Force-aligning your exact wording locally—Gemini is not being called…');
      candidates.push(await generateManualCandidate(
        chunkPath,
        path.join(workDir, 'manual'),
        chunkDuration,
        context,
        options.editedText || '',
        project,
      ));
    } else if (options.strategy === 'deep-verify') {
      await progress('transcription', 20, 'Deep verification: listening two ways in parallel…');
      const specs: Array<{ guidance: GeminiTranscriptionGuidance; label: string }> = [
        { guidance: { ...guidanceBase, variant: 'acoustic' }, label: 'Strict acoustic pass' },
        { guidance: { ...guidanceBase, variant: 'contextual' }, label: 'Context-aware pass' },
      ];
      const settled = await Promise.allSettled(specs.map((spec) =>
        transcribeGeminiCandidate(chunkPath, context, spec.guidance, spec.label)));
      const failures: string[] = [];
      const drafts: GeminiCandidateDraft[] = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') drafts.push(result.value);
        else failures.push(`${specs[index].label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      });
      if (!drafts.length) throw new Error(`Both deep-verification passes failed. ${failures.join(' | ')}`);

      await progress('alignment', 55, 'Comparing independent listens with local timing evidence…');
      const groups = new Map<string, GeminiCandidateDraft[]>();
      for (const draft of drafts) {
        const key = normalizeForMatch(draft.gemini.fullText) || draft.gemini.fullText.trim();
        const group = groups.get(key) || [];
        group.push(draft);
        groups.set(key, group);
      }

      let groupIndex = 0;
      for (const group of groups.values()) {
        const aligned = await alignGeminiCandidate(
          group[0],
          chunkPath,
          path.join(workDir, `candidate-verify-${groupIndex}`),
          chunkDuration,
          context,
          acceptedBaselineText,
        );
        candidates.push(aligned);
        // If both independent listens returned effectively the same wording, keep
        // both evidence labels but do not run the local acoustic alignment twice.
        for (const duplicate of group.slice(1)) {
          candidates.push({
            ...aligned,
            id: nanoid(8),
            label: duplicate.label,
            gemini: duplicate.gemini,
            advisoryScore: candidateAdvisoryScore(aligned.aligned, duplicate.gemini.fullText, acceptedBaselineText),
          });
        }
        groupIndex += 1;
      }
    } else {
      await progress('transcription', 26, options.strategy === 'alternative'
        ? 'Listening again for a genuinely different take…'
        : 'Generating a replacement transcript without touching your current captions…');
      candidates.push(await generateGeminiCandidate(
        chunkPath,
        path.join(workDir, 'candidate-main'),
        chunkDuration,
        context,
        { ...guidanceBase, variant: options.strategy === 'alternative' ? 'alternative' : 'standard' },
        options.strategy === 'alternative' ? 'Alternative take' : 'Initial proposal',
        acceptedBaselineText,
      ));
    }

    await progress('alignment', options.strategy === 'deep-verify' ? 72 : 58, 'Comparing local alignment evidence…');
    candidates.sort((a, b) => b.advisoryScore - a.advisoryScore);
    const selected = candidates[0]!;
    const absoluteTokens = offsetTokens(selected.aligned.tokens, chunkStart, normalized.durationMs);
    const replaced = replaceTimedRange(project.transcript.tokens, absoluteTokens, startMs, endMs);

    await progress('diff', 82, 'Building a live before/after review…');
    const vocabularyTerms = uniqueVocabulary(project.transcript.vocabularyTerms, selected.gemini.vocabularyTerms);
    const originalRange = captionsInRange(project.captions, startMs, endMs);
    const generatedRange = segmentTimedTokens(replaced.inserted, {
      mode: project.mode,
      protectedPhrases: vocabularyTerms,
    });
    const proposedRange = preserveCaptionLocks(originalRange, generatedRange);
    const outside = project.captions.filter((caption) => caption.endMs <= startMs || caption.startMs >= endMs);
    const proposedCaptions = [...outside, ...proposedRange].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const proposedTranscript = {
      ...project.transcript,
      language: selected.gemini.language || project.transcript.language,
      fullText: transcriptText(replaced.tokens),
      textModel: selected.gemini.textModel,
      textModelFallback: selected.gemini.fallbackUsed,
      nativeVocabularyBias: selected.gemini.nativeVocabularyBias,
      vocabularyTerms,
      tokens: replaced.tokens,
      segments: segmentTimedTokens(replaced.tokens, { mode: 'single-line', protectedPhrases: vocabularyTerms }),
      timing: rebuildDiagnostics(replaced.tokens, project.transcript.timing, normalized.durationMs),
    };
    const { changes, unchangedCount } = buildDiff(originalRange, proposedRange);
    const now = new Date();
    const summary: RegenerationProposal = {
      id: nanoid(14),
      projectId: project.id,
      projectTitle: project.title,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
      startMs,
      endMs,
      lockedCaptionsPreserved: originalRange.filter((caption) => caption.textLocked || caption.timingLocked).length,
      unchangedCount,
      changes,
      currentCaptions: originalRange,
      proposedCaptions: proposedRange,
      passNumber,
      strategy: options.strategy,
      parentProposalId: options.parent?.summary.id,
      acceptedBaselineText,
      accuracyHint: options.accuracyHint?.trim() || undefined,
      candidates: candidates.map((candidate) => candidateSummary(candidate, candidate.id === selected.id)),
      selectedCandidateReason: candidates.length > 1
        ? 'Selected using local alignment coverage, alignment score, low-confidence rate, and a small continuity bonus for user-accepted wording. This ranking is advisory—not proof of semantic correctness.'
        : options.strategy === 'manual-realign'
          ? 'Your exact wording was preserved and only its timing was aligned locally.'
          : undefined,
    };
    const stored: StoredRegenerationProposal = {
      summary,
      sourceUpdatedAt: project.updatedAt,
      originalCaptions: project.captions,
      proposedCaptions,
      proposedTokens: replaced.tokens,
      proposedTranscript,
      proposedTiming: proposedTranscript.timing!,
      context,
    };
    await proposalStore.save(stored);
    await progress('complete', 100, 'Regeneration proposal is ready for live A/B review.');
    return summary;
  } finally {
    await removeWorkingDir(workDir).catch(() => {});
  }
}

export async function createRangeRegenerationProposal(
  projectId: string,
  requestedStart: number,
  requestedEnd: number,
  contextValue: unknown,
  progress: ProgressReporter = () => {},
) {
  const project = await store.get(projectId);
  if (!project) throw new Error('Project not found');
  return buildRangeRegenerationProposal(
    project,
    requestedStart,
    requestedEnd,
    contextValue,
    { strategy: 'standard' },
    progress,
  );
}

export async function refineRegenerationProposal(
  projectId: string,
  proposalId: string,
  input: RegenerationRefinementInput,
  progress: ProgressReporter = () => {},
) {
  const project = await store.get(projectId);
  if (!project) throw new Error('Project not found');
  const parent = await proposalStore.get(proposalId);
  if (!parent || parent.summary.projectId !== project.id) throw new Error('The proposal expired or could not be found. Generate a fresh preview.');
  if (!['alternative', 'deep-verify', 'manual-realign'].includes(input.strategy)) throw new Error('Unsupported refinement strategy.');
  return buildRangeRegenerationProposal(
    project,
    parent.summary.startMs,
    parent.summary.endMs,
    parent.context,
    {
      strategy: input.strategy,
      parent,
      accuracyHint: input.accuracyHint,
      editedText: input.editedText,
      useProposalAsBaseline: input.useProposalAsBaseline,
    },
    progress,
  );
}

function redistributeText(text: string, slots: CaptionSegment[]) {
  const tokens = tokenizeText(text);
  if (!slots.length) return [];
  if (!tokens.length) return slots.map(() => '');
  const totalDuration = slots.reduce((sum, slot) => sum + Math.max(1, slot.endMs - slot.startMs), 0);
  let tokenIndex = 0;
  let cumulativeDuration = 0;
  return slots.map((slot, slotIndex) => {
    if (slotIndex === slots.length - 1) return joinTokens(tokens.slice(tokenIndex));
    cumulativeDuration += Math.max(1, slot.endMs - slot.startMs);
    const desiredEnd = Math.max(tokenIndex + 1, Math.round(tokens.length * cumulativeDuration / totalDuration));
    const slice = tokens.slice(tokenIndex, Math.min(tokens.length, desiredEnd));
    tokenIndex += slice.length;
    return joinTokens(slice);
  });
}

export async function applyRegenerationProposal(
  projectId: string,
  proposalId: string,
  mode: RegenerationApplyMode,
  editedText?: string,
) {
  const project = await store.get(projectId);
  if (!project) throw new Error('Project not found');
  const proposal = await proposalStore.get(proposalId);
  if (!proposal || proposal.summary.projectId !== project.id) throw new Error('Regeneration proposal expired or was not found.');
  if (mode === 'reject') {
    await proposalStore.remove(proposalId);
    return project;
  }
  if (proposal.sourceUpdatedAt !== project.updatedAt) {
    throw new Error('The project changed after this preview was created. Generate a fresh preview so newer edits are not overwritten.');
  }

  await historyStore.checkpoint(project, `Before applying regeneration (${mode})`, 'regeneration');
  const { startMs, endMs } = proposal.summary;
  const originalRange = captionsInRange(project.captions, startMs, endMs);
  const proposedRange = captionsInRange(proposal.proposedCaptions, startMs, endMs);
  const outside = project.captions.filter((caption) => caption.endMs <= startMs || caption.startMs >= endMs);
  let acceptedRange: CaptionSegment[];
  const normalizedEditedText = normalizeKhmerDisplayText(editedText || '').trim();

  if (mode === 'all') {
    acceptedRange = proposedRange;
    project.transcript = proposal.proposedTranscript;
    project.transcriptNeedsSync = false;
    if (normalizedEditedText) {
      const alignedProposalText = normalizeKhmerDisplayText(proposedRange.map((caption) => caption.text).join(' ')).trim();
      const texts = redistributeText(normalizedEditedText, acceptedRange);
      acceptedRange = acceptedRange.map((caption, index) => caption.textLocked ? caption : {
        ...caption,
        text: texts[index] || caption.text,
        approved: false,
      });
      // The exact manual text is safe in captions, but canonical token regrouping
      // should not pretend it has been word-aligned unless the user chose Realign exact wording.
      project.transcriptNeedsSync = normalizedEditedText !== alignedProposalText;
    }
  } else if (mode === 'text-only') {
    const sourceText = normalizedEditedText || proposedRange.map((caption) => caption.text).join(' ');
    const texts = redistributeText(sourceText, originalRange);
    acceptedRange = originalRange.map((caption, index) => caption.textLocked ? caption : {
      ...caption,
      text: texts[index] || caption.text,
      approved: false,
    });
    project.transcriptNeedsSync = true;
  } else {
    const texts = redistributeText(originalRange.map((caption) => caption.text).join(' '), proposedRange);
    acceptedRange = proposedRange.map((caption, index) => {
      const original = originalRange[index];
      return {
        ...caption,
        id: original?.id || caption.id,
        text: original?.textLocked ? original.text : texts[index] || original?.text || caption.text,
        textLocked: original?.textLocked,
        timingLocked: original?.timingLocked,
        approved: false,
      };
    });
    acceptedRange = preserveCaptionLocks(originalRange, acceptedRange);
    project.transcriptNeedsSync = true;
  }

  project.captions = [...outside, ...acceptedRange].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  project.transcriptionContext = proposal.context;
  project.pipelineCache = { ...project.pipelineCache, lastRangeRegeneratedAt: new Date().toISOString() } as CaptionProject['pipelineCache'];
  project.engineVersion = '0.7.10';
  project.updatedAt = new Date().toISOString();
  await store.upsert(project);
  await proposalStore.remove(proposalId);
  return project;
}

function nearestTokenBoundary(tokens: NonNullable<CaptionProject['transcript']>['tokens'], value: number, tolerance: number, edge: 'start' | 'end') {
  if (!tokens?.length) return value;
  let nearest = value;
  let distance = tolerance + 1;
  for (const token of tokens) {
    const candidate = edge === 'start' ? token.startMs : token.endMs;
    const d = Math.abs(candidate - value);
    if (d < distance) { distance = d; nearest = candidate; }
  }
  return distance <= tolerance ? nearest : value;
}

export async function postprocessProjectTiming(projectId: string, settings: QaProfileSettings) {
  const project = await store.get(projectId);
  if (!project) throw new Error('Project not found');
  if (!project.captions.length) throw new Error('There are no captions to process.');
  await historyStore.checkpoint(project, `Before timing cleanup: ${settings.name}`, 'timing-fix');
  const tokens = project.transcript?.tokens;
  const mediaLimit = project.transcript?.timing?.audioDurationMs ?? Number.POSITIVE_INFINITY;
  const captions = project.captions.map((caption) => ({ ...caption })).sort((a, b) => a.startMs - b.startMs);

  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index];
    if (caption.timingLocked) continue;
    let start = nearestTokenBoundary(tokens, caption.startMs, settings.snapToleranceMs, 'start');
    let end = nearestTokenBoundary(tokens, caption.endMs, settings.snapToleranceMs, 'end');
    const previous = captions[index - 1];
    const next = captions[index + 1];
    const previousLimit = previous ? previous.endMs + settings.minGapMs : 0;
    const nextLimit = Math.min(next ? next.startMs - settings.minGapMs : mediaLimit, mediaLimit);

    // When locked/overlapping neighbours leave no legal room, do not invent a
    // new overlap. Preserve the current caption and let QA explain the conflict.
    if (nextLimit <= previousLimit + 40) continue;

    start = Math.max(previousLimit, Math.min(nextLimit - 40, start - settings.leadInMs));
    end = Math.min(nextLimit, Math.max(start + 40, end + settings.leadOutMs));
    if (end - start < settings.minDurationMs) {
      const missing = settings.minDurationMs - (end - start);
      const extendLeft = Math.min(missing / 2, Math.max(0, start - previousLimit));
      start -= extendLeft;
      end = Math.min(nextLimit, end + (missing - extendLeft));
    }
    if (end - start > settings.maxDurationMs) end = Math.min(nextLimit, start + settings.maxDurationMs);
    if (end <= start + 40) continue;
    caption.startMs = Math.max(0, Math.round(start));
    caption.endMs = Math.min(Math.round(end), Number.isFinite(mediaLimit) ? Math.round(mediaLimit) : Math.round(end));
    caption.timingSource = 'manual';
    caption.timingQuality = caption.timingQuality === 'low' ? 'medium' : caption.timingQuality || 'medium';
    caption.approved = false;
  }

  project.captions = captions;
  project.engineVersion = '0.7.10';
  project.updatedAt = new Date().toISOString();
  await store.upsert(project);
  return project;
}
