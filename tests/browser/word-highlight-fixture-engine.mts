import { highlightDisplayUnits } from '@kcs/shared';
import { mediaFingerprint } from '../../apps/server/src/services/cache.js';
import { store } from '../../apps/server/src/services/store.js';
import { createWordHighlightEngine, wordHighlightEngine } from '../../apps/server/src/services/word-highlight-engine.js';

const durationMs = 4_000;
const sampleRate = 16_000;
// A frame represents one millisecond of the four-second fixture.
const clock = { sampleCount: durationMs * sampleRate / 1_000, sampleRate, frameCount: durationMs };

export function installFixtureWordHighlightEngine(captionIds: string[]) {
  const timedIds = new Set(captionIds);
  Object.assign(wordHighlightEngine, createWordHighlightEngine({
    getProject: (id) => store.get(id),
    clock: () => performance.now(),
    ensureNormalizedAudio: async (project) => ({
      dir: '', outputPath: 'fixture-normalized.wav', durationMs,
      fingerprint: mediaFingerprint(project), cacheHit: false, cachedAt: '2026-01-01T00:00:00.000Z',
    }),
    prepareFullEmission: async () => ({ prepared: true as const }),
    alignWindowsLocally: async (_wavPath, projectId, { targets }) => {
      const project = await store.get(projectId);
      const captions = new Map(project?.captions.map((cue) => [cue.id, cue]));
      return { clock, targets: targets.flatMap(({ id, variants }) => {
        if (!timedIds.has(id)) return [];
        const cue = captions.get(id);
        // The synthetic speech is measured on the target-only window. A
        // neighbour's wording can trigger follow but cannot change these anchors.
        const variant = variants.find(({ name }) => name === 'target');
        const line = variant?.lines.findIndex((entry) => entry.target) ?? -1;
        if (!cue || !variant || line < 0) throw new Error('Missing fixture timing target.');
        const units = highlightDisplayUnits(variant.lines[line].text);
        const step = Math.floor((cue.endMs - cue.startMs) / (units.length + 1));
        if (step <= 10) throw new Error('Fixture timing target is too short.');
        return [{
          id,
          attempts: [{ variant: variant.name, result: 'ok' as const }],
          words: units.map(({ startOffset, endOffset }, index) => ({
            line, text: variant.lines[line].text.slice(startOffset, endOffset),
            startFrame: cue.startMs + index * step + 10,
            endFrame: cue.startMs + (index + 1) * step,
            score: .99, peak: .01,
          })),
        }];
      }) };
    },
  }));
}
