import { Router } from 'express';
import { config } from '../config.js';
import { store } from '../services/store.js';
import { jobStore } from '../services/job-store.js';
import {
  normalizeCaptionAppearance,
  normalizeVideoExportSettings,
  probeVideoExportCapabilities,
} from '../services/video-export.js';

const router = Router();

function isVideoProject(mimeType: string, originalName: string) {
  return mimeType.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(originalName);
}

router.get('/location', (_req, res) => {
  res.json({ directory: config.exportDir });
});

router.get('/:projectId/capabilities', async (req, res) => {
  try {
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isVideoProject(project.media.mimeType, project.media.originalName)) return res.status(409).json({ error: 'Captioned-video export requires a video project. Audio-only projects can still export SRT.' });
    res.json(await probeVideoExportCapabilities(project, String(req.query.refresh || '') === '1'));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not inspect video export capabilities' });
  }
});

router.put('/:projectId/appearance', async (req, res) => {
  try {
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    project.captionAppearance = normalizeCaptionAppearance(req.body?.appearance);
    project.updatedAt = new Date().toISOString();
    await store.upsert(project);
    res.json(project);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save caption appearance' });
  }
});

router.post('/:projectId/jobs', async (req, res) => {
  try {
    const project = await store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!isVideoProject(project.media.mimeType, project.media.originalName)) return res.status(409).json({ error: 'Captioned-video export requires a video project. Audio-only projects can still export SRT.' });
    if (!project.captions.length) return res.status(400).json({ error: 'Generate or add captions before exporting a captioned video.' });
    const existing = (await jobStore.list(project.id)).find((job) => job.type === 'export-video' && ['queued', 'running'].includes(job.status));
    if (existing) return res.status(409).json({ error: 'A captioned-video export is already active for this project. Cancel it or let it finish before starting another.' });
    const appearance = normalizeCaptionAppearance(req.body?.appearance || project.captionAppearance);
    const settings = normalizeVideoExportSettings(req.body?.settings);
    const capabilities = await probeVideoExportCapabilities(project);
    if (!capabilities.supported) return res.status(409).json({ error: capabilities.blockingReason || 'Captioned-video export is unavailable on this PC.' });
    project.captionAppearance = appearance;
    project.updatedAt = new Date().toISOString();
    await store.upsert(project);
    const job = await jobStore.create('export-video', project.id, {
      exportSettings: settings,
      exportAppearance: appearance,
      exportCaptions: project.captions.map((caption) => ({ ...caption })),
      exportMediaFilename: project.media.filename,
      exportMediaSize: project.media.size,
    });
    res.status(202).json(job);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not start captioned-video export' });
  }
});

export default router;
