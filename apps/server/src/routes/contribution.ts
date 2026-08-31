import { Router } from 'express';
import { contributionStore } from '../services/contribution-store.js';
import { profileStore } from '../services/profile-store.js';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    const profile = await profileStore.get();
    res.json(await contributionStore.status(profile));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Contribution status unavailable' });
  }
});

router.post('/sync', async (_req, res) => {
  try {
    await contributionStore.syncPending();
    res.json(await contributionStore.status());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Contribution sync unavailable' });
  }
});

router.post('/withdraw', async (_req, res) => {
  try {
    const profile = await profileStore.get();
    const updated = await profileStore.patch({
      preferences: { ...profile.preferences, khmerContributionConsent: 'declined' },
    });
    await contributionStore.requestWithdrawal();
    // Give an online deletion request one immediate chance; failure remains safely pending.
    await contributionStore.syncPending();
    res.json(await contributionStore.status(updated));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not update contribution privacy' });
  }
});

export default router;
