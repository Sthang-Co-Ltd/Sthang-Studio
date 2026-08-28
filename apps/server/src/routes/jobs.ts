import { Router } from 'express';
import { jobStore } from '../services/job-store.js';

const router = Router();

router.get('/', async (req, res) => {
  res.json(await jobStore.list(typeof req.query.projectId === 'string' ? req.query.projectId : undefined));
});

router.get('/events', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const send = (snapshot: Awaited<ReturnType<typeof jobStore.list>>) => {
    if (closed || res.writableEnded) return;
    res.write(`event: jobs\ndata: ${JSON.stringify(snapshot)}\n\n`);
  };
  const unsubscribe = jobStore.subscribe(send);
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': keepalive\n\n');
  }, 20_000);

  req.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  });
});

router.get('/:id', async (req, res) => {
  const job = await jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.post('/transcribe', async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || '');
    const job = await jobStore.create('transcribe', projectId, {
      transcriptionContext: req.body?.transcriptionContext,
      force: req.body?.force === true,
    });
    res.status(202).json(job);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create job' });
  }
});

router.post('/regenerate-range', async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || '');
    const job = await jobStore.create('regenerate-range', projectId, {
      startMs: Number(req.body?.startMs),
      endMs: Number(req.body?.endMs),
      transcriptionContext: req.body?.transcriptionContext,
    });
    res.status(202).json(job);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create job' });
  }
});

router.post('/refine-proposal', async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || '');
    const proposalId = String(req.body?.proposalId || '');
    if (!proposalId) return res.status(400).json({ error: 'proposalId is required' });
    const job = await jobStore.create('refine-proposal', projectId, {
      proposalId,
      strategy: req.body?.strategy,
      accuracyHint: typeof req.body?.accuracyHint === 'string' ? req.body.accuracyHint : undefined,
      editedText: typeof req.body?.editedText === 'string' ? req.body.editedText : undefined,
      useProposalAsBaseline: req.body?.useProposalAsBaseline === true,
    });
    res.status(202).json(job);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create refinement job' });
  }
});

router.post('/:id/resume', async (req, res) => {
  try { res.json(await jobStore.resume(req.params.id)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Resume failed' }); }
});

router.post('/:id/cancel', async (req, res) => {
  try { res.json(await jobStore.cancel(req.params.id)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Cancel failed' }); }
});

export default router;
