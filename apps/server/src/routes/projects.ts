import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { CaptionProject, CaptionSegment, CaptionMode, QaProfileSettings, RegenerationApplyMode } from '@kcs/shared';
import { config } from '../config.js';
import { store } from '../services/store.js';
import { profileStore } from '../services/profile-store.js';
import { ensureNormalizedAudio, invalidateProjectCache } from '../services/cache.js';
import { requireTimedTokens, segmentTimedTokens } from '../services/segmenter.js';
import { toSrt } from '../services/srt.js';
import { normalizeTranscriptionContext } from '../services/vocabulary.js';
import { normalizeKhmerDisplayText, normalizeKhmerTokenSpacing } from '../services/tokenizer.js';
import { transcriptText } from '../services/transcript.js';
import { preserveCaptionLocks } from '../services/caption-locks.js';
import {
  applyRegenerationProposal,
  createRangeRegenerationProposal,
  refineRegenerationProposal,
  postprocessProjectTiming,
  transcribeProject,
} from '../services/project-processing.js';
import { historyStore } from '../services/history-store.js';
import { proposalStore } from '../services/proposal-store.js';
import { jobStore } from '../services/job-store.js';

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
const router = Router();

router.get('/', async (_req, res) => res.json(await store.list()));
router.get('/:id', async (req, res) => {
  const item = await store.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Project not found' });
  res.json(item);
});

router.post('/', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a video or audio file.' });
    const id = nanoid(10);
    const ext = path.extname(req.file.originalname);
    const filename = `${id}${ext}`;
    await fs.rename(req.file.path, path.join(config.uploadDir, filename));
    const now = new Date().toISOString();
    const profile = await profileStore.get();
    const project: CaptionProject = {
      id,
      title: String(req.body.title || path.basename(req.file.originalname, ext)),
      createdAt: now,
      updatedAt: now,
      media: {
        filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype || 'application/octet-stream',
        size: req.file.size,
        url: `/media/${encodeURIComponent(filename)}`,
      },
      transcriptionContext: { description: '', vocabulary: profile.defaultVocabulary },
      transcript: null,
      captions: [],
      mode: profile.styles[0]?.mode || 'dynamic',
      engineVersion: '0.7.10',
    };
    await store.upsert(project);
    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
  }
});

router.post('/:id/replace-media', upload.single('media'), async (req, res) => {
  try {
    const project = await store.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'Choose a replacement video or audio file.' });
    if (jobStore.hasActiveForProject(project.id)) {
      await fs.rm(req.file.path, { force: true });
      return res.status(409).json({ error: 'A caption job is still running for this project. Finish or cancel it before replacing the media.' });
    }
    const ext = path.extname(req.file.originalname);
    const filename = `${project.id}-${Date.now()}${ext}`;
    await fs.rename(req.file.path, path.join(config.uploadDir, filename));
    await fs.rm(path.join(config.uploadDir, project.media.filename), { force: true });
    await invalidateProjectCache(project.id);
    // History/proposals contain timing tied to the old media and are unsafe to
    // restore after a replacement file is installed.
    await historyStore.clear(project.id);
    await proposalStore.removeProject(project.id);
    project.media = {
      filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      url: `/media/${encodeURIComponent(filename)}`,
    };
    project.transcript = null;
    project.captions = [];
    project.pipelineCache = undefined;
    project.transcriptNeedsSync = false;
    project.engineVersion = '0.7.10';
    project.updatedAt = new Date().toISOString();
    await store.upsert(project);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Media replacement failed' });
  }
});

/** Compatibility endpoint. v0.7 UI normally uses the persistent background job API. */
router.post('/:id/transcribe', async (req, res) => {
  try {
    res.json(await transcribeProject(req.params.id, req.body?.transcriptionContext, req.body?.force === true));
  } catch (error) {
    console.error('Local hybrid transcription failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Local hybrid transcription failed' });
  }
});

/** Compatibility endpoint: create a preview and immediately accept it. */
router.post('/:id/regenerate-range', async (req, res) => {
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
});

router.get('/:id/regeneration-proposals/:proposalId', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const proposal = await proposalStore.get(req.params.proposalId);
  if (!proposal || proposal.summary.projectId !== project.id) return res.status(404).json({ error: 'Proposal expired or not found' });
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
router.post('/:id/regeneration-proposals/:proposalId/refine', async (req, res) => {
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
});

router.get('/:id/normalized-audio.wav', async (req, res, next) => {
  try {
    const project = await store.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const force = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const normalized = await ensureNormalizedAudio(project, { force });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', 'inline; filename="sthang-waveform.wav"');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Sthang-Audio-Cache', normalized.cacheHit ? 'hit' : force ? 'rebuilt' : 'generated');
    res.sendFile(normalized.outputPath, (error) => {
      if (!error) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      next(error);
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not prepare waveform audio' });
  }
});

router.get('/:id/history', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(await historyStore.list(project.id));
});

router.post('/:id/history/:historyId/restore', async (req, res) => {
  try {
    const current = await store.get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Project not found' });
    const entry = await historyStore.get(current.id, req.params.historyId);
    if (!entry) return res.status(404).json({ error: 'History checkpoint not found' });
    await historyStore.checkpoint(current, 'Before restoring an earlier version', 'restore');
    const restored: CaptionProject = {
      ...entry.snapshot,
      id: current.id,
      media: current.media,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      engineVersion: '0.7.10',
    };
    await store.upsert(restored);
    res.json(restored);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Restore failed' });
  }
});

router.put('/:id/context', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.transcriptionContext = normalizeTranscriptionContext(req.body?.transcriptionContext);
  project.updatedAt = new Date().toISOString();
  await store.upsert(project);
  res.json(project);
});

router.put('/:id/captions', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const captions = Array.isArray(req.body.captions) ? req.body.captions as CaptionSegment[] : null;
  if (!captions) return res.status(400).json({ error: 'captions must be an array' });
  const before = project.captions;
  const source = String(req.body?.source || 'manual-save') as 'manual-save' | 'autosave' | 'text-edit';
  const changed = JSON.stringify(before) !== JSON.stringify(captions);
  if (changed) {
    await historyStore.checkpoint(
      project,
      source === 'autosave' ? 'Autosave' : source === 'text-edit' ? 'Before text correction' : 'Before manual save',
      source,
      source === 'autosave' ? { dedupeWindowMs: 15_000 } : undefined,
    );
  }
  project.captions = captions;
  project.updatedAt = new Date().toISOString();
  project.engineVersion = '0.7.10';
  await store.upsert(project);
  const recordCorrections = req.body?.recordCorrections !== false;
  const corrections = recordCorrections ? await profileStore.recordCaptionChanges(project, before, captions) : { created: [] };
  res.json({ project, correctionsCreated: corrections.created.length });
});

router.post('/:id/normalize-khmer-spacing', async (req, res) => {
  try {
    const project = await store.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await historyStore.checkpoint(project, 'Before Khmer spacing cleanup', 'cleanup');
    project.captions = project.captions.map((caption) => caption.textLocked ? caption : ({
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
    await store.upsert(project);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Khmer spacing cleanup failed' });
  }
});

router.post('/:id/resegment', async (req, res) => {
  try {
    const project = await store.get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.transcript) return res.status(400).json({ error: 'Transcribe this project first.' });
    await historyStore.checkpoint(project, 'Before caption regrouping', 'regroup');
    const tokens = requireTimedTokens(project.transcript.tokens);
    const mode = String(req.body.mode || 'dynamic') as CaptionMode;
    project.mode = mode;
    const generated = segmentTimedTokens(tokens, {
      mode,
      maxChars: Number(req.body.maxChars || 0) || undefined,
      maxDurationMs: Number(req.body.maxDurationMs || 0) || undefined,
      protectedPhrases: project.transcript.vocabularyTerms,
    });
    project.captions = preserveCaptionLocks(project.captions, generated);
    project.engineVersion = '0.7.10';
    project.updatedAt = new Date().toISOString();
    await store.upsert(project);
    res.json(project);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Regrouping failed' });
  }
});

router.post('/:id/postprocess-timing', async (req, res) => {
  try {
    const settings = req.body?.settings as QaProfileSettings;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'QA timing settings are required.' });
    res.json(await postprocessProjectTiming(req.params.id, settings));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Timing post-processing failed' });
  }
});

router.get('/:id/export.srt', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const srt = toSrt(project.captions);
  res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${project.title.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'captions'}.srt"`);
  res.send(srt);
});

router.delete('/:id', async (req, res) => {
  const project = await store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (jobStore.hasActiveForProject(project.id)) return res.status(409).json({ error: 'Finish or cancel the active processing job before deleting this project.' });
  await store.remove(req.params.id);
  await fs.rm(path.join(config.uploadDir, project.media.filename), { force: true });
  await invalidateProjectCache(project.id);
  await historyStore.clear(project.id);
  await proposalStore.removeProject(project.id);
  await jobStore.removeProject(project.id);
  res.status(204).end();
});

export default router;
