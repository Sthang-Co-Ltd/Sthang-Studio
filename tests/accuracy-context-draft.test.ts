import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CaptionProject, TranscriptionContext } from '@kcs/shared';
import { accuracyPayload, createAccuracyContextDraft, sameAccuracyContext } from '../apps/web/src/accuracy-context-draft.js';
import { createProjectScope, projectMediaKey } from '../apps/web/src/project-scope.js';

const context = (description = 'Saved description', vocabulary = ['SavedBrand | old alias']): TranscriptionContext => ({ description, vocabulary });
const project = (id = 'A', source = `${id}.mp4`, transcriptionContext = context()): CaptionProject => ({
  id, title: id, createdAt: '2026-01-01', updatedAt: '2026-01-01', mode: 'dynamic',
  media: { filename: source, originalName: source, url: `/media/${source}`, size: 100, mimeType: 'video/mp4' },
  captions: [{ id: 'cue', text: 'Caption', startMs: 0, endMs: 1000 }], transcript: null, transcriptionContext,
});
function setup() {
  const source = project();
  const scope = createProjectScope();
  scope.select(source);
  const draft = createAccuracyContextDraft();
  draft.reset(projectMediaKey(source), source.transcriptionContext);
  return { source, scope, draft };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const dirty = { description: '  Dirty Accuracy description  ', vocabulary: 'ExactBrand | exact alias\nAnotherBrand\n' };

test('delayed caption-only acknowledgement retains exact newer Accuracy fields for replacement backup', async () => {
  const { source, draft } = setup();
  const reply = deferred<CaptionProject>();
  const save = reply.promise.then((saved) => draft.retainProject(saved));
  draft.edit(dirty);
  reply.resolve({ ...source, captions: [{ ...source.captions[0], text: 'Saved caption edit' }] });
  const published = await save;
  assert.equal(published.captions[0].text, 'Saved caption edit');
  assert.deepEqual(draft.fields, dirty);
  assert.deepEqual(draft.saved, context());
  const replacementBackupContext = accuracyPayload(draft.fields);
  assert.deepEqual(replacementBackupContext, context('Dirty Accuracy description', ['ExactBrand | exact alias', 'AnotherBrand']));
});

test('a caption reply cannot regress a newer acknowledged context baseline', async () => {
  const { source, scope, draft } = setup();
  const reply = deferred<CaptionProject>();
  const save = reply.promise.then((saved) => draft.retainProject(saved));
  draft.edit(dirty);
  const payload = accuracyPayload(draft.fields);
  assert.equal(draft.publish(payload, draft.capture(scope.capture()), scope.capture(), undefined, true), true);
  reply.resolve(source);
  assert.deepEqual((await save).transcriptionContext, payload);
  assert.deepEqual(draft.saved, payload);
  assert.deepEqual(draft.fields, dirty);
});

test('context save acknowledges its payload while retaining typing that arrived during the request', async () => {
  const { scope, draft } = setup();
  draft.edit({ description: 'Submitted description', vocabulary: 'SubmittedBrand' });
  const payload = accuracyPayload(draft.fields);
  const observation = draft.capture(scope.capture());
  const reply = deferred<TranscriptionContext>();
  const save = reply.promise.then((saved) => draft.publish(saved, observation, scope.capture(), undefined, true));
  draft.edit(dirty);
  reply.resolve(payload);
  assert.equal(await save, true);
  assert.deepEqual(draft.saved, payload);
  assert.deepEqual(draft.fields, dirty);
  assert.equal(sameAccuracyContext(accuracyPayload(draft.fields), draft.saved), false);
});

test('an older full-project read cannot undo a context save even if the draft is now clean', async () => {
  const { source, scope, draft } = setup();
  const oldRead = draft.capture(scope.capture());
  draft.edit({ description: 'New saved description', vocabulary: 'NewBrand' });
  const saved = accuracyPayload(draft.fields);
  assert.equal(draft.publish(saved, draft.capture(scope.capture()), scope.capture(), undefined, true), true);
  assert.equal(draft.publish(source.transcriptionContext, oldRead, scope.capture()), false);
  assert.deepEqual(draft.saved, saved);
  assert.equal(draft.fields.description, 'New saved description');
});

test('same-media refresh and History adopt clean context but retain dirty raw fields', () => {
  for (const edited of [false, true]) {
    const { scope, draft } = setup();
    if (edited) draft.edit(dirty);
    const restored = context('History description', ['HistoryBrand']);
    assert.equal(draft.publish(restored, draft.capture(scope.capture()), scope.capture()), true);
    assert.deepEqual(draft.saved, restored);
    assert.deepEqual(draft.fields, edited ? dirty : { description: 'History description', vocabulary: 'HistoryBrand' });
  }
});

test('raw whitespace is still a draft and survives a same-source refresh', () => {
  const { scope, draft } = setup();
  const raw = { description: ' Saved description ', vocabulary: 'SavedBrand | old alias\n' };
  draft.edit(raw);
  assert.equal(draft.publish(context('Fresh remote context'), draft.capture(scope.capture()), scope.capture()), true);
  assert.deepEqual(draft.fields, raw);
});

test('new context typing during a read is retained even if it returns to the original value', () => {
  const { scope, draft } = setup();
  const observation = draft.capture(scope.capture());
  const original = { ...draft.fields };
  draft.edit(dirty);
  draft.edit(original);
  draft.publish(context('Server update'), observation, scope.capture());
  assert.deepEqual(draft.fields, original);
});

test('a no-op background read does not invalidate an in-flight context acknowledgement', () => {
  const { scope, draft } = setup();
  draft.edit(dirty);
  const save = draft.capture(scope.capture());
  assert.equal(draft.publish(context(), draft.capture(scope.capture()), scope.capture()), true);
  const payload = accuracyPayload(draft.fields);
  assert.equal(draft.publish(payload, save, scope.capture(), undefined, true), true);
  assert.deepEqual(draft.saved, payload);
});

test('an authoritative context write supersedes an intervening different read without losing newer typing', () => {
  const { scope, draft } = setup();
  const olderRead = draft.capture(scope.capture());
  draft.edit({ description: 'Submitted context', vocabulary: 'SubmittedBrand' });
  const payload = accuracyPayload(draft.fields);
  const write = draft.capture(scope.capture());
  // A background read can discover another operation's context while this PUT
  // is waiting for its response. The successful later serial write still owns
  // the persisted baseline; publication order alone must not reject it.
  assert.equal(draft.publish(context('Background context'), olderRead, scope.capture()), true);
  draft.edit(dirty);
  assert.equal(draft.publish(payload, write, scope.capture(), undefined, true), true);
  assert.deepEqual(draft.saved, payload);
  assert.deepEqual(draft.fields, dirty);
});

test('an obsolete write observation cannot undo a newer acknowledged write', () => {
  const { scope, draft } = setup();
  const obsolete = draft.capture(scope.capture());
  const current = draft.capture(scope.capture());
  const latest = context('Latest acknowledged context');
  assert.equal(draft.publish(latest, current, scope.capture(), undefined, true), true);
  assert.equal(draft.publish(context('Older context'), obsolete, scope.capture(), undefined, true), false);
  assert.deepEqual(draft.saved, latest);
});

test('context-changing History mutation can adopt clean fields and supersede an intervening read', () => {
  const { scope, draft } = setup();
  const read = draft.capture(scope.capture());
  const restore = draft.capture(scope.capture());
  assert.equal(draft.publish(context('Background value'), read, scope.capture()), true);
  assert.equal(draft.publish(context('Restored value'), restore, scope.capture(), undefined, false, true), true);
  assert.equal(draft.fields.description, 'Restored value');
});

test('navigation cancellation invalidates old replies without resetting the still-visible draft', () => {
  const { scope, draft } = setup();
  draft.edit(dirty);
  const observation = draft.capture(scope.capture());
  scope.invalidate();
  assert.equal(draft.publish(context('Old request'), observation, scope.capture()), false);
  assert.deepEqual(draft.fields, dirty);
  assert.equal(draft.publish(context('Current save'), draft.capture(scope.capture()), scope.capture(), undefined, true), true);
  assert.deepEqual(draft.fields, dirty);
});

for (const destination of ['another-project', 'another-source', 'same-source-reopened'] as const) {
  test(`late acknowledgement cannot leak across ${destination}`, () => {
    const { source, scope, draft } = setup();
    draft.edit(dirty);
    const observation = draft.capture(scope.capture());
    scope.invalidate();
    scope.select(null);
    draft.reset('');
    const next = destination === 'another-project' ? project('B')
      : destination === 'another-source' ? project('A', 'replacement.mp4') : source;
    scope.select(next);
    draft.reset(projectMediaKey(next), context('Destination context', ['DestinationBrand']));
    assert.equal(draft.publish(context('Late old save'), observation, scope.capture(), undefined, true), false);
    assert.deepEqual(draft.fields, { description: 'Destination context', vocabulary: 'DestinationBrand' });
  });
}

test('source replacement retains raw fields only through an explicit preserve view', () => {
  for (const preserve of [false, true]) {
    const { draft } = setup();
    draft.edit(dirty);
    const next = project('A', 'replacement.mp4', context('Replacement context', ['ReplacementBrand']));
    assert.equal(draft.retainProject(next), next);
    draft.reset(projectMediaKey(next), next.transcriptionContext, undefined, preserve ? draft.fields : undefined);
    assert.deepEqual(draft.saved, next.transcriptionContext);
    assert.deepEqual(draft.fields, preserve ? dirty : { description: 'Replacement context', vocabulary: 'ReplacementBrand' });
  }
});

test('late Accuracy input is copied as old-source recovery before reset or preserve hydration', () => {
  for (const preserve of [false, true]) {
    const { source, draft } = setup();
    const submittedRevision = draft.editRevision;
    const submittedFields = { ...draft.fields };
    assert.equal(draft.recoverySince(submittedRevision), undefined);
    draft.edit(dirty);
    const recovery = draft.recoverySince(submittedRevision);
    assert.deepEqual(recovery, dirty);
    const replacement = project('A', 'replacement.mp4');
    draft.reset(projectMediaKey(replacement), source.transcriptionContext, undefined, preserve ? submittedFields : undefined);
    assert.deepEqual(recovery, dirty);
    assert.deepEqual(draft.fields, submittedFields);
    assert.notDeepEqual(draft.fields, recovery);
  }
});

test('glossary payload preserves description, aliases and distinct current terms while deduplicating defaults', () => {
  assert.deepEqual(accuracyPayload({ description: '  Topic  ', vocabulary: 'ExactBrand | spoken alias\nGLOBAL\nNewBrand\n' }, ['Global']),
    context('Topic', ['Global', 'ExactBrand | spoken alias', 'NewBrand']));
});

test('failed context save leaves both the draft and acknowledged baseline untouched', async () => {
  const { draft } = setup();
  draft.edit(dirty);
  const reply = deferred<TranscriptionContext>();
  const save = reply.promise.then(() => { throw new Error('Synthetic context failure'); });
  reply.resolve(context());
  await assert.rejects(save, /Synthetic context failure/);
  assert.deepEqual(draft.saved, context());
  assert.deepEqual(draft.fields, dirty);
});

test('App routes both caption-save branches and same-media publications through independent Accuracy ownership', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const retainAccuracyContext = .*accuracyDraft\.current\.retainProject\(next\)/);
  assert.match(app, /const applyProject[\s\S]*?next = retainAccuracyContext\(next\)/);
  assert.match(app, /const publishSameMediaMutation[\s\S]*?next = retainAccuracyContext\(next\)/);
  assert.match(app, /if \(unchanged\) applyProject\(result\.project, true, \{ preserveSelection: true \}\);[\s\S]*?const acknowledged = retainAccuracyContext\(result\.project\)/);
  assert.match(app, /const saveContext = async[\s\S]*?await queueSameMediaMutation\(ticket/);
  const basis = app.slice(app.indexOf('const mediaMutationBasis'), app.indexOf('const captureReplacementEdits'));
  assert.ok(basis.indexOf('await saveQueue.current') < basis.indexOf('const acknowledgedContext = accuracyDraft.current.saved'));
  assert.doesNotMatch(basis, /target\.transcriptionContext/);
  assert.match(basis, /JSON\.stringify\(accuracyDraft\.current\.fields\) !== contextSnapshot/);
  assert.ok(basis.indexOf('const contextPublished = publishContextProject') < basis.indexOf("throw new Error('The project changed while saving Accuracy context"));
});
