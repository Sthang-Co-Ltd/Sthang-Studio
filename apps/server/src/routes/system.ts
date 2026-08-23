import { Router, type Response } from 'express';
import { runSystemDoctor } from '../services/doctor.js';
import {
  forgetSecureGeminiKey,
  publicLlmSettings,
  saveLlmSettings,
  testGeminiConnection,
} from '../services/llm-settings.js';

const router = Router();

function preventSecretCaching(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

router.get('/doctor', async (_req, res) => {
  try {
    res.json(await runSystemDoctor());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'System doctor failed' });
  }
});

router.get('/llm-settings', async (_req, res) => {
  preventSecretCaching(res);
  try {
    res.json(await publicLlmSettings());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not read AI settings' });
  }
});

router.put('/llm-settings', async (req, res) => {
  preventSecretCaching(res);
  try {
    res.json(await saveLlmSettings({
      apiKey: req.body?.apiKey,
      model: req.body?.model,
      fallbackModel: req.body?.fallbackModel,
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save AI settings' });
  }
});

router.delete('/llm-settings/key', async (_req, res) => {
  preventSecretCaching(res);
  try {
    res.json(await forgetSecureGeminiKey());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not forget the saved API key' });
  }
});

router.post('/llm-settings/test', async (req, res) => {
  preventSecretCaching(res);
  try {
    res.json(await testGeminiConnection({ apiKey: req.body?.apiKey, model: req.body?.model }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Gemini connection test failed' });
  }
});

export default router;
