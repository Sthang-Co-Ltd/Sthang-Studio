import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { isVideoProject, normalizeCaptionAppearance, normalizeVideoExportSettings } from '@kcs/shared';
import type { ProcessingJob, VideoExportSettings } from '@kcs/shared';
import { CaptionFontUnavailableError, requireCaptionFont } from '../services/caption-renderer.js';
import { CaptionOverflowError } from '../services/caption-overflow.js';
import { parseCaptionPreviewInput, renderCaptionPreview } from '../services/caption-preview.js';
import { disposePersistentCaptionPreviews, trackCaptionPreviewRequest } from '../services/persistent-caption-preview.js';
import {
  discoverCaptionFonts,
  importCaptionFonts,
  invalidateCaptionFontCache,
  publicCaptionFonts,
  removeImportedCaptionFont,
} from '../services/font-library.js';
import { config } from '../config.js';
import { store } from '../services/store.js';
import { jobAdmission, JobAdmissionError } from '../services/job-admission.js';
import { jobStore } from '../services/job-store.js';
import { profileStore } from '../services/profile-store.js';
import { createVideoExportCaptionSnapshot, invalidateVideoExportCapabilityCache, probeVideoExportCapabilities } from '../services/video-export.js';
import { createCaptionLayoutCheckHandler } from './export-preflight.js';
import { exportFingerprint } from '../services/export-evidence.js';

const router = Router();
const fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 8, fileSize: 8 * 1024 * 1024 },
});
const receiveFontUploads: RequestHandler = (req, res, next) => {
  fontUpload.array('fonts', 8)(req, res, (error) => {
    if (!error) { next(); return; }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'That font file is too large. Choose a .ttf or .otf file up to 8 MB.'
        : error.code === 'LIMIT_FILE_COUNT'
          ? 'Add up to 8 font files at a time.'
          : `Could not read the selected font files. ${error.message}`;
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  });
};

router.get('/fonts', async (req, res) => {
  try {
    if (String(req.query.refresh || '') === '1') {
      // Inventory refresh alone must not cancel the frame rendering while the
      // Appearance workspace opens. Font byte identity is rechecked per request.
      invalidateCaptionFontCache({ system: true });
      invalidateVideoExportCapabilityCache();
    }
    res.json({ fonts: publicCaptionFonts(await discoverCaptionFonts()) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not inspect local Khmer fonts.' });
  }
});

router.post('/fonts', receiveFontUploads, async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'Choose one or more .ttf or .otf Khmer font files.' });
    const result = await importCaptionFonts(files.map((file) => ({ originalName: file.originalname, buffer: file.buffer })));
    await disposePersistentCaptionPreviews();
    // Font changes must invalidate the project capability snapshot before the next preview/export probe.
    invalidateVideoExportCapabilityCache();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add the selected font files.' });
  }
});

router.delete('/fonts/:fontId', async (req, res) => {
  try {
    const fonts = await removeImportedCaptionFont(req.params.fontId);
    await disposePersistentCaptionPreviews();
    invalidateVideoExportCapabilityCache();
    res.json({ fonts });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not remove that font from Studio.' });
  }
});

router.get('/location', (_req, res) => {
  res.json({ directory: config.exportDir });
});

router.get('/:projectId/capabilities', async (req, res) => {
  try {
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isVideoProject(project)) return res.status(409).json({ error: 'Captioned-video export requires a video project. Audio-only projects can still export SRT.' });
    res.json(await probeVideoExportCapabilities(project, String(req.query.refresh || '') === '1'));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not inspect video export capabilities' });
  }
});

router.post('/:projectId/preview', async (req, res) => {
  const controller = new AbortController();
  const tracked = trackCaptionPreviewRequest(req.params.projectId);
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', close);
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const input = parseCaptionPreviewInput(req.body);
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isVideoProject(project)) return res.status(409).json({ error: 'Caption preview requires a video project.' });
    const capabilities = await probeVideoExportCapabilities(project);
    const result = await renderCaptionPreview(input, capabilities, AbortSignal.any([controller.signal, tracked.signal]), {
      projectId: project.id, mediaIdentity: JSON.stringify([project.media.filename, project.media.size]),
    });
    if (!controller.signal.aborted) res.json(result);
  } catch (error) {
    if (tracked.signal.aborted && !controller.signal.aborted && !res.headersSent) {
      res.status(409).json({ error: 'Caption preview changed. Retry preview to use the latest project and fonts.' });
      return;
    }
    if (!controller.signal.aborted && !res.headersSent) {
      const message = error instanceof Error ? error.message : 'Caption preview failed.';
      res.status(message.includes('preview is busy') ? 429 : 400).json({ error: message, ...(error instanceof CaptionOverflowError || error instanceof CaptionFontUnavailableError ? { code: error.code } : {}) });
    }
  } finally {
    tracked.release();
    res.off('close', close);
  }
});

router.post('/:projectId/check-layout', createCaptionLayoutCheckHandler());

function expectedMedia(body: { expectedMedia?: { filename?: unknown; size?: unknown } } | undefined) {
  const value = body?.expectedMedia;
  return value && typeof value.filename === 'string' && Number.isFinite(value.size)
    ? { filename: value.filename, size: Number(value.size) } : null;
}

/** The job is already accepted; a failed convenience-profile save cannot invalidate it. */
export async function acceptedVideoExportResponse(job: ProcessingJob, settings: VideoExportSettings): Promise<ProcessingJob> {
  try {
    await profileStore.setLastVideoExportSettings(settings);
    return { ...job, lastUsedSettingsSaved: true };
  } catch {
    return { ...job, lastUsedSettingsSaved: false };
  }
}

router.put('/:projectId/appearance', async (req, res) => {
  const expected = expectedMedia(req.body);
  if (!expected) return res.status(428).json({ error: 'Appearance save requires the media version it was edited against.' });
  const rawBasis = req.body?.expectedAppearance;
  if (!rawBasis || typeof rawBasis !== 'object' || Array.isArray(rawBasis)) {
    return res.status(428).json({ error: 'Appearance save requires the saved look it was edited against.', code: 'APPEARANCE_BASIS_REQUIRED' });
  }
  const basis = normalizeCaptionAppearance(rawBasis);
  const appearance = normalizeCaptionAppearance(req.body?.appearance);
  try {
    const result = await store.withProjectWrite(req.params.projectId, async (current, persist) => {
      if (!current) return { status: 'missing' as const };
      if (current.media.filename !== expected.filename || current.media.size !== expected.size) return { status: 'stale' as const };
      const currentLook = JSON.stringify(normalizeCaptionAppearance(current.captionAppearance));
      // A response can be lost after persistence. Confirm the identical result
      // without rewriting it or advancing the project revision a second time.
      if (currentLook === JSON.stringify(appearance)) return { status: 'saved' as const, project: current };
      if (currentLook !== JSON.stringify(basis)) return { status: 'conflict' as const };
      return { status: 'saved' as const, project: await persist({ ...current,
        captionAppearance: appearance,
        updatedAt: new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString(),
      }, { restoreAppearance: true }) };
    });
    if (result.status === 'missing') return res.status(404).json({ error: 'Project not found' });
    if (result.status === 'stale') return res.status(409).json({ error: 'These appearance changes belong to an older media version. Reload the project before saving.' });
    if (result.status === 'conflict') return res.status(409).json({ error: 'The saved appearance changed. Download your edits, then reload the saved project to compare.', code: 'APPEARANCE_REVISION_CHANGED' });
    res.json(result.project);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save caption appearance' });
  }
});

router.post('/:projectId/jobs', async (req, res) => {
  const expected = expectedMedia(req.body);
  if (!expected) return res.status(428).json({ error: 'Video export requires the media version it was prepared against.' });
  const expectedContentFingerprint = req.body?.expectedContentFingerprint;
  try {
    await jobAdmission.runForProject(req.params.projectId, async () => {
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.media.filename !== expected.filename || project.media.size !== expected.size) return res.status(409).json({ error: 'The source changed while preparing export. Open Export again.' });
    if (typeof expectedContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedContentFingerprint)) {
      return res.status(428).json({ error: 'Video export requires the caption content it was reviewed against. Open Export and try again.', code: 'VIDEO_CONTENT_BASIS_REQUIRED' });
    }
    if (!isVideoProject(project)) return res.status(409).json({ error: 'Captioned-video export requires a video project. Audio-only projects can still export SRT.' });
    if (!project.captions.length) return res.status(400).json({ error: 'Generate or add captions before exporting a captioned video.' });
    const existing = (await jobStore.list(project.id)).find((job) => job.type === 'export-video' && ['queued', 'running'].includes(job.status));
    if (existing) return res.status(409).json({ error: 'A captioned-video export is already active for this project. Cancel it or let it finish before starting another.' });
    const appearance = normalizeCaptionAppearance(req.body?.appearance || project.captionAppearance);
    const settings = normalizeVideoExportSettings(req.body?.settings);
    const capabilities = await probeVideoExportCapabilities(project);
    if (!capabilities.supported) return res.status(409).json({ error: capabilities.blockingReason || 'Captioned-video export is unavailable on this PC.' });
    requireCaptionFont(capabilities.fonts, appearance);
    // Export consumes a reviewed saved look. A delayed capability probe must
    // never turn an old export request into an appearance overwrite.
    const snapshot = await store.withProjectWrite(project.id, async (current) => {
      if (!current) return { status: 'missing' as const };
      if (current.media.filename !== expected.filename || current.media.size !== expected.size) return { status: 'source' as const };
      if (JSON.stringify(normalizeCaptionAppearance(current.captionAppearance)) !== JSON.stringify(appearance)) return { status: 'appearance' as const };
      if (exportFingerprint(current, 'video') !== expectedContentFingerprint) return { status: 'captions' as const };
      return { status: 'ready' as const, project: current };
    });
    if (snapshot.status === 'missing') return res.status(404).json({ error: 'Project not found' });
    if (snapshot.status === 'source') return res.status(409).json({ error: 'The source changed while preparing export. Open Export again.' });
    if (snapshot.status === 'appearance') return res.status(409).json({ error: 'The saved appearance changed while preparing export. Open Export again to review the current look.', code: 'APPEARANCE_REVISION_CHANGED' });
    if (snapshot.status === 'captions') return res.status(409).json({ error: 'The saved captions changed after this export was reviewed. Reopen the project to compare them before rendering.', code: 'VIDEO_CONTENT_REVISION_CHANGED' });
    const saved = snapshot.project;
    const creation = await jobStore.createWithDisposition('export-video', project.id, {
      exportSettings: settings,
      exportAppearance: appearance,
      exportCaptions: createVideoExportCaptionSnapshot(saved),
      exportMediaFilename: project.media.filename,
      exportMediaSize: project.media.size,
    });
    // The earlier list check avoids expensive probes in the ordinary duplicate
    // case; this outcome is authoritative when two requests passed it together.
    if (!creation.created) return res.status(409).json({ error: 'A captioned-video export is already active for this project. Cancel it or let it finish before starting another.' });
    res.status(202).json(await acceptedVideoExportResponse(creation.job, settings));
    });
  } catch (error) {
    if (error instanceof JobAdmissionError) return res.status(409).json({ error: error.message });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not start captioned-video export' });
  }
});

export default router;
