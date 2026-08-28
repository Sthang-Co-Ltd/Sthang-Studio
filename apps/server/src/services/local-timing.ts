import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { config } from '../config.js';
import type { TimingResult, TimingWord } from './timing-types.js';
import { levenshteinSimilarity, normalizeForMatch, tokenizeText } from './tokenizer.js';

interface WorkerResult extends TimingResult {
  detectedLanguage?: string;
  languageProbability?: number;
}

interface WorkerResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface TimingCacheEnvelope {
  version: 1;
  createdAt: string;
  result: TimingResult;
}

class LocalTimingWorkerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalTimingWorkerTransportError';
  }
}

const workerRequestTimeoutMs = 10 * 60 * 1000;
const localTimingResultCacheVersion = 'local-timing-result-v1';
const maxTimingResultFiles = 256;
const maxTimingResultBytes = 64 * 1024 * 1024;
let workerProcess: ChildProcessWithoutNullStreams | null = null;
let workerStdoutBuffer = '';
let workerRequestCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();

function safeCacheNamespace(value: string | undefined) {
  const normalized = String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return normalized || '_shared';
}

function inferCacheNamespace(workDir: string, explicit?: string) {
  if (explicit) return safeCacheNamespace(explicit);
  const relativeCache = path.relative(config.cacheDir, workDir);
  if (relativeCache && !relativeCache.startsWith('..') && !path.isAbsolute(relativeCache)) {
    const first = relativeCache.split(path.sep)[0];
    if (first) return safeCacheNamespace(first);
  }
  const relativeWork = path.relative(config.workingDir, workDir);
  if (relativeWork && !relativeWork.startsWith('..') && !path.isAbsolute(relativeWork)) {
    const first = relativeWork.split(path.sep)[0];
    const marker = first.lastIndexOf('-proposal-');
    if (marker > 0) return safeCacheNamespace(first.slice(0, marker));
  }
  return '_shared';
}

function projectTimingCacheRoot(cacheNamespace?: string) {
  return path.join(config.cacheDir, safeCacheNamespace(cacheNamespace));
}

function emissionCacheDirFor(cacheNamespace?: string) {
  return path.join(projectTimingCacheRoot(cacheNamespace), 'timing-emissions');
}

function timingResultCacheDirFor(cacheNamespace?: string) {
  return path.join(projectTimingCacheRoot(cacheNamespace), 'timing-results');
}

function timingOptions(cacheNamespace?: string) {
  return {
    disableKfa: !config.localKfaEnabled,
    disableWhisperFallback: !config.localWhisperFallbackEnabled,
    model: config.localWhisperModel,
    device: config.localWhisperDevice,
    computeType: config.localWhisperComputeType,
    language: config.localWhisperLanguage,
    beamSize: config.localWhisperBeamSize,
    vadMinSilenceMs: config.localWhisperVadMinSilenceMs,
    emissionCacheDir: emissionCacheDirFor(cacheNamespace),
  };
}

async function audioIdentity(wavPath: string) {
  const stat = await fs.stat(wavPath);
  const inode = Number(stat.ino || 0);
  const device = Number(stat.dev || 0);
  const mtime = stat.mtimeMs.toFixed(3);
  return inode
    ? `inode:${device}:${inode}:${stat.size}:${mtime}`
    : `path:${path.resolve(wavPath)}:${stat.size}:${mtime}`;
}

async function timingCachePath(wavPath: string, transcript: string, cacheNamespace?: string) {
  const identity = await audioIdentity(wavPath);
  const signature = crypto.createHash('sha256').update(JSON.stringify({
    version: localTimingResultCacheVersion,
    identity,
    transcript,
    kfaEnabled: config.localKfaEnabled,
    whisperFallbackEnabled: config.localWhisperFallbackEnabled,
    whisperModel: config.localWhisperModel,
    whisperDevice: config.localWhisperDevice,
    whisperComputeType: config.localWhisperComputeType,
    whisperLanguage: config.localWhisperLanguage,
    whisperBeamSize: config.localWhisperBeamSize,
    whisperVadMinSilenceMs: config.localWhisperVadMinSilenceMs,
  })).digest('hex').slice(0, 32);
  return path.join(timingResultCacheDirFor(cacheNamespace), `${signature}.json`);
}

async function trimTimingResultCache(directory: string, keepPath: string) {
  try {
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'));
    const entries = (await Promise.all(names.map(async (name) => {
      const filePath = path.join(directory, name);
      try {
        const stat = await fs.stat(filePath);
        return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }))).filter((entry): entry is { filePath: string; size: number; mtimeMs: number } => Boolean(entry));
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let keptFiles = 0;
    let keptBytes = 0;
    for (const entry of entries) {
      const isCurrent = entry.filePath === keepPath;
      const fits = keptFiles < maxTimingResultFiles && keptBytes + entry.size <= maxTimingResultBytes;
      if (isCurrent || fits) {
        keptFiles += 1;
        keptBytes += entry.size;
      } else {
        await fs.rm(entry.filePath, { force: true });
      }
    }
  } catch {
    // Timing-result caching is optional and must never block caption generation.
  }
}

async function readTimingResultCache(cachePath: string) {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as TimingCacheEnvelope;
    if (parsed?.version !== 1 || !parsed.result?.words?.length) return null;
    const now = new Date();
    await fs.utimes(cachePath, now, now).catch(() => {});
    return parsed.result;
  } catch {
    return null;
  }
}

async function writeTimingResultCache(cachePath: string, result: TimingResult) {
  const temp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const envelope: TimingCacheEnvelope = {
      version: 1,
      createdAt: new Date().toISOString(),
      result,
    };
    await fs.writeFile(temp, JSON.stringify(envelope), 'utf8');
    await fs.rename(temp, cachePath);
    await trimTimingResultCache(path.dirname(cachePath), cachePath);
  } catch (error) {
    console.warn(`[local timing] Could not persist timing-result cache: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function rejectPendingTransport(message: string) {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new LocalTimingWorkerTransportError(message));
    pendingRequests.delete(id);
  }
}

function resetWorker(child: ChildProcessWithoutNullStreams, message: string) {
  if (workerProcess !== child) return;
  workerProcess = null;
  workerStdoutBuffer = '';
  rejectPendingTransport(message);
}

function handleWorkerLine(child: ChildProcessWithoutNullStreams, line: string) {
  let response: WorkerResponse;
  try {
    response = JSON.parse(line) as WorkerResponse;
  } catch {
    child.kill();
    resetWorker(child, `Persistent local timing worker returned malformed protocol output: ${line.slice(0, 200)}`);
    return;
  }
  if (!response.id) {
    child.kill();
    resetWorker(child, 'Persistent local timing worker returned a response without a request id.');
    return;
  }
  const pending = pendingRequests.get(response.id);
  if (!pending) return;
  pendingRequests.delete(response.id);
  clearTimeout(pending.timer);
  if (response.ok) pending.resolve(response.result);
  else pending.reject(new Error(response.error || 'Persistent local timing worker failed.'));
}

function ensureWorker() {
  if (workerProcess && !workerProcess.killed) return workerProcess;
  const child = spawn(config.localTimingPython, [config.localTimingWorker, '--server'], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  workerProcess = child;
  workerStdoutBuffer = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (workerProcess !== child) return;
    workerStdoutBuffer += chunk;
    while (true) {
      const newline = workerStdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = workerStdoutBuffer.slice(0, newline).trim();
      workerStdoutBuffer = workerStdoutBuffer.slice(newline + 1);
      if (line) handleWorkerLine(child, line);
    }
  });
  child.stderr.on('data', (text: string) => process.stderr.write(`[local timing] ${text}`));
  child.on('error', (error) => resetWorker(child, `Persistent local timing worker could not start (${config.localTimingPython}). ${error.message}`));
  child.on('close', (code) => resetWorker(child, `Persistent local timing worker stopped unexpectedly (exit ${code ?? 'unknown'}).`));
  return child;
}

function requestWorker(action: 'warm' | 'prepare' | 'align', payload: Record<string, unknown> = {}, cacheNamespace?: string) {
  const child = ensureWorker();
  const id = `${process.pid}-${Date.now()}-${++workerRequestCounter}`;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      child.kill();
      pending.reject(new LocalTimingWorkerTransportError(`Persistent local timing worker timed out during ${action}.`));
      resetWorker(child, `Persistent local timing worker timed out during ${action}.`);
    }, workerRequestTimeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ id, action, ...payload, options: timingOptions(cacheNamespace) })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      child.kill();
      resetWorker(child, `Could not send work to persistent local timing worker. ${error instanceof Error ? error.message : String(error)}`);
      reject(new LocalTimingWorkerTransportError(error instanceof Error ? error.message : String(error)));
    }
  });
}

function runOneShot(command: string, args: string[], label: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => {
      const text = String(d);
      stderr += text;
      process.stderr.write(`[local timing] ${text}`);
    });
    child.on('error', (error) => reject(new Error(`${label} could not start (${command}). ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} failed (exit ${code}). ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * A timing engine can emit one orthographic span that Intl.Segmenter considers
 * multiple Khmer display tokens. Interpolation is permitted only inside that trusted
 * word time range—not across a Gemini paragraph.
 */
function splitTimingWord(word: TimingWord): TimingWord[] {
  const tokens = tokenizeText(word.text);
  if (tokens.length <= 1) return [{ ...word, text: tokens[0]?.text || word.text.trim() }];
  const lengths = tokens.map((t) => Math.max(1, [...t.normalized].length));
  const total = lengths.reduce((a, b) => a + b, 0);
  const span = Math.max(tokens.length * 35, word.endMs - word.startMs);
  let cursor = word.startMs;
  return tokens.map((token, i) => {
    const end = i === tokens.length - 1 ? word.endMs : Math.round(cursor + span * lengths[i] / total);
    const item: TimingWord = {
      text: token.text,
      startMs: cursor,
      endMs: Math.max(cursor + 35, end),
      confidence: word.confidence,
      derived: true,
    };
    cursor = item.endMs;
    return item;
  });
}

function areDuplicate(a: TimingWord, b: TimingWord) {
  const overlap = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const shorter = Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
  if (overlap / shorter < 0.6) return false;
  const na = normalizeForMatch(a.text);
  const nb = normalizeForMatch(b.text);
  if (!na || !nb) return false;
  return na === nb || levenshteinSimilarity(na, nb) >= 0.82;
}

function cleanWords(words: TimingWord[]) {
  const sorted = words
    .filter((w) => w.text?.trim() && Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs > w.startMs)
    .flatMap(splitTimingWord)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: TimingWord[] = [];
  for (const word of sorted) {
    const last = out.at(-1);
    if (last && areDuplicate(last, word)) {
      if ((word.confidence ?? 0) > (last.confidence ?? 0)) out[out.length - 1] = word;
      continue;
    }
    out.push(word);
  }
  return out;
}

function normalizedTimingResult(parsed: WorkerResult): TimingResult {
  const words = cleanWords(parsed.words || []);
  if (!words.length) throw new Error('Local timing returned no usable word anchors.');
  return {
    transcript: parsed.transcript || words.map((w) => w.text).join(' '),
    words,
    engine: parsed.engine,
    provider: 'local',
    model: parsed.model,
    device: parsed.device,
    computeType: parsed.computeType,
    directAlignment: parsed.directAlignment,
    fallbackReason: parsed.fallbackReason,
  };
}

async function alignTimingOneShot(wavPath: string, workDir: string, geminiTranscript: string, cacheNamespace?: string): Promise<WorkerResult> {
  await fs.mkdir(workDir, { recursive: true });
  const outputPath = path.join(workDir, 'local-timing.json');
  const transcriptPath = path.join(workDir, 'gemini-transcript.txt');
  await fs.writeFile(transcriptPath, geminiTranscript, 'utf8');
  const args = [
    config.localTimingWorker,
    '--audio', wavPath,
    '--transcript-file', transcriptPath,
    '--output', outputPath,
    '--model', config.localWhisperModel,
    '--device', config.localWhisperDevice,
    '--compute-type', config.localWhisperComputeType,
    '--language', config.localWhisperLanguage,
    '--beam-size', String(config.localWhisperBeamSize),
    '--vad-min-silence-ms', String(config.localWhisperVadMinSilenceMs),
    '--emission-cache-dir', emissionCacheDirFor(cacheNamespace),
  ];
  if (!config.localKfaEnabled) args.push('--disable-kfa');
  if (!config.localWhisperFallbackEnabled) args.push('--disable-whisper-fallback');
  await runOneShot(config.localTimingPython, args, 'Local Khmer timing');
  try {
    return JSON.parse(await fs.readFile(outputPath, 'utf8')) as WorkerResult;
  } catch (error) {
    throw new Error(`Local timing worker did not produce valid JSON. ${error instanceof Error ? error.message : error}`);
  }
}

export async function prewarmLocalTiming(cacheNamespace?: string) {
  try {
    await requestWorker('warm', {}, cacheNamespace);
    return true;
  } catch (error) {
    console.warn(`[local timing] Persistent worker prewarm skipped: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Compute/cache transcript-independent KFA evidence while the cloud transcript is still running. */
export async function prepareTimingLocally(wavPath: string, cacheNamespace?: string) {
  if (!config.localKfaEnabled) return false;
  try {
    await requestWorker('prepare', { audio: wavPath }, cacheNamespace);
    return true;
  } catch (error) {
    console.warn(`[local timing] Acoustic precomputation skipped; normal alignment will retry. ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function alignTimingLocally(wavPath: string, workDir: string, geminiTranscript: string, cacheNamespace?: string): Promise<TimingResult> {
  const namespace = inferCacheNamespace(workDir, cacheNamespace);
  const cachePath = await timingCachePath(wavPath, geminiTranscript, namespace);
  const cached = await readTimingResultCache(cachePath);
  if (cached) {
    console.log('[local timing] Deterministic timing-result cache hit.');
    return cached;
  }

  let parsed: WorkerResult;
  try {
    parsed = await requestWorker('align', { audio: wavPath, transcript: geminiTranscript }, namespace) as WorkerResult;
  } catch (error) {
    if (error instanceof LocalTimingWorkerTransportError) {
      console.warn(`[local timing] Persistent worker unavailable; using one-shot recovery path. ${error.message}`);
      try {
        parsed = await alignTimingOneShot(wavPath, workDir, geminiTranscript, namespace);
      } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        if (/ENOENT|could not start/i.test(message)) {
          throw new Error(`Local timing is not installed. Run setup-local-timing-windows.bat once, then restart the app. ${message}`);
        }
        throw new Error(`Local timing failed. No Google Cloud timing API was called. ${message}`);
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Local timing failed. No Google Cloud timing API was called. ${message}`);
    }
  }
  const result = normalizedTimingResult(parsed);
  await writeTimingResultCache(cachePath, result);
  return result;
}
