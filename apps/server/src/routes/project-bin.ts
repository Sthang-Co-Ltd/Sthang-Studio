import { Router, type RequestHandler, type Response } from 'express';
import { JobAdmissionError } from '../services/job-admission.js';
import { MediaPreviewError } from '../services/media-preview.js';
import { moveProjectToBin, ProjectPurgeIncompleteError, purgeProject, restoreProjectFromBin } from '../services/project-purge.js';
import { ProjectBinError, store } from '../services/store.js';

const router = Router();

function binError(res: Response, error: unknown) {
  if (error instanceof ProjectBinError) return res.status(error.code === 'not_found' ? 404 : 409).json({ code: error.code, error: error.message });
  if (error instanceof JobAdmissionError) return res.status(409).json({ code: 'job_active', error: 'Finish or cancel active work for this project and try again.' });
  if (error instanceof MediaPreviewError) return res.status(error.httpStatus).json({ error: error.message });
  if (error instanceof ProjectPurgeIncompleteError) return res.status(500).json({ code: 'purge_incomplete', error: error.message });
  return res.status(500).json({ error: 'Studio could not finish this action. Check Recently deleted and local storage before retrying.' });
}

const perform: (operation: RequestHandler<{ id: string }>) => RequestHandler<{ id: string }> = (operation) => async (req, res, next) => {
  try { await operation(req, res, next); }
  catch (error) { binError(res, error); }
};

export const deleteProject = perform(async (req, res) => {
  res.json(await moveProjectToBin(req.params.id));
});

router.get('/', async (_req, res) => {
  try { res.json({ items: await store.listBinned() }); }
  catch (error) { binError(res, error); }
});

router.post('/', async (req, res) => {
  if (typeof req.body?.projectId !== 'string' || !req.body.projectId) return res.status(400).json({ error: 'Project id is required.' });
  try { res.json(await moveProjectToBin(req.body.projectId)); }
  catch (error) { binError(res, error); }
});

router.post('/:id/restore', perform(async (req, res) => {
  if (typeof req.body?.instanceId !== 'string' || !req.body.instanceId) { res.status(400).json({ error: 'Deletion instance is required.' }); return; }
  res.json(await restoreProjectFromBin(req.params.id, req.body.instanceId));
}));

router.delete('/:id', perform(async (req, res) => {
  if (typeof req.body?.instanceId !== 'string' || !req.body.instanceId) { res.status(400).json({ error: 'Deletion instance is required.' }); return; }
  await purgeProject(req.params.id, { instanceId: req.body.instanceId });
  res.status(204).end();
}));

export default router;
