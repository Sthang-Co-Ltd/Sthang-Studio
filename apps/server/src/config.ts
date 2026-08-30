import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '../../..');
export const stateRootDir = path.resolve(process.env.STHANG_STUDIO_STATE_ROOT || rootDir);
const environmentFile = process.env.STHANG_STUDIO_ENV_FILE || path.join(stateRootDir, 'apps', 'server', '.env');

dotenv.config({ path: environmentFile });

const defaultVenvPython = process.platform === 'win32'
  ? path.join(rootDir, '.venv', 'Scripts', 'python.exe')
  : path.join(rootDir, '.venv', 'bin', 'python');

function envBool(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function envThinkingLevel(name: string, fallback: 'low' | 'medium' | 'high') {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(raw) ? raw as 'low' | 'medium' | 'high' : fallback;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5188',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.7-flash',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.6-flash',
  geminiMaxRetries: Math.max(0, Math.min(6, Number(process.env.GEMINI_MAX_RETRIES || 2))),
  geminiRetryBaseMs: Math.max(250, Math.min(10000, Number(process.env.GEMINI_RETRY_BASE_MS || 1000))),
  geminiRetryMaxMs: Math.max(1000, Math.min(120000, Number(process.env.GEMINI_RETRY_MAX_MS || 60000))),
  // Verbatim transcription is latency-sensitive and does not need agent-style reasoning.
  // Gemini 3.7 Flash supports low/medium/high; low remains configurable for A/B testing.
  geminiTranscriptionThinkingLevel: envThinkingLevel('GEMINI_TRANSCRIPTION_THINKING_LEVEL', 'low'),
  // Best-effort use of the current Interactions API ASR custom_vocabulary feature.
  // If an older SDK/backend rejects it, gemini.ts falls back to prompt-based protection automatically.
  geminiNativeVocabularyBias: envBool('GEMINI_NATIVE_VOCABULARY_BIAS', true),

  // v0.7 timing remains local-only by default. KFA directly force-aligns Gemini's
  // Khmer transcript; faster-whisper is a LOCAL fallback. No cloud timing adapter
  // is invoked automatically.
  localTimingPython: process.env.LOCAL_TIMING_PYTHON || defaultVenvPython,
  localKfaEnabled: envBool('LOCAL_KFA_ENABLED', true),
  localWhisperFallbackEnabled: envBool('LOCAL_WHISPER_FALLBACK_ENABLED', true),
  localWhisperModel: process.env.LOCAL_WHISPER_MODEL || 'turbo',
  localWhisperDevice: process.env.LOCAL_WHISPER_DEVICE || 'auto',
  localWhisperComputeType: process.env.LOCAL_WHISPER_COMPUTE_TYPE || 'auto',
  localWhisperLanguage: process.env.LOCAL_WHISPER_LANGUAGE || 'km',
  localWhisperBeamSize: Math.max(1, Math.min(10, Number(process.env.LOCAL_WHISPER_BEAM_SIZE || 5))),
  localWhisperVadMinSilenceMs: Math.max(100, Math.min(2000, Number(process.env.LOCAL_WHISPER_VAD_MIN_SILENCE_MS || 400))),

  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 500),
  uploadDir: path.join(stateRootDir, 'uploads'),
  workingDir: path.join(stateRootDir, 'data', 'working'),
  exportDir: path.join(stateRootDir, 'exports'),
  dataFile: path.join(stateRootDir, 'data', 'projects.json'),
  profileFile: path.join(stateRootDir, 'data', 'profile.json'),
  cacheDir: path.join(stateRootDir, 'data', 'cache'),
  historyDir: path.join(stateRootDir, 'data', 'history'),
  proposalDir: path.join(stateRootDir, 'data', 'proposals'),
  jobsFile: path.join(stateRootDir, 'data', 'jobs.json'),
  localTimingWorker: path.join(rootDir, 'local-timing', 'worker.py'),
  updateDir: path.join(stateRootDir, 'updates'),
  versionsDir: path.join(stateRootDir, 'versions'),
  rangeContextPaddingMs: Math.max(250, Math.min(5000, Number(process.env.RANGE_CONTEXT_PADDING_MS || 1200))),
};

export function localTimingConfigured() {
  return fs.existsSync(config.localTimingPython) && fs.existsSync(config.localTimingWorker);
}
