import { Router } from 'express';
import type { CaptionProject } from '@kcs/shared';
import { profileStore, VideoExportPresetConflictError, VideoExportPresetNotFoundError } from '../services/profile-store.js';
import { contributionStore } from '../services/contribution-store.js';
import { resetAnalyticsIdentity } from '../services/analytics.js';
import { ProjectBinError, store } from '../services/store.js';
import { normalizeTranscriptionContext } from '../services/vocabulary.js';

const router = Router();

router.get('/', async (_req, res) => {
  res.json(await profileStore.get());
});

router.patch('/', async (req, res) => {
  try {
    const before = await profileStore.get();
    const updated = await profileStore.patch(req.body);
    const previousContribution = before.preferences.khmerContributionConsent || 'unset';
    const nextContribution = updated.preferences.khmerContributionConsent || 'unset';
    if (previousContribution !== nextContribution) await contributionStore.syncConsent(nextContribution);

    const previousAnalytics = before.preferences.analyticsConsent || 'unset';
    const nextAnalytics = updated.preferences.analyticsConsent || 'unset';
    if (previousAnalytics !== nextAnalytics && nextAnalytics !== 'granted') await resetAnalyticsIdentity();
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Profile update failed' });
  }
});

router.put('/video-export-settings', async (req, res) => {
  try {
    res.json(await profileStore.setLastVideoExportSettings(req.body?.settings));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save video export settings.' });
  }
});

router.post('/video-export-presets', async (req, res) => {
  try {
    res.json(await profileStore.upsertVideoExportPreset(req.body));
  } catch (error) {
    const status = error instanceof VideoExportPresetNotFoundError ? 404 : error instanceof VideoExportPresetConflictError ? 409 : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Could not save video export preset.' });
  }
});

router.delete('/video-export-presets/:id', async (req, res) => {
  try {
    res.json(await profileStore.deleteVideoExportPreset(req.params.id));
  } catch (error) {
    res.status(error instanceof VideoExportPresetNotFoundError ? 404 : 400).json({
      error: error instanceof Error ? error.message : 'Could not delete video export preset.',
    });
  }
});

router.get('/export', async (_req, res) => {
  const profile = structuredClone(await profileStore.get());
  // The privacy-introduction marker belongs to this installation, not the
  // transferable creator profile. Imports preserve the receiving installation's marker.
  delete profile.preferences.privacyUpgradeNoticeVersion;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sthang-studio-profile.json"');
  res.send(JSON.stringify(profile, null, 2));
});

router.post('/import', async (req, res) => {
  try {
    const profile = await profileStore.replace(req.body);
    await contributionStore.syncConsent('unset');
    await resetAnalyticsIdentity();
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Profile import failed' });
  }
});

router.post('/corrections/:id/action', async (req, res) => {
  const action = req.body?.action;
  try {
    if (action !== 'remember-global' && action !== 'add-project' && action !== 'ignore') {
      return res.status(400).json({ error: 'Unknown correction action.' });
    }

    if (action !== 'add-project') {
      const result = await profileStore.actOnCorrection(req.params.id, action);
      return res.json({ profile: result.profile, project: null });
    }
    const queued = (await profileStore.get()).correctionEvents.find((event) => event.id === req.params.id);
    if (!queued) return res.status(404).json({ error: 'Correction event not found.' });
    const result = await store.withProjectWrite(queued.projectId, async (current, persist) => {
      if (!current) throw new ProjectBinError(store.isHiddenByBin(queued.projectId) ? 'project_binned' : 'not_found');
      let project: CaptionProject | undefined;
      const decision = await profileStore.actOnCorrection(req.params.id, action, async (event) => {
        if (event.projectId !== current.id) throw new ProjectBinError('not_found');
        const context = normalizeTranscriptionContext(current.transcriptionContext);
        context.vocabulary = profileStore.addVocabularyLine(context.vocabulary, event.suggestedVocabularyLine);
        project = await persist({
          ...current,
          transcriptionContext: context,
          updatedAt: new Date().toISOString(),
        });
      });
      return { profile: decision.profile, project };
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ProjectBinError) return res.status(error.code === 'project_binned' ? 409 : 404).json({ error: error.message, code: error.code });
    if (action === 'add-project') return res.status(500).json({ error: 'Studio could not save the project correction.' });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Correction action failed' });
  }
});

export default router;
