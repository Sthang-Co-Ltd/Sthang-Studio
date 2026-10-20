import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CaptionSegment } from '@kcs/shared';
import { reconcileCaptionSelection, type CaptionSelectionEndpoints } from '../apps/web/src/caption-selection-validity.js';

const captions: CaptionSegment[] = [
  { id: 'c1', text: 'First', startMs: 0, endMs: 1000 },
  { id: 'c2', text: 'Second', startMs: 2000, endMs: 3000 },
  { id: 'c3', text: 'Third', startMs: 4000, endMs: 5000 },
];

for (const [name, selection] of [
  ['single caption', { anchor: 'c2', end: 'c2' }],
  ['forward range', { anchor: 'c1', end: 'c3' }],
  ['reversed range', { anchor: 'c3', end: 'c1' }],
] as const) {
  test(`validity reconciliation after a delayed save retains the newer ${name}`, async () => {
    let current: CaptionSelectionEndpoints = { anchor: 'c1', end: 'c1' };
    let acknowledge!: (value: CaptionSegment[]) => void;
    const reply = new Promise<CaptionSegment[]>((resolve) => { acknowledge = resolve; });
    const settled = reply.then((saved) => reconcileCaptionSelection(saved, current, 4500));
    // Selection is independent of draft version and may change while saving.
    current = { ...selection };
    acknowledge(captions.map((caption) => ({ ...caption })));
    assert.equal(await settled, current);
    assert.deepEqual(current, selection);
  });
}

test('caption reorder does not reverse or collapse valid endpoints', () => {
  const current = { anchor: 'c3', end: 'c1' };
  assert.equal(reconcileCaptionSelection([...captions].reverse(), current, 0), current);
});

for (const [name, current] of [
  ['removed anchor', { anchor: 'removed', end: 'c3' }],
  ['removed end', { anchor: 'c1', end: 'removed' }],
  ['both removed', { anchor: 'removed', end: 'also-removed' }],
  ['missing endpoints', { anchor: null, end: null }],
] as const) {
  test(`${name} keeps the existing active-caption fallback`, () => {
    assert.deepEqual(reconcileCaptionSelection(captions, current, 2500), { anchor: 'c2', end: 'c2' });
  });
}

test('invalid selection before, between and after captions follows the existing next-or-last fallback', () => {
  const current = { anchor: 'removed', end: 'removed' };
  for (const [timeMs, expected] of [[-100, 'c1'], [1000, 'c2'], [1500, 'c2'], [3000, 'c3'], [5000, 'c3']] as const) {
    assert.deepEqual(reconcileCaptionSelection(captions, current, timeMs), { anchor: expected, end: expected });
  }
});

test('active caption takes priority over an earlier overlapping future caption', () => {
  const overlapping = [{ ...captions[0], startMs: 2600, endMs: 3500 }, captions[1], captions[2]];
  assert.deepEqual(reconcileCaptionSelection(overlapping, { anchor: null, end: null }, 2500), { anchor: 'c2', end: 'c2' });
});

test('an empty acknowledged draft clears both endpoints', () => {
  for (const current of [{ anchor: 'c1', end: 'c3' }, { anchor: null, end: null }]) {
    assert.deepEqual(reconcileCaptionSelection([], current, 2500), { anchor: null, end: null });
  }
});

test('App limits selection preservation to guarded caption saves and unfinished-draft recovery', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const apply = app.slice(app.indexOf('const applyProject ='), app.indexOf('const publishSameMediaMutation ='));
  assert.match(apply, /options: \{ preserveSelection\?: boolean \} = \{\}/);
  assert.match(apply, /if \(!options\.preserveSelection \|\| changedMedia\) \{[\s\S]*?setSelectionAnchor\(validSelection\.id\); setSelectionEnd\(validSelection\.id\)/);

  const save = app.slice(app.indexOf('const saveDraft ='), app.indexOf('const syncCaptionWords ='));
  const guard = save.indexOf('if (!projectScope.current.isCurrent(ticket) || projectMediaKey(result.project) !== ticket.key) return result.project;');
  const acknowledgement = save.indexOf('if (unchanged) applyProject(result.project, true, { preserveSelection: true });');
  assert.ok(guard >= 0 && acknowledgement > guard, 'session and source guards precede selection-preserving publication');
  const preservationCount = (source: string) => source.match(/\{ preserveSelection: true \}/g)?.length ?? 0;
  assert.equal(preservationCount(save), 1, 'only the guarded caption-save acknowledgement preserves selection in saveDraft');
  const recovery = app.slice(app.indexOf('const restoreUnfinishedDraft ='), app.indexOf('const downloadDraftText ='));
  const recoveryRead = recovery.indexOf('const latest = withCaptionWordTimings(await api.get(project.id));');
  const recoverySessionGuard = recovery.indexOf('if (!projectScope.current.isCurrent(ticket)) return;');
  const recoveryEditGuard = recovery.indexOf('if (captionRevision !== draftEditRevision.current || contextRevision !== accuracyDraft.current.editRevision');
  const recoveryBasisGuard = recovery.indexOf("if (compatibility !== 'matching') {");
  const recoveryPublication = recovery.indexOf('applyProject(latest, true, { preserveSelection: true });');
  assert.ok(recoveryRead >= 0 && recoverySessionGuard > recoveryRead && recoveryEditGuard > recoverySessionGuard
    && recoveryBasisGuard > recoveryEditGuard && recoveryPublication > recoveryBasisGuard,
  'fresh canonical read, session, edit and compatibility guards precede recovery publication');
  assert.match(recovery.slice(recoveryEditGuard, recoveryBasisGuard), /return;/);
  assert.match(recovery.slice(recoveryBasisGuard, recoveryPublication), /return;/);
  assert.equal(preservationCount(recovery), 1, 'only the guarded unfinished-draft publication preserves recovery selection');
  assert.equal(preservationCount(app), 2, 'navigation, History and other project actions keep their default selection behavior');
  assert.match(app, /const current = \{ anchor: selectionAnchor, end: selectionEnd \};\s*const valid = reconcileCaptionSelection\(draft, current, time \* 1000\)/);
  assert.match(app, /const publishSameMediaMutation[\s\S]*?applyProject\(next\);/);
});
