import { Router, type Response } from 'express';
import type { CaptionFileFormat, CaptionProject } from '@kcs/shared';
import {
  CaptionHandoffError,
  createCaptionHandoffService,
  defaultCaptionHandoffDependencies,
  type CaptionHandoffService,
  type ExpectedMedia,
} from '../services/caption-handoff.js';

const formats = new Set<CaptionFileFormat>(['srt', 'word-srt', 'vtt', 'word-vtt', 'ttml', 'ass', 'data', 'bundle']);
const revisionPattern = /^[0-9a-f]{64}$/i;

function projectId(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function expectedMedia(value: unknown): ExpectedMedia | null {
  const media = value as Partial<Pick<CaptionProject['media'], 'filename' | 'size'>> | null | undefined;
  return media && typeof media.filename === 'string' && media.filename.length > 0 && media.filename.length <= 512
    && typeof media.size === 'number' && Number.isSafeInteger(media.size) && media.size >= 0
    ? { filename: media.filename, size: media.size }
    : null;
}

function expectedRevision(value: unknown) {
  return typeof value === 'string' && revisionPattern.test(value) ? value.toLowerCase() : null;
}

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function warningHeader(warnings: string[]) {
  return warnings
    .map((warning) => warning.replace(/[^\x20-\x7E]/g, '?').replace(/[\r\n]+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 2048);
}

function respondError(res: Response, error: unknown) {
  if (error instanceof CaptionHandoffError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error('[caption handoff] Request failed:', error);
  res.status(500).json({ error: 'Caption handoff failed locally. Your saved captions were not changed.' });
}

export function createCaptionHandoffRouter(service: CaptionHandoffService = createCaptionHandoffService(defaultCaptionHandoffDependencies())) {
  const router = Router();

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get('/:id/summary', async (req, res) => {
    const id = projectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Project id is required.' });
    try {
      res.json(await service.summary(id));
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post('/:id/export', async (req, res) => {
    const id = projectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Project id is required.' });
    const media = expectedMedia(req.body?.expectedMedia);
    const revision = expectedRevision(req.body?.expectedRevision);
    if (!media || !revision) return res.status(428).json({ error: 'Export requires the saved media and caption snapshot revision it was prepared from.' });
    const format = req.body?.format;
    if (typeof format !== 'string' || !formats.has(format as CaptionFileFormat)) return res.status(400).json({ error: 'Unsupported caption handoff format.' });
    try {
      const result = await service.export(id, {
        format: format as CaptionFileFormat,
        expectedMedia: media,
        expectedRevision: revision,
        ...(req.body?.options && typeof req.body.options === 'object' && !Array.isArray(req.body.options) ? { options: req.body.options as Record<string, unknown> } : {}),
      });
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.setHeader('X-Sthang-Handoff-Revision', result.revision);
      if (result.warnings.length) res.setHeader('X-Sthang-Handoff-Warnings', warningHeader(result.warnings));
      res.send(result.body);
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post('/:id/restore-preview', async (req, res) => {
    const id = projectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Project id is required.' });
    const media = expectedMedia(req.body?.expectedMedia);
    const revision = expectedRevision(req.body?.expectedRevision);
    if (!media || !revision) return res.status(428).json({ error: 'Restore preview requires the saved media and caption snapshot revision it was prepared from.' });
    if (typeof req.body?.data !== 'string') return res.status(400).json({ error: 'Portable caption data must be provided as text.' });
    try {
      res.json(await service.restorePreview(id, { data: req.body.data, expectedMedia: media, expectedRevision: revision }));
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post('/:id/restore', async (req, res) => {
    const id = projectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Project id is required.' });
    const media = expectedMedia(req.body?.expectedMedia);
    const revision = expectedRevision(req.body?.expectedRevision);
    if (!media || !revision) return res.status(428).json({ error: 'Restore requires the saved media and caption snapshot revision it was prepared from.' });
    if (req.body?.confirmed !== true) return res.status(428).json({ error: 'Restore requires explicit confirmation after preview.' });
    if (typeof req.body?.data !== 'string') return res.status(400).json({ error: 'Portable caption data must be provided as text.' });
    if (typeof req.body?.expectedCandidateDigest !== 'string' || !revisionPattern.test(req.body.expectedCandidateDigest)) {
      return res.status(428).json({ error: 'Restore requires the exact previewed caption-data digest.' });
    }
    try {
      const result = await service.restore(id, {
        data: req.body.data,
        expectedMedia: media,
        expectedRevision: revision,
        expectedCandidateDigest: req.body.expectedCandidateDigest.toLowerCase(),
        confirmed: true,
      });
      // Client integration expects the updated project itself, matching ordinary
      // project mutation endpoints rather than a handoff-specific wrapper.
      res.json(result.project);
    } catch (error) {
      respondError(res, error);
    }
  });

  return router;
}

export default createCaptionHandoffRouter();
