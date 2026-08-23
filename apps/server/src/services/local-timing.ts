import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import type { TimingResult, TimingWord } from './timing-types.js';
import { levenshteinSimilarity, normalizeForMatch, tokenizeText } from './tokenizer.js';

interface WorkerResult extends TimingResult {
  detectedLanguage?: string;
  languageProbability?: number;
}

function run(command: string, args: string[], label: string): Promise<{ stdout: string; stderr: string }> {
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
  // Repeated words spoken back-to-back are legitimate and must never be collapsed.
  // Only dedupe near-identical anchors when their actual time ranges substantially overlap.
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

export async function alignTimingLocally(wavPath: string, workDir: string, geminiTranscript: string): Promise<TimingResult> {
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
  ];
  if (!config.localKfaEnabled) args.push('--disable-kfa');
  if (!config.localWhisperFallbackEnabled) args.push('--disable-whisper-fallback');

  try {
    await run(config.localTimingPython, args, 'Local Khmer timing');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|could not start/i.test(message)) {
      throw new Error(`Local timing is not installed. Run setup-local-timing-windows.bat once, then restart the app. ${message}`);
    }
    throw new Error(`Local timing failed. No Google Cloud timing API was called. ${message}`);
  }

  let parsed: WorkerResult;
  try {
    parsed = JSON.parse(await fs.readFile(outputPath, 'utf8')) as WorkerResult;
  } catch (error) {
    throw new Error(`Local timing worker did not produce valid JSON. ${error instanceof Error ? error.message : error}`);
  }

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
