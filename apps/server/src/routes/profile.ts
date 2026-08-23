import { Router } from 'express';
import type { CaptionProject } from '@kcs/shared';
import { profileStore } from '../services/profile-store.js';
import { store } from '../services/store.js';
import { normalizeTranscriptionContext } from '../services/vocabulary.js';

const router = Router();

router.get('/', async (_req, res) => {
  res.json(await profileStore.get());
});

router.patch('/', async (req, res) => {
  try {
    res.json(await profileStore.patch(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Profile update failed' });
  }
});

router.get('/export', async (_req, res) => {
  const profile = await profileStore.get();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sthang-studio-profile.json"');
  res.send(JSON.stringify(profile, null, 2));
});

router.post('/import', async (req, res) => {
  try {
    res.json(await profileStore.replace(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Profile import failed' });
  }
});

router.post('/corrections/:id/action', async (req, res) => {
  try {
    const action = String(req.body?.action || '') as 'remember-global' | 'add-project' | 'ignore';
    if (!['remember-global', 'add-project', 'ignore'].includes(action)) {
      return res.status(400).json({ error: 'Unknown correction action.' });
    }

    const result = await profileStore.actOnCorrection(req.params.id, action);
    let project: CaptionProject | null = null;

    if (action === 'add-project') {
      project = await store.get(result.event.projectId);
      if (!project) return res.status(404).json({ error: 'The correction project no longer exists.' });
      const context = normalizeTranscriptionContext(project.transcriptionContext);
      context.vocabulary = profileStore.addVocabularyLine(context.vocabulary, result.event.suggestedVocabularyLine);
      project.transcriptionContext = context;
      project.updatedAt = new Date().toISOString();
      await store.upsert(project);
    }

    res.json({ profile: result.profile, project });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Correction action failed' });
  }
});

export default router;
