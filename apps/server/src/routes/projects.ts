import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { hasWordTimingEvidence, reconcileCaptionWordTiming, resolveCaptionWordTiming, validateMarkedWordTiming,
  type CaptionProject, type CaptionSegment, type CaptionMode, type CaptionWord, type QaProfileSettings, type RegenerationApplyMode } from '@kcs/shared';
import { config } from '../config.js';
import { ProjectDeletionBlockedError, store } from '../services/store.js';
import { profileStore } from '../services/profile-store.js';
import { createProjectFromUpload, ProjectCreationError } from '../services/project-creation.js';
import { contributionStore } from '../services/contribution-store.js';
import { analyticsBuckets, captureAnalytics } from '../services/analytics.js';
import { ensureNormalizedAudio, invalidateProjectCache } from '../services/cache.js';
import { MediaPreviewError, withMediaPreviewDrain } from '../services/media-preview.js';
import { requireTimedTokens, segmentTimedTokens } from '../services/segmenter.js';
import { toSrt } from '../services/srt.js';
import { recordExportEvidence } from '../services/export-evidence.js';
import { normalizeTranscriptionContext } from '../services/vocabulary.js';
import { normalizeKhmerDisplayText, normalizeKhmerTokenSpacing } from '../services/tokenizer.js';
import { transcriptText } from '../services/transcript.js';
import { preserveCaptionLocks } from '../services/caption-locks.js';
import {
  applyRegenerationProposal,
  createRangeRegenerationProposal,
  refineRegenerationProposal,
  postprocessProjectTiming,
  StaleProjectMediaError,
  StaleProjectRevisionError,
  transcribeProject,
} from '../services/project-processing.js';
import { historyStore } from '../services/history-store.js';
import { proposalStore } from '../services/proposal-store.js';
import { jobAdmission, JobAdmissionError } from '../services/job-admission.js';
import { jobStore } from '../services/job-store.js';
import { isCaptionGenerationModel } from '../services/generation-settings.js';
import { MediaCompatibilityError } from '../services/media-compatibility.js';
import { assertRetainedTimingCanBeDerived, MediaAlignmentUnverifiedError } from '../services/media-alignment.js';
import {
  replaceProjectMedia, restoreProjectMedia, listMediaReplacements, discardMediaReplacement, clearRetiredMediaSources,
  MediaReplacementError, type MediaReplacementMode,
} from '../services/media-replacement.js';
import {
  CaptionWordTimingBusyError,
  CaptionWordTimingConflictError,
  CaptionWordTimingInputError,
  CaptionWordTimingNotFoundError,
  syncCaptionWordsLocally,
} from '../services/caption-word-timing.js';
import {
  applyCaptionWordBatch,
  applyPreparedWordHighlightBatch,
  readWordHighlightPublication,
  updateWordHighlightFollow,
  CaptionWordBatchConflictError,
  CaptionWordBatchInputError,
  CaptionWordBatchNotFoundError,
  PreparedWordHighlightConflictError,
} from '../services/caption-word-batch.js';
import { LocalTimingUnavailableError } from '../services/local-timing.js';
import { wordHighlightCandidateStore } from '../services/word-highlight-candidate-store.js';
import {
  wordHighlightEngine, wordHighlightEngineVersion, WordHighlightProjectError,
} from '../services/word-highlight-engine.js';

await fs.mkdir(config.uploadDir, { recursive: true });
await fs.mkdir(config.exportDir, { recursive: true });
await fs.mkdir(config.workingDir, { recursive: true });
await fs.mkdir(config.cacheDir, { recursive: true });
await fs.mkdir(config.historyDir, { recursive: true });
await fs.mkdir(config.proposalDir, { recursive: true });
await proposalStore.cleanup();

const upload = multer({
  dest: config.uploadDir,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});
const incomingCreationFiles = new WeakMap<Parameters<RequestHandler>[0], Express.Multer.File[]>();
const projectUpload = multer({
  dest: config.uploadDir,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter(req, file, accept) {
    // Retain only the storage-owned objects for this request. Disk storage adds
    // path later; a stream error may leave it outside Multer's completed list.
    incomingCreationFiles.get(req)?.push(file);
    accept(null, true);
  },
});
/** Only this transfer's known input rejections prove that creation was not
 * entered. They cannot settle an earlier unconfirmed request with the same ID. */
const receiveProjectUpload: RequestHandler = (req, res, next) => {
  incomingCreationFiles.set(req, []);
  projectUpload.single('media')(req, res, async (error: unknown) => {
    const incoming = incomingCreationFiles.get(req) || [];
    incomingCreationFiles.delete(req);
    if (error || req.aborted || res.destroyed || res.writableEnded) {
      // Multer drains and cleans ordinary rejection/abort paths first. Also
      // remove a failed storage stream's owned partial, never published media.
      await Promise.all(incoming.map(async (file) => {
        if (typeof file.path === 'string' && path.dirname(file.path) === config.uploadDir) {
          await fs.rm(file.path, { force: true }).catch(() => {});
        }
      }));
    }
    // A disconnected request must not enter creation or manufacture a receipt.
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (!error) { next(); return; }
    if (error instanceof multer.MulterError) {
      let message = '';
      if (error.code === 'LIMIT_FILE_SIZE') {
        const maximum = config.maxUploadMb >= 1
          ? `${config.maxUploadMb.toLocaleString('en-US')} MB`
          : `${Math.floor(config.maxUploadMb * 1024 * 1024).toLocaleString('en-US')} bytes`;
        message = `This file is too large to import. Choose a video or audio file up to ${maximum}.`;
      } else if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
        message = 'Choose one video or audio file at a time, then start another upload.';
      } else if (['LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT', 'LIMIT_PART_COUNT',
        'MISSING_FIELD_NAME', 'INVALID_FIELD_NAME', 'LIMIT_FIELD_NESTING', 'LIMIT_FIELD_ARRAY_INDEX'].includes(error.code)) {
        message = 'The upload details could not be read. Choose the file again and start another upload.';
      }
      if (message) {
        res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
          error: message, code: 'PROJECT_CREATE_NOT_APPLIED', outcome: 'not-created', retryable: false,
        });
        return;
      }
    }
    // Parser, storage and transport failures are not creation receipts. Keep their
    // outcome conservative, without exposing parser input or filesystem details.
    res.status(500).json({ error: 'Studio could not confirm whether this upload was saved. Check the saved result before trying again.',
      code: 'PROJECT_CREATE_UNCONFIRMED', outcome: 'unknown' });
  });
};
const router = Router();

/** Hold admission through response preparation and persisted compatibility results. */
function admitProcessing(handler: RequestHandler<Record<string, string>>): RequestHandler<Record<string, string>> {
  return async (req, res, next) => {
    try { await jobAdmission.runForProject(req.params.id, async () => {
      const expected = expectedMedia(req.body?.expectedMedia);
      if (!expected) { res.status(428).json({ error: 'Processing requires the media version it was requested against.' }); return; }
      const current = await store.getMedia(req.params.id);
      if (!current) { res.status(404).json({ error: 'Project not found' }); return; }
      if (current.media.filename !== expected.filename || current.media.size !== expected.size) {
        res.status(409).json({ error: 'The project media changed. Reload before starting processing.' }); return;
      }
      await handler(req, res, next);
    }); }
    catch (error) {
      if (error instanceof JobAdmissionError) { res.status(409).json({ error: error.message }); return; }
      next(error);
    }
  };
}


function expectedMedia(value: unknown): Pick<CaptionProject['media'], 'filename' | 'size'> | null {
  const candidate = value as { filename?: unknown; size?: unknown } | null | undefined;
  return candidate && typeof candidate.filename === 'string' && Number.isFinite(candidate.size)
    ? { filename: candidate.filename, size: Number(candidate.size) }
    : null;
}

function sanitizeCaptionWordTiming(caption: CaptionSegment): CaptionSegment {
  if (!caption.wordTiming) return caption;
  const valid = hasWordTimingEvidence(caption.wordTiming)
    ? validateMarkedWordTiming(caption.text, caption.wordTiming).ok
    : resolveCaptionWordTiming(caption).state !== 'stale';
  if (valid) return caption;
  const { wordTiming: _wordTiming, ...safe } = caption;
  return safe;
}

/** Caption saves can accept marked evidence that is partial but structurally sound. */
function sanitizeSavedCaptionWordTiming(
  caption: CaptionSegment, durationMs: number | undefined, retainedTailWords: Set<string>,
): CaptionSegment | null {
  const timing = caption.wordTiming;
  if (!timing || !hasWordTimingEvidence(timing)) return sanitizeCaptionWordTiming(caption);
  if (typeof timing.text === 'string' && timing.text !== caption.text) {
    const { wordTiming: _wordTiming, ...safe } = caption;
    return safe;
  }
  let validated = validateMarkedWordTiming(caption.text, timing, durationMs);
  if (!validated.ok && durationMs !== undefined && retainedTailWords.size) {
    // WAV duration metadata rounds to milliseconds; an already saved sample-clock
    // interval can extend into that fraction. Do not admit any new raw bound there.
    const exact = validateMarkedWordTiming(caption.text, timing, durationMs + 0.5);
    if (exact.ok && exact.timing.words.every((word) =>
      word.endMs === null || word.endMs <= durationMs || retainedTailWords.has(tailWordIdentity(caption.text, word)))) validated = exact;
  }
  return validated.ok ? { ...caption, wordTiming: validated.timing } : null;
}

function tailWordIdentity(text: string, word: CaptionWord) {
  return JSON.stringify([text.slice(word.startOffset, word.endOffset), word.startMs, word.endMs, word.source, word.method]);
}

// Opt-in projection preserves the existing full-project API for other callers.
router.get('/', async (req, res) => res.json(req.query.summary === '1' ? await store.listSummaries() : await store.list()));
router.get('/:id', async (req, res) => {
  const item = await store.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Project not found' });
  res.json(item);
});

router.get('/:id/appearance', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const item = await store.getAppearance(req.params.id);
  if (!item) return res.status(404).json({ error: 'Project not found' });
  res.json(item);
});

router.post('/', receiveProjectUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a video or audio file.', code: 'PROJECT_CREATE_NOT_APPLIED' });
    const result = await createProjectFromUpload(req.file, req.body || {});
    if (!result.reused) void captureAnalytics('project_created');
    res.status(result.reused ? 200 : 201).json({ ...result.project,
      creation: { attemptId: result.project.id, reused: result.reused, orderSaved: result.orderSaved } });
  } catch (error) {
    if (error instanceof ProjectCreationError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, outcome: error.outcome });
    res.status(500).json({ error: 'Studio could not confirm whether the upload was saved.', code: 'PROJECT_CREATE_UNCONFIRMED' });
  }
});

function mediaReplacementOptions(body: Record<string, unknown> | undefined) {
  let media: unknown = body?.expectedMedia;
  if (typeof media === 'string') {
    try { media = JSON.parse(media); } catch { media = null; }
  }
  return {
    mode: body?.mode as MediaReplacementMode | undefined,
    expectedMedia: expectedMedia(media) || undefined,
    expectedUpdatedAt: typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : undefined,
    audioChangeConfirmation: typeof body?.audioChangeConfirmation === 'string' ? body.audioChangeConfirmation : undefined,
  };
}

function mediaReplacementFailure(res: Parameters<RequestHandler>[1], error: unknown) {
  if (error instanceof MediaReplacementError || error instanceof MediaCompatibilityError) {
    return res.status(error.httpStatus).json({ error: error.message, code: error.code,
      ...(error instanceof MediaReplacementError && error.preserveAudioConfirmation ? { preserveAudioConfirmation: error.preserveAudioConfirmation } : {}) });
  }
  if (error instanceof JobAdmissionError) return res.status(409).json({ error: error.message, code: 'MEDIA_PROJECT_BUSY' });
  console.error('[media replacement] Local transaction failed:', error);
  return res.status(500).json({ error: 'Media replacement could not finish. Your previous project and media were kept. Check free disk space and try again.', code: 'MEDIA_REPLACEMENT_FAILED' });
}

router.post('/:id/replace-media', upload.single('media'), async (req, res) => {
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(); };
  req.once('aborted', cancel);
  res.once('close', cancel);
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a replacement video or audio file.', code: 'MEDIA_REPLACEMENT_INPUT' });
    res.json(await replaceProjectMedia(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, req.file, { ...mediaReplacementOptions(req.body), signal: abort.signal }));
  } catch (error) {
    return mediaReplacementFailure(res, error);
  } finally {
    req.off('aborted', cancel);
    res.off('close', cancel);
    if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
});

router.get('/:id/media-replacements', async (req, res) => {
  try { res.json(await listMediaReplacements(req.params.id)); }
  catch (error) { return mediaReplacementFailure(res, error); }
});

router.post('/:id/media-replacements/:replacementId/restore', async (req, res) => {
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(); };
  req.once('aborted', cancel);
  res.once('close', cancel);
  try {
    res.json(await restoreProjectMedia(req.params.id, req.params.replacementId, { ...mediaReplacementOptions(req.body), signal: abort.signal }));
  } catch (error) { return mediaReplacementFailure(res, error); }
  finally { req.off('aborted', cancel); res.off('close', cancel); }
});

router.delete('/:id/media-replacements/:replacementId', async (req, res) => {
  try {
    await discardMediaReplacement(req.params.id, req.params.replacementId, mediaReplacementOptions(req.body));
    res.status(204).end();
  } catch (error) { return mediaReplacementFailure(res, error); }
});

/** Compatibility endpoint. v0.7 UI normally uses the persistent background job API. */
router.post('/:id/transcribe', admitProcessing(async (req, res) => {
  try {
    res.json(await transcribeProject(req.params.id, req.body?.transcriptionContext, req.body?.force === true));
  } catch (error) {
    console.error('Local hybrid transcription failed:', error);
    if (error instanceof StaleProjectMediaError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Local hybrid transcription failed' });
  }
}));

/** Compatibility endpoint: create a preview and immediately accept it. */
router.post('/:id/regenerate-range', admitProcessing(async (req, res) => {
  try {
    const proposal = await createRangeRegenerationProposal(
      req.params.id,
      Number(req.body?.startMs),
      Number(req.body?.endMs),
      req.body?.transcriptionContext,
    );
    res.json(await applyRegenerationProposal(req.params.id, proposal.id, 'all'));
  } catch (error) {
    console.error('Selected-range regeneration failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Selected-range regeneration failed' });
  }
}));

router.get('/:id/regeneration-proposals/:proposalId', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const proposal = await proposalStore.get(req.params.proposalId);
  if (!proposal || proposal.summary.projectId !== project.id || proposal.sourceUpdatedAt !== project.updatedAt) {
    return res.status(404).json({ error: 'Proposal expired or not found' });
  }
  res.json(proposal.summary);
});

router.post('/:id/regeneration-proposals/:proposalId/apply', async (req, res) => {
  try {
    const mode = String(req.body?.mode || 'all') as RegenerationApplyMode;
    if (!['all', 'text-only', 'timing-only', 'reject'].includes(mode)) return res.status(400).json({ error: 'Invalid apply mode' });
    res.json(await applyRegenerationProposal(req.params.id, req.params.proposalId, mode, typeof req.body?.editedText === 'string' ? req.body.editedText : undefined));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not apply regeneration proposal' });
  }
});

/** Compatibility endpoint. The UI normally queues proposal refinement through /api/jobs. */
router.post('/:id/regeneration-proposals/:proposalId/refine', admitProcessing(async (req, res) => {
  try {
    res.json(await refineRegenerationProposal(req.params.id, req.params.proposalId, {
      strategy: req.body?.strategy,
      accuracyHint: typeof req.body?.accuracyHint === 'string' ? req.body.accuracyHint : undefined,
      editedText: typeof req.body?.editedText === 'string' ? req.body.editedText : undefined,
      useProposalAsBaseline: req.body?.useProposalAsBaseline === true,
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not refine regeneration proposal' });
  }
}));

router.get('/:id/normalized-audio.wav', async (req, res, next) => {
  try {
    await jobAdmission.runForProject(req.params.id, async () => {
    const project = await store.getMedia(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const force = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const normalized = await ensureNormalizedAudio(project, { force });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', 'inline; filename="sthang-waveform.wav"');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Sthang-Audio-Cache', normalized.cacheHit ? 'hit' : force ? 'rebuilt' : 'generated');
    // Scope delivery to this project's cache. An absolute path makes Express
    // reject legitimate dot-prefixed ancestors such as .sthang-worktrees.
    res.sendFile(path.basename(normalized.outputPath), { root: normalized.dir, dotfiles: 'deny' }, (error) => {
      if (!error) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      next(error);
    });
    });
  } catch (error) {
    if (error instanceof JobAdmissionError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not prepare waveform audio' });
  }
});

router.get('/:id/history', async (req, res) => {
  const current = await store.getMedia(req.params.id);
  if (!current) return res.status(404).json({ error: 'Project not found' });
  res.json(await historyStore.list(current.id, current.media));
});

interface CaptionWordTimingRouteDependencies {
  hasActiveCaptionJobForProject(projectId: string): boolean;
  syncCaptionWords: typeof syncCaptionWordsLocally;
}

export function createCaptionWordTimingHandler(dependencies: CaptionWordTimingRouteDependencies = {
  hasActiveCaptionJobForProject: (projectId) => jobStore.hasActiveCaptionJobForProject(projectId),
  syncCaptionWords: syncCaptionWordsLocally,
}): RequestHandler {
  return async (req, res) => {
    const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!projectId) {
      res.status(400).json({ error: 'Project id is required for word timing.' });
      return;
    }
    const preparedFor = expectedMedia(req.body?.expectedMedia);
    if (!preparedFor) {
      res.status(428).json({ error: 'Word timing requires the media version the caption was edited against.' });
      return;
    }
    const caption = req.body?.caption as CaptionSegment | null | undefined;
    if (!caption || typeof caption !== 'object') {
      res.status(400).json({ error: 'A caption is required for word timing.' });
      return;
    }
    if (dependencies.hasActiveCaptionJobForProject(projectId)) {
      res.status(409).json({ code: 'WORD_TIMING_PROJECT_BUSY', error: 'Finish or cancel the active caption processing job before syncing spoken-word timing.' });
      return;
    }
    try {
      res.json(await jobAdmission.runForProject(projectId, () =>
        dependencies.syncCaptionWords(projectId, caption, preparedFor, undefined, req.body?.suggestEdges === true)));
    } catch (error) {
      if (error instanceof JobAdmissionError) { res.status(409).json({ code: 'WORD_TIMING_PROJECT_BUSY', error: error.message }); return; }
      if (error instanceof CaptionWordTimingNotFoundError) { res.status(404).json({ error: error.message }); return; }
      if (error instanceof CaptionWordTimingBusyError) { res.status(429).json({ error: error.message }); return; }
      if (error instanceof CaptionWordTimingConflictError) { res.status(409).json({ error: error.message }); return; }
      if (error instanceof CaptionWordTimingInputError) { res.status(400).json({ error: error.message }); return; }
      console.error('[word timing] Local synchronization failed:', error);
      res.status(503).json({ code: 'WORD_TIMING_UNAVAILABLE', error: 'Word timing is unavailable right now. Check local timing in Settings → System check, then sync remaining captions. Your current timing was kept.' });
    }
  };
}

router.post('/:id/caption-word-timing', createCaptionWordTimingHandler());

const maximumWordHighlightRequestBytes = 16 * 1024;
let wordHighlightQueue: Promise<unknown> = Promise.resolve();

function enqueueWordHighlight<T>(operation: () => Promise<T>): Promise<T> {
  const pending = wordHighlightQueue.then(operation);
  wordHighlightQueue = pending.catch(() => {});
  return pending;
}

interface WordHighlightRouteDependencies {
  engine: typeof wordHighlightEngine;
  candidateStore: typeof wordHighlightCandidateStore;
  hasActiveCaptionJobForProject: (projectId: string) => boolean;
}

const defaultWordHighlightRouteDependencies: WordHighlightRouteDependencies = {
  engine: wordHighlightEngine,
  candidateStore: wordHighlightCandidateStore,
  hasActiveCaptionJobForProject: (id) => jobStore.hasActiveCaptionJobForProject(id),
};

export function createWordHighlightHandler(
  action: 'prepare' | 'candidates', dependencies: WordHighlightRouteDependencies = defaultWordHighlightRouteDependencies,
): RequestHandler {
  return async (req, res) => {
    const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!projectId) {
      res.status(400).json({ error: 'Project id is required for word timing.' });
      return;
    }
    if (Number(req.headers['content-length']) > maximumWordHighlightRequestBytes
      || Buffer.byteLength(JSON.stringify(req.body ?? {})) > maximumWordHighlightRequestBytes) {
      res.status(413).json({ error: 'The word timing request is too large.' });
      return;
    }
    const expected = expectedMedia(req.body?.expectedMedia);
    if (!expected) {
      res.status(428).json({ error: 'Word timing requires the current source media version.' });
      return;
    }
    const ids: unknown = req.body?.ids;
    if (action === 'candidates' && (!Array.isArray(ids) || ids.length < 1 || ids.length > 32
      || !ids.every((id: unknown) => typeof id === 'string' && id.trim() && id.length <= 128)
      || new Set(ids).size !== ids.length)) {
      res.status(400).json({ error: 'Provide between 1 and 32 distinct caption ids.' });
      return;
    }
    const checkCaptionJob = () => {
      if (dependencies.hasActiveCaptionJobForProject(projectId)) {
        throw new JobAdmissionError('Finish or cancel the active caption processing job before preparing word timing.');
      }
    };
    try {
      checkCaptionJob();
      const response = await jobAdmission.runForProject(projectId, () => enqueueWordHighlight(async () => {
        checkCaptionJob();
        if (action === 'prepare') return dependencies.engine.prepare(projectId, expected);
        const { mediaFingerprint, results } = await dependencies.engine.candidates(projectId, expected, ids as string[]);
        return {
          engine: wordHighlightEngineVersion,
          results: results.map((result) => {
            const {
              track, dependencies: revisions, inputRevisions, basis, consulted, overlapping, planDurationMs, evidenceDurationMs, beforeTrack,
            } = result;
            if (result.status !== 'candidate' || !track || !revisions || !inputRevisions || !basis
              || !consulted || !overlapping || planDurationMs === undefined || evidenceDurationMs === undefined
              || beforeTrack === undefined) return result;
            const preparedKey = dependencies.candidateStore.put({
              projectId, mediaFingerprint, captionId: result.id,
              basis, dependencies: revisions, inputRevisions, consulted, overlapping, planDurationMs, evidenceDurationMs, beforeTrack, track,
            });
            return preparedKey ? { ...result, preparedKey } : result;
          }),
        };
      }));
      res.json(response);
    } catch (error) {
      if (error instanceof JobAdmissionError) { res.status(409).json({ code: 'WORD_TIMING_PROJECT_BUSY', error: error.message }); return; }
      if (error instanceof WordHighlightProjectError) { res.status(error.status).json({ error: error.message }); return; }
      if (error instanceof LocalTimingUnavailableError) {
        res.status(503).json({ code: 'WORD_TIMING_UNAVAILABLE', error: error.message });
        return;
      }
      res.status(500).json({ error: 'Could not prepare local word timing.' });
    }
  };
}

router.post('/:id/caption-word-timing/prepare', createWordHighlightHandler('prepare'));
router.post('/:id/caption-word-timing/candidates', createWordHighlightHandler('candidates'));

router.get('/:id/caption-word-timing/publication/:requestId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { filename, size } = req.query;
  const expected = expectedMedia({ filename, size: typeof size === 'string' && size.trim() ? Number(size) : undefined });
  if (!expected) return res.status(428).json({ error: 'Word highlighting requires the current source media version.' });
  try {
    return res.json(await readWordHighlightPublication(req.params.id, expected, req.params.requestId));
  } catch (error) {
    if (error instanceof CaptionWordBatchNotFoundError) return res.status(404).json({ error: error.message });
    if (error instanceof CaptionWordBatchInputError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Could not check the word highlight publication.' });
  }
});

router.put('/:id/word-highlight-follow', async (req, res) => {
  const expected = expectedMedia(req.body?.expectedMedia);
  if (!expected) return res.status(428).json({ error: 'Word highlighting requires the current source media version.' });
  try {
    res.json(await updateWordHighlightFollow(req.params.id, expected, req.body?.action, req.body?.epoch));
  } catch (error) {
    if (error instanceof PreparedWordHighlightConflictError) return res.status(409).json({ error: error.message, ...error.details });
    if (error instanceof CaptionWordBatchNotFoundError) return res.status(404).json({ error: error.message });
    if (error instanceof CaptionWordBatchInputError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Could not save the word highlight setting.' });
  }
});

router.post('/:id/caption-word-timing/batch-apply', async (req, res) => {
  const preparedFor = expectedMedia(req.body?.expectedMedia);
  if (!preparedFor) {
    return res.status(428).json({ error: 'Word timing batch apply requires the media version it was prepared against.' });
  }
  const prepared = req.body?.mode === 'prepared';
  const checkCaptionJob = () => {
    if (jobStore.hasActiveCaptionJobForProject(req.params.id)) {
      throw new JobAdmissionError('Finish or cancel the active caption processing job before applying prepared word timings.');
    }
  };
  try {
    checkCaptionJob();
    res.json(await jobAdmission.runForProject(req.params.id, () => {
      checkCaptionJob();
      return prepared
        ? applyPreparedWordHighlightBatch(req.params.id, preparedFor, req.body)
        : applyCaptionWordBatch(req.params.id, preparedFor, req.body?.changes, req.body?.action, undefined, req.body?.intent);
    }));
  } catch (error) {
    if (error instanceof JobAdmissionError) {
      return res.status(409).json({ error: error.message, ...(prepared ? { code: 'WORD_TIMING_PROJECT_BUSY' } : {}) });
    }
    if (error instanceof PreparedWordHighlightConflictError) return res.status(409).json({ error: error.message, ...error.details });
    if (error instanceof CaptionWordBatchNotFoundError) return res.status(404).json({ error: error.message });
    if (error instanceof CaptionWordBatchConflictError) return res.status(409).json({ error: error.message });
    if (error instanceof CaptionWordBatchInputError) return res.status(400).json({ error: error.message });
    console.error('[word timing] Batch apply failed.');
    return res.status(500).json({ error: 'Could not apply the prepared word timings. Your current captions were kept.' });
  }
});

router.post('/:id/history/:historyId/restore', async (req, res) => {
  const expected = expectedMedia(req.body?.expectedMedia);
  if (!expected) return res.status(428).json({ error: 'History restore requires the media version it was prepared against.' });
  try {
    const result = await store.withProjectWrite(req.params.id, async (current, persist) => {
      if (!current) return { status: 'missing-project' as const };
      if (current.media.filename !== expected.filename || current.media.size !== expected.size) return { status: 'stale' as const };
      const entry = await historyStore.get(current.id, req.params.historyId, current.media);
      if (!entry) return { status: 'missing-history' as const };
      await historyStore.checkpoint(current, 'Before restoring an earlier version', 'restore');
      const restored: CaptionProject = {
        ...entry.snapshot,
        wordHighlightFollow: undefined,
        id: current.id,
        media: current.media,
        mediaAlignment: current.mediaAlignment,
        captions: entry.snapshot.captions.map(sanitizeCaptionWordTiming),
        captionAppearance: current.captionAppearance,
        generationModel: current.generationModel,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        engineVersion: '0.7.10',
      };
      return { status: 'restored' as const, project: await persist(restored) };
    });
    if (result.status === 'stale') return res.status(409).json({ error: 'This history belongs to an older media version. Reload the project before restoring.' });
    if (result.status === 'missing-project') return res.status(404).json({ error: 'Project not found' });
    if (result.status === 'missing-history') return res.status(404).json({ error: 'History checkpoint not found' });
    res.json(result.project);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Restore failed' });
  }
});

router.put('/:id/generation-model', async (req, res) => {
  const expected = expectedMedia(req.body?.expectedMedia);
  if (!expected) return res.status(428).json({ error: 'AI options require the source media version. Reload the project before saving.' });
  const choice = req.body?.generationModel;
  const previous = req.body?.expectedGenerationModel;
  if (!isCaptionGenerationModel(choice) || !isCaptionGenerationModel(previous)) {
    return res.status(400).json({ error: 'Choose Automatic, Gemini 3.8 Flash, Gemini 4 Hydrogen, or Gemini 3.6 Flash.' });
  }
  try {
    const result = await store.withProjectWrite(req.params.id, async (current, persist) => {
      if (!current) return { status: 'missing' as const };
      if (current.media.filename !== expected.filename || current.media.size !== expected.size) return { status: 'stale' as const };
      if ((current.generationModel ?? 'automatic') !== previous) return { status: 'changed' as const };
      // Future-job preferences do not change the caption revision or expire an
      // already generated review proposal. The choice has its own CAS above.
      return { status: 'saved' as const, project: await persist({ ...current, generationModel: choice }, { updateGenerationModel: true }) };
    });
    if (result.status === 'missing') return res.status(404).json({ error: 'Project not found' });
    if (result.status === 'stale') return res.status(409).json({ error: 'The source media changed. Reload the project before changing AI options.' });
    if (result.status === 'changed') return res.status(409).json({ error: 'AI options changed in another editor. Reopen the project to use its saved choice.' });
    res.json(result.project);
  } catch {
    res.status(500).json({ error: 'Could not save AI options. Your previous choice was kept. Try again.' });
  }
});

router.put('/:id/context', async (req, res) => {
  const expected = expectedMedia(req.body?.expectedMedia);
  const expectedUpdatedAt = req.body?.expectedUpdatedAt;
  if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim())) {
    return res.status(400).json({ error: 'Context revision must be a nonempty saved project timestamp.' });
  }
  if (!expected) return res.status(428).json({ error: 'Context save requires the media version it was edited against.' });
  if (expectedUpdatedAt === undefined) return res.status(428).json({ error: 'Context save requires the saved project revision it was edited against.' });
  try {
    const result = await store.withProjectWrite(req.params.id, async (current, persist) => {
      if (!current) return { status: 'missing' as const };
      if (current.media.filename !== expected.filename || current.media.size !== expected.size) return { status: 'stale' as const };
      // Compare every save under the persistence lock, including writes that
      // waited behind another client after their request was admitted.
      if (current.updatedAt !== expectedUpdatedAt) return { status: 'revision' as const };
      return { status: 'saved' as const, project: await persist({
        ...current,
        transcriptionContext: normalizeTranscriptionContext(req.body?.transcriptionContext),
        updatedAt: new Date().toISOString(),
      }) };
    });
    if (result.status === 'missing') return res.status(404).json({ error: 'Project not found' });
    if (result.status === 'stale') return res.status(409).json({ error: 'These context changes belong to an older media version. Reload the project before saving.' });
    if (result.status === 'revision') return res.status(409).json({ error: 'The saved project changed. Your Accuracy edits were kept. Download your edits, then reload to review the current project.', code: 'CONTEXT_REVISION_CHANGED' });
    res.json(result.project);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Context save failed' });
  }
});

router.put('/:id/captions', async (req, res) => {
  const requestedCaptions = Array.isArray(req.body.captions) ? req.body.captions as CaptionSegment[] : null;
  if (!requestedCaptions) return res.status(400).json({ error: 'captions must be an array' });
  const expectedMedia = req.body?.expectedMedia;
  if (!expectedMedia || typeof expectedMedia.filename !== 'string' || !Number.isFinite(expectedMedia.size)) {
    return res.status(428).json({ error: 'Caption save requires the media version it was edited against.' });
  }
  const expectedUpdatedAt = req.body?.expectedUpdatedAt;
  if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim())) {
    return res.status(400).json({ error: 'Caption revision must be a nonempty saved project timestamp.' });
  }
  const recoveryExpectedUpdatedAt = req.body?.recoveryExpectedUpdatedAt;
  if (recoveryExpectedUpdatedAt !== undefined && (typeof recoveryExpectedUpdatedAt !== 'string' || !recoveryExpectedUpdatedAt.trim())) {
    return res.status(400).json({ error: 'Recovery revision must be a nonempty saved project timestamp.' });
  }
  if (expectedUpdatedAt !== undefined && recoveryExpectedUpdatedAt !== undefined && expectedUpdatedAt !== recoveryExpectedUpdatedAt) {
    return res.status(400).json({ error: 'Caption and recovery revision guards must match.' });
  }
  const expectedRevision = expectedUpdatedAt ?? recoveryExpectedUpdatedAt;
  if (expectedRevision === undefined) return res.status(428).json({ error: 'Caption save requires the saved project revision it was edited against.' });
  const recoveringDraft = recoveryExpectedUpdatedAt !== undefined;
  const source = String(req.body?.source || 'manual-save') as 'manual-save' | 'autosave' | 'text-edit';
  const recordCorrections = !recoveringDraft && req.body?.recordCorrections !== false;
  try {
    const result = await store.withProjectWrite(req.params.id, async (project, persist) => {
      if (!project) return { status: 'missing' as const };
      if (project.media.filename !== expectedMedia.filename || project.media.size !== expectedMedia.size) {
        return { status: 'stale' as const };
      }
      // Check before History, persistence, or evidence, even for a no-op save.
      // The lock prevents another writer from slipping between check and commit.
      if (project.updatedAt !== expectedRevision) {
        if (recoveringDraft) return { status: 'recovery-stale' as const };
        return { status: 'revision' as const };
      }

      const knownDuration = project.pipelineCache?.normalizedAudioDurationMs ?? project.transcript?.timing?.audioDurationMs;
      const durationMs = knownDuration && Number.isFinite(knownDuration) && knownDuration > 0 ? knownDuration : undefined;
      const retainedTailWords = new Set<string>();
      if (durationMs !== undefined) {
        for (const caption of project.captions) {
          if (caption.wordTiming?.evidence !== 2 || !Array.isArray(caption.wordTiming.words)) continue;
          for (const word of caption.wordTiming.words) {
            if (word.endMs !== null && word.endMs > durationMs && word.endMs <= durationMs + 0.5) {
              retainedTailWords.add(tailWordIdentity(caption.text, word));
            }
          }
        }
      }
      const captions: CaptionSegment[] = [];
      for (const caption of requestedCaptions) {
        const sanitized = sanitizeSavedCaptionWordTiming(caption, durationMs, retainedTailWords);
        if (!sanitized) return { status: 'word-timing-invalid' as const };
        captions.push(sanitized);
      }
      const before = project.captions;
      const changed = JSON.stringify(before) !== JSON.stringify(captions);
      if (changed) {
        await historyStore.checkpoint(
          project,
          source === 'autosave' ? 'Autosave' : source === 'text-edit' ? 'Before text correction' : 'Before manual save',
          source,
          source === 'autosave' ? { dedupeWindowMs: 15_000 } : undefined,
        );
      }
      const saved = await persist({
        ...project,
        captions,
        updatedAt: new Date().toISOString(),
        engineVersion: '0.7.10',
      });
      const corrections = recordCorrections ? await profileStore.recordCaptionChanges(saved, before, captions) : { created: [] };
      // Recovery restores unfinished work; it is not a new correction or approval.
      if (!recoveringDraft) {
        await contributionStore.captureApprovedCorrections(saved, before, captions).catch((error) => {
          console.warn('[contribution] Local candidate capture failed without affecting caption save:', error instanceof Error ? error.message : error);
        });
        const beforeById = new Map(before.map((caption) => [caption.id, caption]));
        const approvedNow = captions.filter((caption) => caption.approved === true && beforeById.get(caption.id)?.approved !== true).length;
        if (approvedNow > 0) void captureAnalytics('caption_approved', { approval_count_bucket: analyticsBuckets.approvals(approvedNow) });
      }
      return { status: 'saved' as const, project: saved, correctionsCreated: corrections.created.length };
    });

    if (result.status === 'missing') return res.status(404).json({ error: 'Project not found' });
    if (result.status === 'stale') {
      return res.status(409).json({ error: 'These captions belong to an older media version. Reload the project before saving.' });
    }
    if (result.status === 'revision') {
      return res.status(409).json({ error: 'The saved project changed. Your edits were kept. Download your edits, then reload to review the current project.', code: 'CAPTION_REVISION_CHANGED' });
    }
    if (result.status === 'recovery-stale') {
      return res.status(409).json({ error: 'The saved project changed after this draft was restored. Your draft was kept. Download your edits, then reload to review the current project.', code: 'DRAFT_RECOVERY_CHANGED' });
    }
    if (result.status === 'word-timing-invalid') {
      return res.status(400).json({ error: 'Caption word timing is invalid.', code: 'WORD_TIMING_INVALID' });
    }
    res.json({ project: result.project, correctionsCreated: result.correctionsCreated });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Caption save failed' });
  }
});

router.post('/:id/normalize-khmer-spacing', async (req, res) => {
  const preparedFor = expectedMedia(req.body?.expectedMedia);
  if (!preparedFor) {
    return res.status(428).json({ error: 'Khmer spacing cleanup requires the media version it was prepared against.' });
  }
  const expectedUpdatedAt = req.body?.expectedUpdatedAt;
  if (expectedUpdatedAt === undefined) return res.status(428).json({ error: 'Khmer spacing cleanup requires the saved project revision.' });
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    return res.status(400).json({ error: 'The saved project revision must be a non-empty string.' });
  }
  try {
    const result = await store.withProjectWrite(req.params.id, async (project, persist) => {
      if (!project) return { status: 'missing' as const };
      if (project.media.filename !== preparedFor.filename || project.media.size !== preparedFor.size) {
        return { status: 'stale' as const };
      }
      if (project.updatedAt !== expectedUpdatedAt) return { status: 'revision' as const };
      await historyStore.checkpoint(project, 'Before Khmer spacing cleanup', 'cleanup');
      project.captions = project.captions.map((caption) => caption.textLocked ? caption : reconcileCaptionWordTiming(caption, {
        ...caption,
        text: normalizeKhmerDisplayText(caption.text),
      }));

      if (project.transcript?.tokens?.length) {
        const tokens = normalizeKhmerTokenSpacing(project.transcript.tokens);
        project.transcript = {
          ...project.transcript,
          tokens,
          fullText: transcriptText(tokens),
          segments: segmentTimedTokens(tokens, {
            mode: 'single-line',
            protectedPhrases: project.transcript.vocabularyTerms,
          }),
        };
      } else if (project.transcript) {
        project.transcript = {
          ...project.transcript,
          fullText: normalizeKhmerDisplayText(project.transcript.fullText),
          segments: project.transcript.segments.map((segment) => ({
            ...segment,
            text: normalizeKhmerDisplayText(segment.text),
          })),
        };
      }

      project.engineVersion = '0.7.10';
      project.updatedAt = new Date().toISOString();
      return { status: 'saved' as const, project: await persist(project) };
    });
    if (result.status === 'missing') return res.status(404).json({ error: 'Project not found' });
    if (result.status === 'stale') {
      return res.status(409).json({ error: 'This Khmer spacing cleanup belongs to an older media version. Reload the project and try again.' });
    }
    if (result.status === 'revision') {
      return res.status(409).json({ error: 'The saved captions changed. Download your edits, then reload the saved project to compare.', code: 'CAPTION_REVISION_CHANGED' });
    }
    res.json(result.project);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Khmer spacing cleanup failed' });
  }
});

router.post('/:id/resegment', async (req, res) => {
  const expectedMedia = req.body?.expectedMedia;
  if (!expectedMedia || typeof expectedMedia.filename !== 'string' || !Number.isFinite(expectedMedia.size)) {
    return res.status(428).json({ error: 'Caption regrouping requires the media version it was prepared against.' });
  }
  try {
    const result = await store.withProjectWrite(req.params.id, async (project, persist) => {
      if (!project) return { status: 'missing' as const };
      if (project.media.filename !== expectedMedia.filename || project.media.size !== expectedMedia.size) {
        return { status: 'stale' as const };
      }
      if (!project.transcript) return { status: 'untranscribed' as const };
      assertRetainedTimingCanBeDerived(project);
      await historyStore.checkpoint(project, 'Before caption regrouping', 'regroup');
      const tokens = requireTimedTokens(project.transcript.tokens);
      const mode = String(req.body.mode || 'dynamic') as CaptionMode;
      const generated = segmentTimedTokens(tokens, {
        mode,
        maxChars: Number(req.body.maxChars || 0) || undefined,
        maxDurationMs: Number(req.body.maxDurationMs || 0) || undefined,
        protectedPhrases: project.transcript.vocabularyTerms,
      });
      const saved = await persist({
        ...project,
        mode,
        captions: preserveCaptionLocks(project.captions, generated),
        engineVersion: '0.7.10',
        updatedAt: new Date().toISOString(),
      });
      return { status: 'saved' as const, project: saved };
    });
    if (result.status === 'missing') return res.status(404).json({ error: 'Project not found' });
    if (result.status === 'stale') {
      return res.status(409).json({ error: 'This grouping request belongs to an older media version. Reload the project before regrouping.' });
    }
    if (result.status === 'untranscribed') return res.status(400).json({ error: 'Transcribe this project first.' });
    res.json(result.project);
  } catch (error) {
    if (error instanceof MediaAlignmentUnverifiedError) return res.status(409).json({ error: error.message, code: 'MEDIA_ALIGNMENT_UNVERIFIED' });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Regrouping failed' });
  }
});

router.post('/:id/postprocess-timing', admitProcessing(async (req, res) => {
  const preparedFor = expectedMedia(req.body?.expectedMedia);
  if (!preparedFor) {
    return res.status(428).json({ error: 'Timing cleanup requires the media version it was prepared against.' });
  }
  const expectedUpdatedAt = req.body?.expectedUpdatedAt;
  if (expectedUpdatedAt === undefined) return res.status(428).json({ error: 'Timing cleanup requires the saved project revision.' });
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    return res.status(400).json({ error: 'The saved project revision must be a non-empty string.' });
  }
  try {
    const settings = req.body?.settings as QaProfileSettings;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'QA timing settings are required.' });
    res.json(await postprocessProjectTiming(req.params.id, settings, preparedFor, expectedUpdatedAt));
  } catch (error) {
    if (error instanceof StaleProjectRevisionError) return res.status(409).json({ error: error.message, code: 'CAPTION_REVISION_CHANGED' });
    if (error instanceof StaleProjectMediaError) return res.status(409).json({ error: error.message });
    if (error instanceof MediaAlignmentUnverifiedError) return res.status(409).json({ error: error.message, code: 'MEDIA_ALIGNMENT_UNVERIFIED' });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Timing post-processing failed' });
  }
}));

router.get('/:id/export.srt', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const srt = toSrt(project.captions);
  await store.withProjectWrite(project.id, async (current) => current ? recordExportEvidence(project, 'srt') : false).catch(() => false);
  const durationMs = project.transcript?.timing?.audioDurationMs || 0;
  void captureAnalytics('export_completed', {
    caption_count_bucket: analyticsBuckets.captions(project.captions.length),
    duration_bucket: analyticsBuckets.durationSeconds(durationMs / 1000),
  });
  res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${project.title.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'captions'}.srt"`);
  res.send(srt);
});

router.delete('/:id', async (req, res) => {
  try {
    await jobAdmission.changeProjectMedia(req.params.id, () => jobStore.hasActiveForProject(req.params.id), async () => {
      const project = await store.get(req.params.id);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      // Drain preparation and preview metadata/file readers before durable
      // deletion. Keep admission closed through cleanup, and preserve published
      // caches if the drain or migration/persistence checks refuse deletion.
      await withMediaPreviewDrain(project.id, async () => {
        await store.remove(req.params.id);
        await fs.rm(path.join(config.uploadDir, project.media.filename), { force: true });
        await invalidateProjectCache(project.id);
        // Recovery media and snapshots are project-owned children of historyDir.
        await clearRetiredMediaSources(project.id);
        await historyStore.clear(project.id);
        await proposalStore.removeProject(project.id);
        await jobStore.removeProject(project.id);
        await contributionStore.removeProject(project.id).catch(() => {});
      });
      res.status(204).end();
    });
  } catch (error) {
    if (error instanceof ProjectDeletionBlockedError) return res.status(409).json({ error: error.message, code: error.code });
    if (error instanceof MediaPreviewError) return res.status(error.httpStatus).json({ error: error.message });
    if (error instanceof JobAdmissionError) return res.status(409).json({ error: error.message });
    throw error;
  }
});

export default router;
