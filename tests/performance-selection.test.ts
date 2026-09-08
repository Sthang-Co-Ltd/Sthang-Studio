import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionSegment, CaptionProject } from '@kcs/shared';
import { summarizeProject } from '../packages/shared/src/project-summary.js';
import { captionIndices, playbackSelectionIndex, selectedCaptionRange } from '../apps/web/src/caption-selection.js';

const cue = (id: string, startMs: number, endMs: number): CaptionSegment => ({ id, startMs, endMs, text: `ខ្មែរ ${id}` });
function reference(captions: CaptionSegment[], anchor: string | null, end: string | null, time: number) {
  if (!captions.length) return { ids: [], captions: [], startMs: 0, endMs: 0 };
  const nearestRaw = captions.findIndex((item) => time < item.endMs);
  const nearest = nearestRaw < 0 ? captions.length - 1 : nearestRaw;
  const a = captions.findIndex((item) => item.id === anchor);
  const b = captions.findIndex((item) => item.id === end);
  const first = a < 0 ? nearest : a, last = b < 0 ? first : b;
  const selected = captions.slice(Math.min(first, last), Math.max(first, last) + 1);
  return { ids: selected.map((item) => item.id), captions: selected, startMs: selected[0]?.startMs || 0, endMs: selected.at(-1)?.endMs || 0 };
}

test('selection resolution matches first-in-array semantics across gaps, overlaps, duplicates and invalid IDs', () => {
  const fixtures = [[], [cue('a', 0, 10000), cue('b', 1000, 2000), cue('c', 3000, 4000)],
    [cue('a', 4000, 5000), cue('a', 0, 2000), cue('b', 1000, 3000)]];
  for (const captions of fixtures) {
    const indices = captionIndices(captions);
    for (const anchor of [null, 'a', 'b', 'c', 'missing']) for (const end of [null, 'a', 'b', 'missing']) {
      for (const time of [-100, 0, 1000, 1999, 2000, 2500, 3000, 4999, 5000, 10000, 11000, NaN]) {
        const first = (anchor === null ? undefined : indices.get(anchor)) ?? playbackSelectionIndex(captions, time);
        const last = (end === null ? undefined : indices.get(end)) ?? first;
        assert.deepEqual(selectedCaptionRange(captions, first, last), reference(captions, anchor, end, time));
      }
    }
  }
});

test('summary includes only the home contract and does not read or expose transcript/media payloads', () => {
  const project = {
    id: 'p', title: 'ខ្មែរ', createdAt: '2026-01-01', updatedAt: '2026-01-02', captions: [cue('a', 0, 1000)],
    get transcript() { throw new Error('Summary must not read transcript'); },
    get media() { throw new Error('Summary must not read source media'); },
  } as unknown as CaptionProject;
  const result = summarizeProject(project);
  assert.deepEqual(result, { id: 'p', title: 'ខ្មែរ', createdAt: '2026-01-01', updatedAt: '2026-01-02', captionCount: 1 });
  result.title = 'changed';
  assert.equal(project.title, 'ខ្មែរ');
});
