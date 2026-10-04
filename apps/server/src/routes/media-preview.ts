import { Router } from 'express';
import { store } from '../services/store.js';
import { cancelMediaPreview, mediaPreviewFile, mediaPreviewStatus, MediaPreviewError, startMediaPreview } from '../services/media-preview.js';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

router.get('/:id/file/:filename', async (req, res, next) => {
  try {
    const project = await store.getMedia(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const file = await mediaPreviewFile(project, req.params.filename);
    res.type('video/mp4');
    res.sendFile(file.filename, { root: file.dir, dotfiles: 'deny', acceptRanges: true }, (error) => {
      if (error) { if (res.headersSent) res.destroy(); else next(error); }
    });
  } catch (error) { next(error); }
});

for (const method of ['get', 'post', 'delete'] as const) {
  router[method]('/:id', async (req, res, next) => {
    try {
      const project = await store.getMedia(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found.' });
      const source = method === 'get' ? req.query.source : req.body?.source;
      if (source !== project.media.filename) return res.status(409).json({ error: 'The source media changed. Reopen this project.' });
      const result = method === 'post' ? await store.withProjectWrite(project.id, async (current) => {
        if (!current || current.media.filename !== source) throw new MediaPreviewError('The source media changed. Reopen this project.', 409);
        return startMediaPreview(current, { force: req.body?.force === true });
      }) : method === 'delete' ? await cancelMediaPreview(project) : await mediaPreviewStatus(project);
      res.status(result.state === 'processing' ? 202 : 200).json(result);
    } catch (error) { next(error); }
  });
}
router.use((error: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
  res.status(error instanceof MediaPreviewError ? error.httpStatus : 500).json({ error: error instanceof MediaPreviewError ? error.message : 'Playback preparation is unavailable.' });
});
export default router;
