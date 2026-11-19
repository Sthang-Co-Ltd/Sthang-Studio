import { createHash, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { CaptionProject, CaptionSegment, CaptionWord } from '../../packages/shared/src/index.js';

export function deferredHighlight() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export function markFixtureCaption(caption: CaptionSegment): CaptionSegment {
  const units = [...caption.text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  const step = Math.floor((caption.endMs - caption.startMs) / (units.length + 1));
  const words: CaptionWord[] = units.map((unit, index) => ({
    id: caption.id + '-' + index,
    startOffset: unit.index!, endOffset: unit.index! + unit[0].length,
    startMs: caption.startMs + index * step + 10,
    endMs: caption.startMs + (index + 1) * step,
    method: 'kfa', source: 'aligned',
  }));
  return { ...caption, wordTiming: { version: 1, evidence: 2, text: caption.text, words, basis: 'fixture:' + caption.text } };
}

export async function stubHighlightRoutes(page: Page, project: CaptionProject) {
  const mediaFingerprint = createHash('sha256').update(`${project.media.filename}:${project.media.size}:${project.media.originalName}`).digest('hex').slice(0, 24);
  const keys = new Map<string, CaptionSegment>();
  const receipts = new Map<string, unknown>();
  type Applied = { id: string; before: CaptionSegment; after: CaptionSegment };
  type Publication = { action?: 'undo'; mode?: 'prepared'; intent: 'apply' | 'follow'; epoch: string; requestId: string; preparedKeys?: string[]; changes?: Applied[] };
  let revision = Date.parse('2026-01-01');
  const bump = () => { project.updatedAt = new Date(++revision).toISOString(); };
  const state = {
    arms: 0, revokes: 0, prepares: 0, chunks: [] as string[][], writes: [] as Publication[],
    committed: [] as Applied[][], armInitial: () => {
      project.wordHighlightFollow = { version: 1, enabled: true, epoch: randomUUID(), mediaFingerprint };
    },
    holdCandidates: undefined as ReturnType<typeof deferredHighlight> | undefined,
    holdPublish: undefined as ReturnType<typeof deferredHighlight> | undefined,
    holdUndo: undefined as ReturnType<typeof deferredHighlight> | undefined,
    dropAcknowledgement: false,
    rejectNext: [] as string[],
    terminal: new Set<string>(),
    build: markFixtureCaption,
  };
  await page.route('**/api/projects/landscape/word-highlight-follow', async (route) => {
    const { action } = route.request().postDataJSON();
    if (action === 'arm') { state.arms++; state.armInitial(); }
    else {
      state.revokes++;
      if (project.wordHighlightFollow) project.wordHighlightFollow.enabled = false;
    }
    bump();
    await route.fulfill({ json: { wordHighlightFollow: project.wordHighlightFollow ?? null, updatedAt: project.updatedAt } });
  });
  await page.route('**/api/projects/landscape/caption-word-timing/prepare', async (route) => {
    state.prepares++;
    await route.fulfill({ json: { ready: true, durationMs: 4000, mediaFingerprint } });
  });
  await page.route('**/api/projects/landscape/caption-word-timing/candidates', async (route) => {
    const { ids } = route.request().postDataJSON() as { ids: string[] };
    expect(ids.length).toBeLessThanOrEqual(32);
    state.chunks.push(ids);
    await state.holdCandidates?.promise;
    const results = ids.map((id) => {
      const current = project.captions.find((caption) => caption.id === id);
      if (!current) return { id, status: 'stale' };
      if (current.timingLocked) return { id, status: 'locked' };
      if (state.terminal.has(id)) return { id, status: 'error' };
      const key = randomUUID();
      keys.set(key, state.build(current));
      return { id, status: 'candidate', preparedKey: key };
    });
    await route.fulfill({ json: { engine: 'word-highlight-v1', results } }).catch(() => {});
  });
  await page.route('**/api/projects/landscape/caption-word-timing/batch-apply', async (route) => {
    const body = route.request().postDataJSON() as Publication;
    state.writes.push(body);
    if (body.action === 'undo') {
      await state.holdUndo?.promise;
      const inverse = body.changes!;
      const matches = inverse.every(({ before }) => {
        const now = project.captions.find(({ id }) => id === before.id);
        return now?.text === before.text && JSON.stringify(now.wordTiming) === JSON.stringify(before.wordTiming);
      });
      if (!matches) { await route.fulfill({ status: 409, json: { error: 'The captions changed.' } }); return; }
      const restore = new Map(inverse.map(({ after }) => [after.id, after]));
      project.captions = project.captions.map((caption) => restore.get(caption.id) ?? caption);
      if (project.wordHighlightFollow) project.wordHighlightFollow.enabled = false;
      bump();
      await route.fulfill({ json: { project, appliedCount: inverse.length } });
      return;
    }
    expect(body.mode).toBe('prepared');
    expect(body.requestId).toMatch(/^[\da-f-]{36}$/i);
    expect(body.changes).toBeUndefined();
    if (state.rejectNext.length) {
      const changedIds = state.rejectNext.splice(0);
      await route.fulfill({ status: 409, json: { code: 'WORD_HIGHLIGHT_CONTEXT_CHANGED', error: 'Inputs changed.', changedIds } });
      return;
    }
    if (!project.wordHighlightFollow?.enabled || body.epoch !== project.wordHighlightFollow.epoch) {
      await route.fulfill({ status: 409, json: { code: 'WORD_HIGHLIGHT_INTENT_CHANGED', error: 'Intent changed.' } });
      return;
    }
    const applied = body.preparedKeys!.flatMap((key) => {
      const after = keys.get(key)!;
      const before = project.captions.find(({ id }) => id === after.id)!;
      return JSON.stringify(before.wordTiming) === JSON.stringify(after.wordTiming) ? [] : [{ id: before.id, before, after }];
    });
    if (applied.length) {
      const replacements = new Map(applied.map(({ id, after }) => [id, after]));
      project.captions = project.captions.map((caption) => replacements.get(caption.id) ?? caption);
      state.committed.push(applied);
      receipts.set(body.requestId, { committed: true, intent: body.intent, applied });
      bump();
    }
    const response = structuredClone({ project, applied, appliedCount: applied.length, kept: [], unchanged: [] });
    await state.holdPublish?.promise;
    if (state.dropAcknowledgement) { state.dropAcknowledgement = false; await route.abort('failed'); return; }
    await route.fulfill({ json: response });
  });
  await page.route('**/api/projects/landscape/caption-word-timing/publication/**', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    await route.fulfill({ json: receipts.get(id) ?? { committed: false } });
  });
  return state;
}
