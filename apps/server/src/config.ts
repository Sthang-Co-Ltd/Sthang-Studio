import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '../../..');

dotenv.config({ path: path.join(rootDir, 'apps', 'server', '.env') });

const defaultVenvPython = process.platform === 'win32'
  ? path.join(rootDir, '.venv', 'Scripts', 'python.exe')
  : path.join(rootDir, '.venv', 'bin', 'python');

function envBool(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
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
  // Dedicated ASR is the default acoustic text pass. General Gemini remains the
  // contextual/alternative listener and the compatibility fallback.
  geminiDedicatedTranscriptionEnabled: envBool('GEMINI_DEDICATED_TRANSCRIPTION_ENABLED', true),
  geminiTranscribeModel: process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
  // For a normal full generation, topic description is the signal that a second
  // context-aware listen can add value beyond the dedicated acoustic transcript.
  geminiContextualRefinementEnabled: envBool('GEMINI_CONTEXTUAL_REFINEMENT_ENABLED', true),
  // Best-effort use of the Interactions API ASR custom_vocabulary feature on the
  // general-model compatibility/context path. If rejected, gemini.ts degrades to
  // prompt-based vocabulary protection automatically.
  geminiNativeVocabularyBias: envBool('GEMINI_NATIVE_VOCABULARY_BIAS', true),

  // v0.7 timing remains local-only by default. KFA directly force-aligns the
  // selected transcript; faster-whisper is a LOCAL fallback. Gemini Transcribe
  // word timestamps are intentionally not the primary timing source.
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
  uploadDir: path.join(rootDir, 'uploads'),
  workingDir: path.join(rootDir, 'data', 'working'),
  exportDir: path.join(rootDir, 'exports'),
  dataFile: path.join(rootDir, 'data', 'projects.json'),
  profileFile: path.join(rootDir, 'data', 'profile.json'),
  cacheDir: path.join(rootDir, 'data', 'cache'),
  historyDir: path.join(rootDir, 'data', 'history'),
  proposalDir: path.join(rootDir, 'data', 'proposals'),
  jobsFile: path.join(rootDir, 'data', 'jobs.json'),
  localTimingWorker: path.join(rootDir, 'local-timing', 'worker.py'),
  rangeContextPaddingMs: Math.max(250, Math.min(5000, Number(process.env.RANGE_CONTEXT_PADDING_MS || 1200))),
};

export function localTimingConfigured() {
  return fs.existsSync(config.localTimingPython) && fs.existsSync(config.localTimingWorker);
}
