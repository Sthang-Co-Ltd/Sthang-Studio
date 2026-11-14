import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPTION_APPEARANCE, normalizeCaptionAppearance, resolveCaptionWordTiming, type CaptionAppearance, type CaptionProject, type CaptionSegment } from '@kcs/shared';
import {
  assessRecovery, createUnfinishedEditRecoveryStore, restoredAppearance, restoredCaptions,
  UNFINISHED_EDIT_RECOVERY_LIMITS as limits,
  type RecoveryEntry,
} from '../apps/web/src/unfinished-edit-recovery.js';
import { projectMediaKey } from '../apps/web/src/project-scope.js';

class MemoryStorage {
  readonly items = new Map<string, string>();
  fail: 'get' | 'set' | 'remove' | 'length' | 'key' | undefined;
  beforeRemove?: () => void;
  get length() { if (this.fail === 'length') throw new Error('Unavailable'); return this.items.size; }
  key(index: number) { if (this.fail === 'key') throw new Error('Unavailable'); return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { if (this.fail === 'get') throw new Error('Unavailable'); return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.fail === 'set') throw new Error('Quota exceeded'); this.items.set(key, value); }
  removeItem(key: string) {
    if (this.fail === 'remove') throw new Error('Unavailable');
    this.beforeRemove?.();
    this.items.delete(key);
  }
}

function project(id = 'project-A'): CaptionProject {
  return {
    id, title: 'Synthetic recovery fixture', createdAt: '2026-01-01', updatedAt: '2026-01-01', mode: 'dynamic',
    media: { filename: `${id}.mp4`, originalName: 'Source.mp4', url: `/media/${id}.mp4`, mimeType: 'video/mp4', size: 200 },
    transcriptionContext: { description: 'Saved topic', vocabulary: ['SavedBrand'] }, transcript: null,
    captions: [{ id: 'cue-A', text: 'Hello world', startMs: 0, endMs: 1000, approved: true, wordTiming: {
      version: 1, text: 'Hello world', words: [
        { id: 'hello', startOffset: 0, endOffset: 5, startMs: 0, endMs: 400, source: 'manual' },
        { id: 'world', startOffset: 6, endOffset: 11, startMs: 500, endMs: 1000, source: 'manual' },
      ],
    } }],
  };
}

const edited = (source: CaptionProject, text = 'Hello moon'): CaptionSegment[] => source.captions.map((caption) => ({ ...caption, text }));
const accuracy = { description: '  Unfinished topic\n', vocabulary: 'ExactBrand | ខ្មែរ\nAnotherBrand\n' };
function setup(owner = 'tab-A') {
  const storage = new MemoryStorage();
  const store = createUnfinishedEditRecoveryStore(() => storage, owner);
  const source = project();
  return { storage, store, source };
}
function saved(result: ReturnType<ReturnType<typeof createUnfinishedEditRecoveryStore>['write']>): RecoveryEntry {
  assert.equal(result.status, 'saved');
  assert.ok(result.entry);
  return result.entry;
}

test('unfinished focused text and raw Accuracy fields survive a new page owner without applying themselves', () => {
  const { source, storage, store } = setup();
  const before = JSON.stringify(source);
  const entry = saved(store.write({ project: source, captions: edited(source), accuracy }));
  const reopened = createUnfinishedEditRecoveryStore(() => storage, 'new-page').list(source.id);
  assert.deepEqual(reopened, [entry]);
  assert.equal(assessRecovery(reopened[0], source), 'matching');
  assert.deepEqual(reopened[0].draft.accuracy, accuracy, 'raw Khmer, whitespace and line endings are retained');
  assert.equal(reopened[0].draft.captions?.[0].text, 'Hello moon');
  assert.equal(JSON.stringify(source), before, 'capture and discovery do not mutate saved project data');
});

test('matching basis ignores appearance, title and unrelated updatedAt changes', () => {
  const { source, store } = setup();
  const entry = saved(store.write({ project: source, captions: edited(source) }));
  const unrelated: CaptionProject = { ...source, title: 'Renamed', updatedAt: '2026-10-20',
    captionAppearance: { fontSize: 96 } as unknown as CaptionProject['captionAppearance'] };
  assert.equal(assessRecovery(entry, unrelated), 'matching');
});

test('new saved wording, timing, approval, locks, word evidence or Accuracy context refuses restoration', () => {
  const { source, store } = setup();
  const entry = saved(store.write({ project: source, captions: edited(source), accuracy }));
  const patches: Array<Partial<CaptionSegment>> = [
    { text: 'New server text' }, { startMs: 10 }, { approved: false }, { textLocked: true }, { timingLocked: true },
    { wordTiming: { ...source.captions[0].wordTiming!, words: [{ ...source.captions[0].wordTiming!.words[0], needsReview: true }, source.captions[0].wordTiming!.words[1]] } },
  ];
  for (const patch of patches) {
    const changed = { ...source, captions: [{ ...source.captions[0], ...patch }] };
    assert.equal(assessRecovery(entry, changed), 'changed');
    assert.equal(restoredCaptions(entry, changed), undefined);
  }
  assert.equal(assessRecovery(entry, { ...source, transcriptionContext: { description: 'Server topic', vocabulary: [] } }), 'changed');
  assert.equal(assessRecovery(entry, { ...source, transcriptNeedsSync: true }), 'changed');
});

test('project and exact media identity changes cannot reuse a recovery draft', () => {
  const { source, store } = setup();
  const entry = saved(store.write({ project: source, captions: edited(source) }));
  for (const media of [
    { ...source.media, filename: 'replacement.mp4' }, { ...source.media, size: source.media.size + 1 },
    { ...source.media, url: '/media/replacement.mp4' }, { ...source.media, mimeType: 'audio/wav' },
  ]) {
    assert.equal(assessRecovery(entry, { ...source, media }), 'media-changed');
    assert.equal(restoredCaptions(entry, { ...source, media }), undefined);
  }
  assert.equal(assessRecovery(entry, { ...source, id: 'other-project' }), 'media-changed');
});

test('changed captions become unapproved and only fresh canonical timing participates in reconciliation', () => {
  const { source, store } = setup();
  source.captions.push({ ...source.captions[0], id: 'unchanged', startMs: 2000, endMs: 3000, wordTiming: undefined });
  const forgedTrack = { version: 1 as const, text: 'Hello moon', words: [
    { id: 'fake', startOffset: 0, endOffset: 10, startMs: 0, endMs: 1000, source: 'manual' as const },
  ] };
  const candidate = [{ ...source.captions[0], text: 'Hello moon', approved: true, wordTiming: forgedTrack }, source.captions[1]];
  const entry = saved(store.write({ project: source, captions: candidate }));
  assert.equal('wordTiming' in entry.draft.captions![0], false);
  assert.equal('approved' in entry.draft.captions![0], false);
  const restored = restoredCaptions(entry, source)!;
  assert.equal(restored[0].approved, false);
  assert.equal(restored[0].text, 'Hello moon');
  assert.equal(resolveCaptionWordTiming(restored[0]).state, 'partial');
  assert.ok(restored[0].wordTiming?.words.some((word) => word.needsReview));
  assert.ok(restored[0].wordTiming?.words.every((word) => word.id !== 'fake'));
  assert.deepEqual(restored[1], source.captions[1], 'unchanged current saved caption keeps its own approval and evidence');
  assert.equal(source.captions[0].approved, true);
  assert.equal(resolveCaptionWordTiming(source.captions[0]).state, 'ready');
});

test('new and deleted captions are recoverable without importing approval or word evidence', () => {
  const { source, store } = setup();
  const added = { id: 'new', text: 'Added caption', startMs: 2000, endMs: 3000, approved: true };
  const entry = saved(store.write({ project: source, captions: [added] }));
  assert.deepEqual(restoredCaptions(entry, source), [{ ...added, approved: false, textLocked: false, timingLocked: false }]);
  const deleted = saved(store.write({ project: source, captions: [] }));
  assert.deepEqual(restoredCaptions(deleted, source), []);
});

test('approval-only changes are not represented as recovered editable caption content', () => {
  const { source, store } = setup();
  assert.equal(store.write({ project: source, captions: [{ ...source.captions[0], approved: false }] }).status, 'cleared');
  assert.deepEqual(store.list(source.id), []);
});

test('a conflicted comparison copy survives returning to its old baseline without importing approval or timing', () => {
  const { source, store } = setup();
  const before = saved(store.write({ project: source, captions: edited(source) }));
  const comparison = saved(store.write({ project: source, captions: source.captions, keepUnchangedCaptions: true }));
  assert.notEqual(comparison.key, before.key);
  assert.deepEqual(comparison.draft.basis, before.draft.basis);
  assert.deepEqual(comparison.draft.captions, [{ id: 'cue-A', text: 'Hello world', startMs: 0, endMs: 1000,
    textLocked: false, timingLocked: false }]);
  assert.deepEqual(store.list(source.id), [comparison]);
  const changedSaved = { ...source, captions: edited(source, 'Saved elsewhere') };
  assert.equal(assessRecovery(comparison, changedSaved), 'changed');
  assert.equal(restoredCaptions(comparison, changedSaved), undefined);
  assert.equal(store.write({ project: source, captions: source.captions }).status, 'cleared',
    'normal non-conflicting clean drafts still clear their own copy');
  assert.deepEqual(store.list(source.id), []);
});

test('tampered parsed entry objects do not replace the validated raw snapshot used for restoration', () => {
  const { source, store } = setup();
  const entry = saved(store.write({ project: source, captions: edited(source) }));
  entry.draft.captions![0].text = 'Mutated display object';
  assert.equal(restoredCaptions(entry, source)?.[0].text, 'Hello moon');
});

test('corrupt, unsupported or overprivileged persisted payloads are rejected without throwing', () => {
  const corruptions: Array<(draft: Record<string, any>) => void> = [
    (draft) => { draft.version = 2; }, (draft) => { draft.ownerId = 'different-owner'; },
    (draft) => { draft.unknown = true; }, (draft) => { draft.basis = { captions: [], context: '{}' }; },
    (draft) => { draft.captions[0].approved = true; }, (draft) => { draft.captions[0].wordTiming = {}; },
    (draft) => { draft.captions[0].startMs = -1; }, (draft) => { draft.captions[0].endMs = 0; },
    (draft) => { draft.captions[0].text = null; }, (draft) => { draft.captions[0].textLocked = 'yes'; },
    (draft) => { draft.captions.push({ ...draft.captions[0] }); },
    (draft) => { draft.accuracy = { description: '', vocabulary: [], unexpected: true }; },
    (draft) => { draft.savedAt = null; },
  ];
  for (const corrupt of corruptions) {
    const { source, storage, store } = setup();
    const entry = saved(store.write({ project: source, captions: edited(source) }));
    const draft = JSON.parse(entry.raw);
    corrupt(draft);
    const raw = JSON.stringify(draft);
    storage.setItem(entry.key, raw);
    assert.deepEqual(store.list(source.id), []);
    assert.equal(assessRecovery({ ...entry, raw }, source), 'changed');
    assert.equal(restoredCaptions({ ...entry, raw }, source), undefined);
  }
  for (const malformed of ['{', 'null', '[]', '"text"']) {
    const { source, storage, store } = setup();
    const entry = saved(store.write({ project: source, accuracy }));
    storage.setItem(entry.key, malformed);
    assert.deepEqual(store.list(source.id), []);
  }
});

test('storage privacy restrictions and quota failures never throw or replace the last protected snapshot', () => {
  const unavailable = createUnfinishedEditRecoveryStore(() => { throw new Error('SecurityError'); }, 'tab');
  assert.equal(unavailable.write({ project: project(), accuracy }).status, 'unavailable');
  assert.deepEqual(unavailable.list('project-A'), []);
  const { source, storage, store } = setup();
  const previous = saved(store.write({ project: source, accuracy }));
  storage.fail = 'set';
  assert.equal(store.write({ project: source, accuracy: { ...accuracy, description: 'Newer typing' } }).status, 'unavailable');
  storage.fail = undefined;
  assert.deepEqual(store.list(source.id), [previous]);
  for (const failure of ['get', 'length', 'key'] as const) {
    storage.fail = failure;
    assert.deepEqual(store.list(source.id), []);
    assert.equal(store.write({ project: source, accuracy }).status, 'unavailable');
  }
  storage.fail = 'remove';
  assert.equal(store.remove(previous), false);
  storage.fail = undefined;
  assert.equal(storage.getItem(previous.key), previous.raw);
});

test('newer immutable snapshots survive late acknowledgement or another tab discarding the old copy', () => {
  const { source, storage, store } = setup();
  const old = saved(store.write({ project: source, captions: edited(source, 'First draft') }));
  const current = saved(store.write({ project: source, captions: edited(source, 'Newer draft') }));
  assert.notEqual(current.key, old.key);
  assert.equal(store.remove(old), true);
  assert.deepEqual(store.list(source.id), [current]);
  const other = createUnfinishedEditRecoveryStore(() => storage, 'tab-B');
  let concurrent: RecoveryEntry | undefined;
  storage.beforeRemove = () => {
    storage.beforeRemove = undefined;
    concurrent = saved(other.write({ project: source, accuracy }));
  };
  assert.equal(store.remove(current), true);
  assert.deepEqual(store.list(source.id), [concurrent]);
});

test('exact deletion refuses a rewritten same-key snapshot and never removes unrelated browser storage', () => {
  const { source, storage, store } = setup();
  storage.setItem('unrelated-preference', 'keep');
  const entry = saved(store.write({ project: source, accuracy }));
  const rewritten = JSON.stringify({ ...JSON.parse(entry.raw), accuracy: { ...accuracy, description: 'Newer external copy' } });
  storage.setItem(entry.key, rewritten);
  assert.equal(store.remove(entry), false);
  assert.equal(store.clearOwn(source.id, projectMediaKey(source)), false);
  assert.equal(storage.getItem(entry.key), rewritten);
  assert.equal(storage.getItem('unrelated-preference'), 'keep');
});

test('one page can clear only its own exact current-media snapshot', () => {
  const { source, storage, store } = setup();
  const oldMedia = saved(store.write({ project: source, accuracy }));
  const other = createUnfinishedEditRecoveryStore(() => storage, 'tab-B');
  const otherTab = saved(other.write({ project: source, captions: edited(source) }));
  const replacement = { ...source, media: { ...source.media, filename: 'new.mp4', url: '/media/new.mp4' } };
  assert.equal(store.write({ project: replacement }).status, 'cleared');
  const newMedia = saved(store.write({ project: replacement, accuracy }));
  assert.equal(store.write({ project: replacement }).status, 'cleared');
  assert.equal(storage.getItem(newMedia.key), null);
  assert.equal(storage.getItem(oldMedia.key), oldMedia.raw);
  assert.equal(storage.getItem(otherTab.key), otherTab.raw);
  assert.equal(store.clearOwn(source.id, projectMediaKey(source)), true);
  assert.deepEqual(store.list(source.id), [otherTab]);
});

test('expired immutable drafts are pruned during discovery and future-dated drafts are hidden', () => {
  const source = project();
  const storage = new MemoryStorage();
  let timestamp = Date.now();
  const store = createUnfinishedEditRecoveryStore(() => storage, 'tab-A', () => timestamp);
  const entry = saved(store.write({ project: source, accuracy }));
  timestamp += limits.ttlMs;
  assert.equal(store.list(source.id).length, 1, 'the exact seven-day boundary remains available');
  timestamp += 1;
  assert.deepEqual(store.list(source.id), []);
  assert.equal(storage.getItem(entry.key), null, 'opening a clean project still enforces the retention limit');
  const fresh = saved(store.write({ project: source, accuracy }));
  storage.setItem(fresh.key, JSON.stringify({ ...JSON.parse(fresh.raw), savedAt: timestamp + limits.futureClockAllowanceMs + 1 }));
  assert.deepEqual(store.list(source.id), []);
});

test('oversized entry, oversized editable fields and excessive caption count retain existing recovery', () => {
  const { source, storage, store } = setup();
  const previous = saved(store.write({ project: source, accuracy }));
  assert.equal(store.write({ project: source, accuracy: { ...accuracy, description: 'x'.repeat(limits.maxFieldChars + 1) } }).status, 'too-large');
  const large = { ...source, captions: Array.from({ length: 4 }, (_, index) => ({ id: String(index), text: 'x'.repeat(100_000), startMs: index * 1000, endMs: (index + 1) * 1000 })) };
  assert.equal(store.write({ project: large, captions: edited(large, 'y'.repeat(100_000)) }).status, 'too-large');
  assert.equal(store.write({ project: source, captions: Array.from({ length: limits.maxCaptions + 1 }, (_, index) => ({ id: String(index), text: 'x', startMs: 0, endMs: 1000 })) }).status, 'too-large');
  assert.equal(storage.getItem(previous.key), previous.raw);
});

test('per-project and global entry caps preserve fresh copies and permit replacement of an owned snapshot', () => {
  const source = project();
  const storage = new MemoryStorage();
  const stores = Array.from({ length: limits.maxProjectEntries }, (_, index) => createUnfinishedEditRecoveryStore(() => storage, `owner-${index}`));
  const first = stores.map((store) => saved(store.write({ project: source, accuracy })));
  const refused = createUnfinishedEditRecoveryStore(() => storage, 'overflow');
  assert.equal(refused.write({ project: source, accuracy }).status, 'too-large');
  const replacement = saved(stores[0].write({ project: source, accuracy: { ...accuracy, description: 'Newer draft' } }));
  assert.equal(storage.items.size, limits.maxProjectEntries);
  assert.equal(storage.getItem(first[0].key), null);
  assert.equal(storage.getItem(replacement.key), replacement.raw);
  for (let index = limits.maxProjectEntries; index < limits.maxEntries; index += 1) {
    saved(refused.write({ project: project(`project-${index}`), accuracy }));
  }
  assert.equal(refused.write({ project: project('eleventh'), accuracy }).status, 'too-large');
  assert.equal(storage.items.size, limits.maxEntries);
});

test('aggregate byte cap refuses new storage without evicting fresh copies', () => {
  const storage = new MemoryStorage();
  const store = createUnfinishedEditRecoveryStore(() => storage, 'tab');
  const largeAccuracy = { description: 'x'.repeat(120_000), vocabulary: 'y'.repeat(120_000) };
  const entries = Array.from({ length: 6 }, (_, index) => saved(store.write({ project: project(`project-${index}`), accuracy: largeAccuracy })));
  assert.equal(store.write({ project: project('overflow'), accuracy: largeAccuracy }).status, 'too-large');
  assert.equal(storage.items.size, entries.length);
  for (const entry of entries) assert.equal(storage.getItem(entry.key), entry.raw);
});

const look = (change: Partial<CaptionAppearance> = {}) => normalizeCaptionAppearance({ ...DEFAULT_CAPTION_APPEARANCE, ...change });

test('an appearance-only recovery survives a new owner without copying caption or Accuracy text', () => {
  const { source, storage, store } = setup();
  const basis = look();
  const appearance = look({ fontSize1080: 92, textColor: '#123456' });
  const entry = saved(store.write({ project: source, appearance, appearanceBasis: basis }));
  assert.equal(entry.draft.version, 2);
  assert.deepEqual(Object.keys(entry.draft.basis), ['appearance']);
  assert.equal(entry.draft.captions, undefined);
  assert.equal(entry.draft.accuracy, undefined);
  for (const privateText of ['Hello world', 'Saved topic', 'SavedBrand']) assert.equal(entry.raw.includes(privateText), false);
  const reopened = createUnfinishedEditRecoveryStore(() => storage, 'reopened');
  assert.deepEqual(reopened.list(source.id), [entry]);
  const unrelated = { ...source, title: 'New title', updatedAt: '2026-11-01',
    captions: edited(source, 'New saved captions'), transcriptionContext: { description: 'New context', vocabulary: [] } };
  assert.equal(assessRecovery(entry, unrelated), 'matching');
  const recovered = restoredAppearance(entry, unrelated)!;
  assert.deepEqual(recovered, appearance);
  recovered.fontSize1080 = 40;
  assert.equal(restoredAppearance(entry, unrelated)?.fontSize1080, 92, 'restoration returns a detached validated copy');
  assert.equal(restoredCaptions(entry, unrelated), undefined);
  assert.equal(reopened.contains(entry), true);
});

test('a lost appearance acknowledgement is already saved without rewriting or deleting its exact copy', () => {
  const { source, storage, store } = setup();
  const appearance = look({ fontSize1080: 87 });
  const entry = saved(store.write({ project: source, appearance, appearanceBasis: look() }));
  const canonical = { ...source, captionAppearance: appearance, captions: edited(source), updatedAt: '2026-11-01' };
  assert.equal(assessRecovery(entry, canonical), 'already-saved');
  assert.equal(restoredAppearance(entry, canonical), undefined);
  assert.equal(store.contains(entry), true);
  assert.equal(storage.getItem(entry.key), entry.raw, 'a read cannot prove an older pending write drained');
  assert.deepEqual(store.list(source.id), [entry]);
});

test('mixed recovery skips an already saved appearance and preserves existing caption and context guards', () => {
  const { source, store } = setup();
  const appearance = look({ fontSize1080: 95 });
  const entry = saved(store.write({ project: source, captions: edited(source), accuracy, appearance, appearanceBasis: look() }));
  assert.equal(entry.draft.version, 3);
  assert.deepEqual(Object.keys(entry.draft.basis).sort(), ['appearance', 'captions', 'context']);
  assert.equal(assessRecovery(entry, source), 'matching');
  assert.deepEqual(restoredAppearance(entry, source), appearance);
  const canonical = { ...source, captionAppearance: appearance };
  assert.equal(assessRecovery(entry, canonical), 'matching');
  assert.equal(restoredAppearance(entry, canonical), undefined);
  assert.equal(restoredCaptions(entry, canonical)?.[0].text, 'Hello moon');
  for (const changed of [
    { ...canonical, captions: edited(source, 'Other saved wording') },
    { ...canonical, transcriptionContext: { description: 'Other saved context', vocabulary: [] } },
    { ...canonical, captionAppearance: look({ textColor: '#FEDCBA' }) },
  ]) {
    assert.equal(assessRecovery(entry, changed), 'changed');
    assert.equal(restoredAppearance(entry, changed), undefined);
    assert.equal(restoredCaptions(entry, changed), undefined);
  }
});

test('a foreign saved look or changed media cannot authorize appearance restoration', () => {
  const { source, store } = setup();
  const entry = saved(store.write({ project: source, appearance: look({ fontSize1080: 90 }), appearanceBasis: look() }));
  const changedLook = { ...source, captionAppearance: look({ fontSize1080: 81 }) };
  assert.equal(assessRecovery(entry, changedLook), 'changed');
  assert.equal(restoredAppearance(entry, changedLook), undefined);
  for (const changed of [
    { ...source, id: 'other' },
    { ...source, media: { ...source.media, filename: 'replacement.mp4' } },
    { ...source, media: { ...source.media, size: 201 } },
    { ...source, media: { ...source.media, url: '/media/replacement.mp4' } },
    { ...source, media: { ...source.media, mimeType: 'audio/wav' } },
  ]) {
    assert.equal(assessRecovery(entry, changed), 'media-changed');
    assert.equal(restoredAppearance(entry, changed), undefined);
  }
  entry.draft.appearance!.fontSize1080 = 22;
  entry.draft.basis.appearance = JSON.stringify(look({ fontSize1080: 81 }));
  assert.equal(restoredAppearance(entry, source)?.fontSize1080, 90, 'mutable display data never overrides validated raw evidence');
  assert.equal(assessRecovery(entry, changedLook), 'changed');
});

test('a pending edit back to its starting look remains durable while an older submitted look may still land', () => {
  const { source, storage, store } = setup();
  const basis = look();
  const older = saved(store.write({ project: source, appearance: look({ fontSize1080: 79 }), appearanceBasis: basis }));
  const latest = saved(store.write({ project: source, appearance: basis, appearanceBasis: basis }));
  assert.equal(store.remove(older), true);
  assert.equal(storage.getItem(latest.key), latest.raw);
  const reopened = createUnfinishedEditRecoveryStore(() => storage, 'new-page');
  assert.equal(reopened.contains(latest), true);
  assert.equal(assessRecovery(latest, source), 'already-saved');
  assert.equal(assessRecovery(latest, { ...source, captionAppearance: look({ fontSize1080: 79 }) }), 'changed');
  assert.equal(reopened.contains(latest), true, 'the desired final look stays available for manual comparison');
});

test('appearance recovery rejects incomplete, coerced, unknown and noncanonical persisted settings', () => {
  const corruptions: Array<(draft: Record<string, any>) => void> = [
    (draft) => { draft.version = 1; },
    (draft) => { delete draft.appearance; },
    (draft) => { delete draft.basis.appearance; },
    (draft) => { draft.basis.captions = 'unrelated private text'; },
    (draft) => { draft.appearance.extra = 'not visual settings'; },
    (draft) => { delete draft.appearance.bold; },
    (draft) => { draft.appearance.bold = 'false'; },
    (draft) => { draft.appearance.fontSize1080 = '90'; },
    (draft) => { draft.appearance.fontSize1080 = 121; },
    (draft) => { draft.appearance.textColor = '#abcdef'; },
    (draft) => { draft.appearance.motionDurationMs = 165; },
    (draft) => { draft.appearance.fontFamily = 'x'.repeat(81); },
    (draft) => { draft.basis.appearance = '{}'; },
    (draft) => { draft.basis.appearance = JSON.stringify({ ...look(), glowWidth1080: null }); },
  ];
  for (const corrupt of corruptions) {
    const { source, storage, store } = setup();
    const entry = saved(store.write({ project: source, appearance: look({ fontSize1080: 90 }), appearanceBasis: look() }));
    const draft = JSON.parse(entry.raw);
    corrupt(draft);
    const raw = JSON.stringify(draft);
    storage.setItem(entry.key, raw);
    const malformed = { ...entry, raw };
    assert.deepEqual(store.list(source.id), []);
    assert.equal(store.contains(malformed), false);
    assert.equal(assessRecovery(malformed, source), 'changed');
    assert.equal(restoredAppearance(malformed, source), undefined);
  }
});

test('appearance write admission requires its own canonical saved basis and retains the prior record on failure', () => {
  const { source, storage, store } = setup();
  const entry = saved(store.write({ project: source, appearance: look({ fontSize1080: 90 }), appearanceBasis: look() }));
  assert.equal(store.write({ project: source, appearance: look({ fontSize1080: 91 }) }).status, 'unavailable');
  assert.equal(store.write({ project: source, appearanceBasis: look() }).status, 'unavailable');
  assert.equal(store.write({ project: source, appearance: { ...look(), fontSize1080: 900 }, appearanceBasis: look() }).status, 'unavailable');
  storage.fail = 'set';
  assert.equal(store.write({ project: source, appearance: look({ fontSize1080: 91 }), appearanceBasis: look() }).status, 'unavailable');
  storage.fail = undefined;
  assert.equal(storage.getItem(entry.key), entry.raw);
  assert.equal(store.contains(entry), true);
});

test('contains requires an exact current valid record and fails closed after cross-tab discard or replacement', () => {
  const { source, storage, store } = setup();
  const first = saved(store.write({ project: source, accuracy }));
  assert.equal(store.contains(first), true);
  const newer = saved(store.write({ project: source, accuracy: { ...accuracy, description: 'Newer' } }));
  assert.equal(store.contains(first), false);
  assert.equal(store.contains(newer), true);
  storage.items.set(newer.key, newer.raw + ' ');
  assert.equal(store.contains(newer), false, 'a different raw value at the same key supersedes this exact offer');
  storage.items.set(newer.key, newer.raw);
  const other = createUnfinishedEditRecoveryStore(() => storage, 'other-tab');
  assert.equal(other.remove(newer), true);
  assert.equal(store.contains(newer), false);
  assert.equal(createUnfinishedEditRecoveryStore(() => null, 'unavailable').contains(first), false);
});

test('contains rejects expired records and unavailable storage without removing a valid stored copy', () => {
  const storage = new MemoryStorage();
  const source = project();
  const now = Date.now();
  const writer = createUnfinishedEditRecoveryStore(() => storage, 'writer', () => now);
  const entry = saved(writer.write({ project: source, appearance: look({ fontSize1080: 90 }), appearanceBasis: look() }));
  const expired = createUnfinishedEditRecoveryStore(() => storage, 'later', () => now + limits.ttlMs + 1);
  assert.equal(expired.contains(entry), false);
  assert.equal(storage.getItem(entry.key), entry.raw, 'containment is read-only');
  storage.fail = 'get';
  assert.equal(writer.contains(entry), false);
  storage.fail = undefined;
  assert.equal(writer.contains(entry), true);
  assert.equal(storage.getItem(entry.key), entry.raw);
});

test('appearance-only records share existing admission limits and preserve another page copy on acknowledgement or discard', () => {
  const source = project();
  const storage = new MemoryStorage();
  const stores = Array.from({ length: limits.maxProjectEntries }, (_, index) => createUnfinishedEditRecoveryStore(() => storage, `appearance-${index}`));
  const entries = stores.map((store, index) => saved(store.write({ project: source, appearance: look({ fontSize1080: 80 + index }), appearanceBasis: look() })));
  const overflow = createUnfinishedEditRecoveryStore(() => storage, 'extra');
  assert.equal(overflow.write({ project: source, appearance: look({ fontSize1080: 99 }), appearanceBasis: look() }).status, 'too-large');
  assert.equal(stores[0].write({ project: source }).status, 'cleared');
  for (const entry of entries.slice(1)) assert.equal(overflow.contains(entry), true);
  assert.equal(overflow.remove(entries[1]), true);
  for (const entry of entries.slice(2)) assert.equal(overflow.contains(entry), true);
});

test('Accuracy-only recovery omits private caption evidence and remains valid after unrelated saved caption changes', () => {
  const { source, storage, store } = setup();
  source.captions = Array.from({ length: 12 }, (_, index) => ({ id: `private-${index}`, text: 'Private caption wording '.repeat(5000), startMs: index * 1000, endMs: (index + 1) * 1000 }));
  const before = JSON.stringify(source);
  const entry = saved(store.write({ project: source, accuracy }));
  assert.equal(entry.draft.version, 3);
  assert.deepEqual(Object.keys(entry.draft.basis), ['context']);
  assert.equal(entry.draft.captions, undefined);
  assert.equal(entry.raw.includes('Private caption wording'), false);
  assert.ok(entry.raw.length < 2000, 'a small Accuracy edit does not duplicate a large transcript');
  const canonical = { ...source, captions: [{ id: 'remote', text: 'New saved wording', startMs: 0, endMs: 500, approved: true }], transcriptNeedsSync: true };
  assert.equal(assessRecovery(entry, canonical), 'matching');
  assert.equal(restoredCaptions(entry, canonical), undefined);
  assert.equal(assessRecovery(entry, { ...canonical, transcriptionContext: { description: 'New saved topic', vocabulary: [] } }), 'changed');
  assert.deepEqual(createUnfinishedEditRecoveryStore(() => storage, 'reopened').list(source.id), [entry]);
  assert.equal(JSON.stringify(source), before);
});

test('caption-only recovery omits saved Accuracy text and compares only current caption evidence', () => {
  const { source, store } = setup();
  const entry = saved(store.write({ project: source, captions: edited(source) }));
  assert.equal(entry.draft.version, 3);
  assert.deepEqual(Object.keys(entry.draft.basis), ['captions']);
  assert.equal(entry.draft.accuracy, undefined);
  for (const text of ['Saved topic', 'SavedBrand']) assert.equal(entry.raw.includes(text), false);
  const canonical = { ...source, transcriptionContext: { description: 'A newer saved topic', vocabulary: ['NewBrand'] }, updatedAt: '2026-11-14' };
  assert.equal(assessRecovery(entry, canonical), 'matching');
  assert.equal(restoredCaptions(entry, canonical)?.[0].text, 'Hello moon');
  assert.deepEqual(canonical.transcriptionContext, { description: 'A newer saved topic', vocabulary: ['NewBrand'] });
  assert.equal(assessRecovery(entry, { ...canonical, captions: [{ ...source.captions[0], approved: false }] }), 'changed');
});

test('legacy v1 and mixed v2 records remain readable and retain their two-field basis contract', () => {
  for (const version of [1, 2] as const) {
    for (const field of ['captions', 'accuracy'] as const) {
      const { source, storage, store } = setup();
      const complete = saved(store.write({ project: source, captions: edited(source), accuracy,
        ...(version === 2 ? { appearance: look({ fontSize1080: 93 }), appearanceBasis: look() } : {}) }));
      const draft = { ...complete.draft, version };
      if (field === 'captions') delete draft.accuracy;
      else delete draft.captions;
      const entry = { ...complete, draft, raw: JSON.stringify(draft) };
      storage.setItem(entry.key, entry.raw);
      assert.deepEqual(store.list(source.id), [entry]);
      assert.equal(assessRecovery(entry, source), 'matching');
      const unrelated = field === 'captions'
        ? { ...source, transcriptionContext: { description: 'Changed remotely', vocabulary: [] } }
        : { ...source, captions: edited(source, 'Changed remotely') };
      assert.equal(assessRecovery(entry, unrelated), 'changed', 'legacy evidence is never silently reinterpreted');
      assert.equal(store.contains(entry), true);
    }
  }
});

test('v3 records reject missing or unrelated bases, empty payloads and unguarded appearances', () => {
  const corruptions: Array<(draft: Record<string, any>) => void> = [
    (draft) => { delete draft.basis.context; },
    (draft) => { draft.basis.captions = 'Unrelated private text'; },
    (draft) => { delete draft.accuracy; },
    (draft) => { draft.basis.appearance = JSON.stringify(look()); },
    (draft) => { draft.appearance = look({ fontSize1080: 91 }); },
    (draft) => { draft.version = 4; },
  ];
  for (const corrupt of corruptions) {
    const { source, storage, store } = setup();
    const original = saved(store.write({ project: source, accuracy }));
    const draft = JSON.parse(original.raw);
    corrupt(draft);
    const malformed = { ...original, raw: JSON.stringify(draft) };
    storage.setItem(original.key, malformed.raw);
    assert.deepEqual(store.list(source.id), []);
    assert.equal(store.contains(malformed), false);
    assert.equal(assessRecovery(malformed, source), 'changed');
    assert.equal(storage.getItem(original.key), malformed.raw, 'unknown or malformed data is not silently deleted');
  }
  const { source, storage, store } = setup();
  const original = saved(store.write({ project: source, captions: edited(source), accuracy, appearance: look({ fontSize1080: 91 }), appearanceBasis: look() }));
  for (const basis of ['captions', 'context', 'appearance'] as const) {
    const draft = JSON.parse(original.raw);
    delete draft.basis[basis];
    const malformed = { ...original, raw: JSON.stringify(draft) };
    storage.setItem(original.key, malformed.raw);
    assert.equal(store.contains(malformed), false);
  }
});

test('a forced baseline caption snapshot remains bounded, field-specific and exact-owned while an older save is pending', () => {
  const { source, storage, store } = setup();
  const other = createUnfinishedEditRecoveryStore(() => storage, 'other-tab');
  const foreign = saved(other.write({ project: source, accuracy }));
  const pending = saved(store.write({ project: source, captions: source.captions, keepUnchangedCaptions: true }));
  assert.equal(pending.draft.version, 3);
  assert.deepEqual(Object.keys(pending.draft.basis), ['captions']);
  assert.equal(assessRecovery(pending, source), 'matching');
  assert.equal(assessRecovery(pending, { ...source, captions: edited(source, 'Older submitted wording') }), 'changed');
  assert.equal(store.write({ project: source, captions: source.captions }).status, 'cleared');
  assert.equal(store.contains(pending), false);
  assert.equal(store.contains(foreign), true);
  assert.equal(storage.getItem(foreign.key), foreign.raw);
});
