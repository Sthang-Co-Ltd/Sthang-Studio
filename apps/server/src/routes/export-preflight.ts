import type { RequestHandler } from 'express';
import { isVideoProject } from '@kcs/shared';
import { store } from '../services/store.js';
import { probeVideoExportCapabilities } from '../services/video-export.js';
import { trackCaptionPreviewRequest } from '../services/persistent-caption-preview.js';
import { CaptionLayoutCheckError, checkCaptionLayout, parseCaptionLayoutCheckInput } from '../services/export-preflight.js';

const defaults = { getProject: (id: string) => store.get(id), capabilities: probeVideoExportCapabilities,
  check: checkCaptionLayout, track: trackCaptionPreviewRequest };

/** Injectable boundaries let HTTP tests hold native work while media/font ownership changes. */
export function createCaptionLayoutCheckHandler(dependencies: typeof defaults = defaults): RequestHandler {
  return async (req, res) => {
    const projectId = String(req.params.projectId);
    const controller = new AbortController();
    // Register before async capability discovery so replacement/deletion/font edits
    // invalidate even a check that has not spawned its native process yet.
    const tracked = dependencies.track(projectId);
    const signal = AbortSignal.any([controller.signal, tracked.signal]);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', close);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const input = parseCaptionLayoutCheckInput(req.body);
      const project = await dependencies.getProject(projectId);
      signal.throwIfAborted();
      if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }
      if (project.media.filename !== input.expectedMedia.filename || project.media.size !== input.expectedMedia.size) {
        res.status(409).json({ error: 'The source changed. Reopen Export before checking layout.' }); return;
      }
      if (!isVideoProject(project)) { res.status(409).json({ error: 'Layout checking needs a video project. Caption files remain available for audio projects.' }); return; }
      const capabilities = await dependencies.capabilities(project);
      signal.throwIfAborted();
      const result = await dependencies.check(input, capabilities, projectId, signal);
      signal.throwIfAborted();
      const current = await dependencies.getProject(projectId);
      signal.throwIfAborted();
      if (!current || current.media.filename !== input.expectedMedia.filename || current.media.size !== input.expectedMedia.size) {
        res.status(409).json({ error: 'The source changed during this check. Reopen Export and check again.' }); return;
      }
      res.json(result);
    } catch (error) {
      if (controller.signal.aborted || res.headersSent) return;
      if (tracked.signal.aborted) {
        res.status(409).json({ error: 'The source or fonts changed. Run the layout check again.' }); return;
      }
      const known = error instanceof CaptionLayoutCheckError;
      res.status(known ? error.status : 400).json({ error: known ? error.message : 'Layout checking could not finish. Run System check or try again.' });
    } finally {
      tracked.release();
      res.off('close', close);
    }
  };
}
