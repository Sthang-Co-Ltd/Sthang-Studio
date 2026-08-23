import express from 'express';
import cors from 'cors';
import { config, localTimingConfigured } from './config.js';
import projects from './routes/projects.js';
import profile from './routes/profile.js';
import system from './routes/system.js';
import jobs from './routes/jobs.js';
import { proposalStore } from './services/proposal-store.js';
import { publicLlmSettings, resolveGeminiSettings } from './services/llm-settings.js';

const app = express();
app.disable('x-powered-by');
void proposalStore.cleanup();
const allowedBrowserOrigins = new Set([
  config.webOrigin,
  'http://localhost:5188',
  'http://127.0.0.1:5188',
]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedBrowserOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
}));
app.use(express.json({ limit: '8mb' }));
app.use('/media', express.static(config.uploadDir));
app.use('/api/projects', projects);
app.use('/api/profile', profile);
app.use('/api/system', system);
app.use('/api/jobs', jobs);
app.get('/api/health', async (_req, res) => {
  try {
    const llm = await publicLlmSettings();
    res.json({
      ok: true,
      engineVersion: '0.7.10',
      geminiModel: llm.model,
      geminiFallbackModel: llm.fallbackModel || null,
      geminiMaxRetries: config.geminiMaxRetries,
      geminiNativeVocabularyBias: config.geminiNativeVocabularyBias,
      llm,
      features: {
        correctionInbox: true,
        riskReview: true,
        selectiveRegeneration: true,
        stageCache: true,
        profileTransfer: true,
        systemDoctor: true,
        professionalWaveform: true,
        captionLocks: true,
        regenerationDiff: true,
        findReplace: true,
        qaProfiles: true,
        projectHistory: true,
        persistentJobs: true,
        inAppAiSettings: true,
        secureWindowsKeyStorage: true,
        minimalScrollbars: true,
      },
      timing: {
        provider: 'local',
        configured: localTimingConfigured(),
        engine: 'kfa-local',
        model: 'wav2vec2-km-base-1500',
        fallbackEngine: config.localWhisperFallbackEnabled ? 'faster-whisper-local' : null,
        fallbackModel: config.localWhisperFallbackEnabled ? config.localWhisperModel : null,
        device: 'cpu',
        language: 'km',
        paidApi: false,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Health check failed' });
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Unexpected server error' });
});

app.listen(config.port, '127.0.0.1', () => {
  void resolveGeminiSettings().then((llm) => {
    console.log(`Sthang Studio API v0.7.10 -> http://localhost:${config.port}`);
    console.log(`Gemini: ${llm.configured ? `configured via ${llm.keySource}` : 'not configured — open Settings → AI connection'}`);
    console.log(`Gemini text model: ${llm.model}`);
    console.log(`Gemini resilience: ${config.geminiMaxRetries} retries/model · fallback ${llm.fallbackModel || 'disabled'}`);
  }).catch((error) => console.warn('[AI settings] Startup status unavailable:', error instanceof Error ? error.message : error));
  console.log('Correction memory: automatic edit capture + approval inbox');
  console.log('Stage cache: normalized audio + Gemini/timing stages');
  console.log('Professional review: waveform + locks + diff approval + history');
  console.log('Background jobs: persistent queue with retry/resume');
  console.log('Timing primary: KFA Khmer forced alignment (local CPU/ONNX)');
  console.log(`Timing fallback: ${config.localWhisperFallbackEnabled ? `local faster-whisper ${config.localWhisperModel}` : 'disabled'}`);
  console.log('Paid cloud timing: OFF / not wired into automatic fallback');
});
