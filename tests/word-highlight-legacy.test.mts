import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCaptionData, exportContentBasis, hydrateCaptionWordTimings, normalizeCaptionAppearance,
  compileHighlightPlan, planCaptionRenderStates, resolveCaptionWordTiming, resolveWordExport, serializeCaptionFile,
  type CaptionProject, type CaptionSegment, type CaptionWord, type ExportEvidenceFormat, type TimedToken,
} from '../packages/shared/src/index.js';
import { buildExportCaptionIssues } from '../apps/web/src/export-checks.js';

const golden = new URL('./fixtures/word-highlight-legacy.json', import.meta.url);
const formats = ['srt', 'vtt', 'ttml', 'word-srt', 'word-vtt', 'data'] as const;
const evidenceFormats: ExportEvidenceFormat[] = [...formats, 'ass', 'bundle', 'video'];

function cue(id: string, startMs = 100): CaptionSegment {
  const text = 'AI ខ្មែរ';
  return {
    id, text, startMs, endMs: startMs + 400, approved: true,
    wordTiming: {
      version: 1, text, words: [
        { id: id + '-0', source: 'aligned', startOffset: 0, endOffset: 2, startMs: startMs + 14, endMs: startMs + 106 },
        { id: id + '-1', source: 'manual', startOffset: 3, endOffset: text.length, startMs: startMs + 130, endMs: startMs + 284 },
      ],
    },
  };
}

function partial(id: string, start: number, change: Partial<CaptionWord>): CaptionSegment {
  const caption = cue(id, start);
  Object.assign(caption.wordTiming!.words[0], change);
  return caption;
}

function project(id: string, captions: CaptionSegment[], appearance: CaptionProject['captionAppearance']): CaptionProject {
  return {
    id, title: 'Synthetic paired captions', captions, mode: 'phrase', transcript: null,
    captionAppearance: appearance, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    media: { filename: 'synthetic.mp4', originalName: 'synthetic.mp4', url: '/media/synthetic.mp4', size: 1, mimeType: 'video/mp4' },
  };
}

function fixtures() {
  const word = normalizeCaptionAppearance({ fontFamily: 'Khmer UI', highlightMode: 'word', textColor: '#FFFFFF', highlightColor: '#D7FF4F' });
  const { wordTiming: _missing, ...missing } = cue('missing', 4000);
  const stale = cue('stale');
  stale.text += '!';
  const { wordTiming: _hydrated, ...caption } = cue('hydrated');
  const tokens: TimedToken[] = [
    { id: 'transcript-0', text: 'AI', startMs: 114, endMs: 206, spaceBefore: false, timingSource: 'stt', confidence: 0.99 },
    { id: 'transcript-1', text: 'ខ្មែរ', startMs: 230, endMs: 384, spaceBefore: true, timingSource: 'stt', confidence: 0.99 },
  ];
  const hydrated = project('hydrated', [caption], { ...word, motionPreset: 'soft-pop' });
  hydrated.transcript = { language: 'km', fullText: caption.text, segments: [caption], tokens };
  return [
    project('ready', [cue('ready')], word),
    project('ready-off', [cue('ready-off')], { ...word, highlightMode: 'off' }),
    project('motion-overlap', [cue('first'), cue('second', 235)], { ...word, motionPreset: 'rise' }),
    project('incomplete', [
      partial('null-pair', 100, { startMs: null, endMs: null }),
      partial('review', 750, { needsReview: true }),
      partial('estimated', 1400, { source: 'estimated' }),
      partial('outside', 2050, { startMs: 2040 }),
      partial('overlap', 2700, { endMs: 2840 }),
      partial('collapse', 3350, { startMs: 3360, endMs: 3364 }),
      missing, { id: 'punctuation', text: '...', startMs: 4550, endMs: 4950 },
    ], { ...word, motionPreset: 'fade' }),
    project('stale', [stale], word),
    hydrated,
  ];
}

function capture<T>(read: () => T) {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message };
  }
}

test('legacy render and export bytes match main at 8b70a47', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-highlight-golden-'));
  process.env.STHANG_STUDIO_STATE_ROOT = root;
  process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
  process.env.GEMINI_API_KEY = '';
  process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
  process.env.STHANG_ANALYTICS_ENDPOINT = '';
  try {
    const { buildAssDocument } = await import('../apps/server/src/services/caption-renderer.js');
    const { captionHandoffRevision, createCaptionHandoffService } = await import('../apps/server/src/services/caption-handoff.js');
    const result = [];
    for (const input of fixtures()) {
      const { captions } = hydrateCaptionWordTimings(input);
      const appearance = normalizeCaptionAppearance(input.captionAppearance);
      const service = createCaptionHandoffService({
        getProject: async () => input,
        withProjectWrite: async (_id, operation) => operation(input, async () => { throw new Error('This export cannot write the project.'); }),
        checkpoint: async () => { throw new Error('This export cannot write History.'); },
        hasActiveForProject: () => false,
        geometry: async () => ({ width: 640, height: 360 }),
        mediaDuration: async () => 6000,
        buildAss: (cues, style, width, height) => buildAssDocument(cues, style, width, height),
      });
      let bundle: { sha256: string; warnings: string[] } | { error: string };
      try {
        const { body, warnings } = await service.export(input.id, {
          format: 'bundle', expectedMedia: input.media, expectedRevision: captionHandoffRevision(input),
        });
        bundle = { sha256: createHash('sha256').update(body).digest('hex'), warnings };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        bundle = { error: error.message };
      }
      result.push({
        id: input.id,
        legacyTiming: captions.map((caption) => {
          const { state, reason } = resolveCaptionWordTiming(caption);
          return { id: caption.id, state, reason };
        }),
        states: planCaptionRenderStates(captions, appearance.highlightMode === 'word', appearance),
        ass: buildAssDocument(captions, appearance, 640, 360),
        basis: Object.fromEntries(evidenceFormats.map((format) => [format, capture(() => exportContentBasis(input, format))])),
        files: Object.fromEntries(formats.map((format) => [format, capture(() => serializeCaptionFile({ captions, appearance }, format))])),
        data: capture(() => createCaptionData({ captions, appearance })),
        bundle,
        exportChecks: Object.fromEntries(evidenceFormats.map((format) => [format, buildExportCaptionIssues({ captions, appearance, format, reviewIssues: [] })])),
      });
    }
    const bytes = JSON.stringify(result) + '\n';
    if (process.env.STHANG_CAPTURE_LEGACY_HIGHLIGHT_GOLDEN === '1') {
      await writeFile(golden, bytes);
    } else {
      assert.equal(bytes, await readFile(golden, 'utf8'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy compiler and word export keep the base resolver decisions for every golden caption', () => {
  for (const input of fixtures()) {
    for (const caption of hydrateCaptionWordTimings(input).captions) {
      const legacy = resolveCaptionWordTiming(caption);
      const ready = legacy.state === 'ready';
      const plan = compileHighlightPlan(caption, 'measured-and-manual');
      assert.equal(plan.coverage, ready ? 'full-individual' : 'none', caption.id);
      assert.equal(plan.spans.length, ready ? legacy.words.length : 0, caption.id);
      assert.deepEqual(resolveWordExport(caption), ready ? { ready: true, words: legacy.words }
        : { ready: false, reason: legacy.reason || 'This caption has no saved word timing.' }, caption.id);
    }
  }
});
