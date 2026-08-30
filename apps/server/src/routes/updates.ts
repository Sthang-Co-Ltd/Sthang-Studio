import { Router, type Response } from 'express';
import { APP_VERSION } from '../version.js';
import { UpdateError, createUpdateService, publicUpdateError, unsafeUpdateReasons, type UpdateSafetySnapshot } from '../updater.js';
import { jobStore } from '../services/job-store.js';

const router = Router();
let servicePromise: ReturnType<typeof createUpdateService> | null = null;
const service = () => servicePromise ||= createUpdateService();

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function safety(body: unknown): UpdateSafetySnapshot {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const client = value.safety && typeof value.safety === 'object' ? value.safety as Record<string, unknown> : {};
  const clientJobs = Number.isSafeInteger(client.activeJobs)
    ? Math.max(0, Math.min(1000, Number(client.activeJobs)))
    : 0;
  return {
    dirty: client.dirty === true,
    textEditing: client.textEditing === true,
    reviewMode: client.reviewMode === true,
    proposalOpen: client.proposalOpen === true,
    busy: client.busy === true,
    activeJobs: jobStore.hasAnyActive() ? Math.max(1, clientJobs) : clientJobs,
  };
}

function assertSafe(body: unknown) {
  const reasons = unsafeUpdateReasons(safety(body));
  if (reasons.length) throw new UpdateError('UNSAFE', reasons[0], 409);
}

function sendFailure(res: Response, error: unknown) {
  const result = publicUpdateError(error);
  return res.status(result.status).json(result.body);
}

router.get('/', async (_req, res) => {
  noStore(res);
  try { res.json(await (await service()).check(APP_VERSION)); }
  catch (error) { sendFailure(res, error); }
});

router.post('/download', async (req, res) => {
  noStore(res);
  try {
    assertSafe(req.body);
    const digest = typeof req.body?.manifestDigest === 'string' ? req.body.manifestDigest : '';
    res.json(await (await service()).download(digest));
  } catch (error) { sendFailure(res, error); }
});

router.post('/install', async (req, res) => {
  noStore(res);
  try {
    assertSafe(req.body);
    const digest = typeof req.body?.manifestDigest === 'string' ? req.body.manifestDigest : '';
    const pending = await (await service()).prepareInstall(APP_VERSION, digest);
    if (process.env.STHANG_STUDIO_DISABLE_UPDATE_EXIT !== '1') {
      res.once('finish', () => setTimeout(() => process.exit(42), 250).unref());
    }
    res.status(202).json({ closing: true, version: pending.version });
  } catch (error) { sendFailure(res, error); }
});

export default router;
