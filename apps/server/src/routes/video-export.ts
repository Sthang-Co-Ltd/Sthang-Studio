import { Router } from 'express';
import { isVideoProject, normalizeCaptionAppearance, normalizeVideoExportSettings } from '@kcs/shared';
import { requireCaptionFont } from '../services/caption-renderer.js';
import { parseCaptionPreviewInput, renderCaptionPreview } from '../services/caption-preview.js';
import { config } from '../config.js';
import { store } from '../services/store.js';
import { jobStore } from '../services/job-store.js';
import { probeVideoExportCapabilities } from '../services/video-export.js';

const router = Router();

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
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', close);
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const input = parseCaptionPreviewInput(req.body);
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isVideoProject(project)) return res.status(409).json({ error: 'Caption preview requires a video project.' });
    const capabilities = await probeVideoExportCapabilities(project);
    const result = await renderCaptionPreview(input, capabilities, controller.signal);
    if (!controller.signal.aborted) res.json(result);
  } catch (error) {
    if (!controller.signal.aborted && !res.headersSent) {
      const message = error instanceof Error ? error.message : 'Caption preview failed.';
      res.status(message.includes('preview is busy') ? 429 : 400).json({ error: message });
    }
  } finally {
    res.off('close', close);
  }
});

router.put('/:projectId/appearance', async (req, res) => {
  try {
    const project = await store.setCaptionAppearance(req.params.projectId, normalizeCaptionAppearance(req.body?.appearance));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save caption appearance' });
  }
});

router.post('/:projectId/jobs', async (req, res) => {
  try {
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isVideoProject(project)) return res.status(409).json({ error: 'Captioned-video export requires a video project. Audio-only projects can still export SRT.' });
    if (!project.captions.length) return res.status(400).json({ error: 'Generate or add captions before exporting a captioned video.' });
    const existing = (await jobStore.list(project.id)).find((job) => job.type === 'export-video' && ['queued', 'running'].includes(job.status));
    if (existing) return res.status(409).json({ error: 'A captioned-video export is already active for this project. Cancel it or let it finish before starting another.' });
    const appearance = normalizeCaptionAppearance(req.body?.appearance || project.captionAppearance);
    const settings = normalizeVideoExportSettings(req.body?.settings);
    const capabilities = await probeVideoExportCapabilities(project);
    if (!capabilities.supported) return res.status(409).json({ error: capabilities.blockingReason || 'Captioned-video export is unavailable on this PC.' });
    requireCaptionFont(capabilities.fonts, appearance);
    const saved = await store.setCaptionAppearance(project.id, appearance);
    if (!saved) return res.status(404).json({ error: 'Project not found' });
    if (saved.media.filename !== project.media.filename || saved.media.size !== project.media.size) return res.status(409).json({ error: 'The source changed while preparing export. Open Export again.' });
    const job = await jobStore.create('export-video', project.id, {
      exportSettings: settings,
      exportAppearance: appearance,
      exportCaptions: saved.captions.map((caption) => ({ ...caption })),
      exportMediaFilename: project.media.filename,
      exportMediaSize: project.media.size,
    });
    res.status(202).json(job);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not start captioned-video export' });
  }
});

export default router;
