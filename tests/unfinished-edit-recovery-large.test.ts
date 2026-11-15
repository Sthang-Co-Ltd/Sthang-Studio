import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCaptionAppearance, type CaptionProject, type CaptionSegment } from '@kcs/shared';
import {
  assessRecovery, createUnfinishedEditRecoveryStore, restoredAppearance, restoredCaptions,
  UNFINISHED_EDIT_RECOVERY_LIMITS as limits,
} from '../apps/web/src/unfinished-edit-recovery.js';

class MemoryStorage {
  readonly items = new Map<string, string>();
  failOnSet = false;
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failOnSet) throw new Error('Quota exceeded'); this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}

function project(captions: CaptionSegment[]): CaptionProject {
  return {
    id: 'large-project', title: 'Large project', createdAt: '2026-11-01', updatedAt: '2026-11-01',
    media: { filename: 'source.mp4', originalName: 'source.mp4', url: '/media/source.mp4', mimeType: 'video/mp4', size: 1024 },
    mode: 'dynamic', transcript: null, captions,
  };
}

function benchCaptions(count = 5000): CaptionSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `scale-${index}`,
    text: `សួស្តី នេះជាចំណងជើងសាកល្បង ${index + 1} Khmer caption`,
    startMs: index * 2000, endMs: index * 2000 + 1800,
    approved: index % 2 === 0,
  }));
}

test('a 5,000-caption accepted edit is captured within one bounded browser record and survives reload', () => {
  const storage = new MemoryStorage();
  const source = project(benchCaptions());
  const edits = source.captions.map((caption, index) => index === 2500 ? { ...caption, text: caption.text + ' កែសម្រួល' } : caption);
  const store = createUnfinishedEditRecoveryStore(() => storage, 'writer');
  const result = store.write({ project: source, captions: edits });
  assert.equal(result.status, 'saved', 'accepted edits must be recoverable within the existing 1 MiB limit');
  const entry = result.entry!;
  const usedBytes = 2 * (entry.key.length + entry.raw.length);
  assert.ok(usedBytes <= limits.maxEntryBytes);
  const wire = JSON.parse(entry.raw);
  assert.equal(wire.version, 4);
  assert.equal(wire.basis.captions[2].length, source.captions.length);
  assert.equal(wire.captions.length, edits.length);
  assert.equal(typeof wire.captions[0], 'number', 'unchanged edit values reuse the saved cue');
  assert.equal(Array.isArray(wire.captions[2500]), true, 'changed wording is stored as editable data');
  assert.equal(entry.draft.version, 3, 'all App readers continue to receive the original field-scoped contract');
  const reopened = createUnfinishedEditRecoveryStore(() => storage, 'another-page').list(source.id);
  assert.equal(reopened.length, 1);
  assert.deepEqual(reopened[0].draft, entry.draft);
  assert.equal(assessRecovery(reopened[0], source), 'matching');
  const recovered = restoredCaptions(reopened[0], source)!;
  assert.equal(recovered.length, edits.length);
  for (let index = 0; index < edits.length; index += 1) {
    assert.deepEqual(
      [recovered[index].id, recovered[index].text, recovered[index].startMs, recovered[index].endMs],
      [edits[index].id, edits[index].text, edits[index].startMs, edits[index].endMs],
      `recovered cue ${index} must preserve its exact editable values`,
    );
  }
  assert.equal(recovered[2500].approved, false, 'the changed caption cannot inherit approval');
  assert.equal(recovered[2499].approved, source.captions[2499].approved, 'an unchanged caption keeps fresh canonical approval');
  assert.ok(entry.draft.basis.captions!.length > limits.maxEntryBytes / 2,
    'the expanded exact comparison string is too long for the v3 reader cap');
});

function uuidCaptions(count: number): CaptionSegment[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `e286a4cf-c7af-4cb2-b916-${index.toString(16).padStart(12, '0')}`;
    const text = `នេះជា ${index % 3 ? 'ការសាកល្បង' : 'ចំណងជើងសម្រាប់ការពិនិត្យ'} Khmer ${index}`;
    const startMs = index * 2100;
    const wordTiming = index % 113 === 0 ? {
      version: 1 as const, text, words: [
        { id: `w-${id}`, startOffset: 0, endOffset: text.length,
          startMs: index % 2 === 0 ? null : startMs,
          endMs: index % 2 === 0 ? null : startMs + 1700,
          source: (index % 3 === 0 ? 'estimated' : index % 3 === 1 ? 'manual' : 'aligned') as 'estimated' | 'manual' | 'aligned',
          needsReview: index % 2 === 0 },
      ],
    } : undefined;
    return {
      id, text, startMs, endMs: startMs + 1800,
      approved: index % 4 === 0, textLocked: index % 3 === 0, timingLocked: index % 5 === 0,
      confidence: 0.87, timingQuality: 'medium' as const, timingSource: 'stt-split' as const,
      ...(wordTiming ? { wordTiming } : {}),
    };
  });
}

/** Mirrors the original saved v3 equality basis exactly, including provenance.
 * Assert reconstruction against this independent description, not its own wire. */
function canonicalCaptionBasis(source: CaptionProject): string {
  return JSON.stringify([Boolean(source.transcriptNeedsSync), source.mediaAlignment || null, source.captions.map((caption) => [
    caption.id, caption.text, caption.startMs, caption.endMs, Boolean(caption.approved),
    Boolean(caption.textLocked), Boolean(caption.timingLocked), caption.confidence ?? null,
    caption.timingQuality ?? null, caption.timingSource ?? null,
    caption.wordTiming ? [
      caption.wordTiming.version, caption.wordTiming.text, caption.wordTiming.words.map((word) =>
        [word.id, word.startOffset, word.endOffset, word.startMs, word.endMs, word.source, Boolean(word.needsReview)]),
    ] : null,
  ])]);
}

function savedCompact(source: CaptionProject, edits: CaptionSegment[]) {
  const storage = new MemoryStorage();
  const store = createUnfinishedEditRecoveryStore(() => storage, 'large-owner');
  const result = store.write({ project: source, captions: edits });
  assert.equal(result.status, 'saved');
  const entry = result.entry!;
  assert.equal(JSON.parse(entry.raw).version, 4, 'the fixture should exercise v4 on disk');
  return { storage, store, entry };
}

test('compact wire round-trips varied Khmer, UUIDs, order/deletions, locks and the entire saved word evidence', () => {
  const source = {
    ...project(uuidCaptions(3000)), transcriptNeedsSync: true,
    mediaAlignment: { state: 'unverified-audio-change' as const, acceptedAt: '2026-11-14T13:01:00.000Z', sourceRevision: 'revision-a' },
    transcriptionContext: { description: 'សរសេរចំណងជើង', vocabulary: ['ABC', 'ទំនិញ'] },
  };
  const before = JSON.stringify(source);
  const edits = source.captions.slice(3).reverse().map((caption, index) =>
    index === 55 ? { ...caption, text: `${caption.text} កែសម្រួល`, timingLocked: !caption.timingLocked } : caption);
  edits.splice(9, 0, { id: 'new-uuid-cue', text: 'ពាក្យថ្មី', startMs: 6301000, endMs: 6302300 });
  const { storage, entry } = savedCompact(source, edits);
  assert.equal(entry.draft.version, 3);
  assert.equal(entry.draft.basis.captions, canonicalCaptionBasis(source));
  const reopened = createUnfinishedEditRecoveryStore(() => storage, 'new-page').list(source.id);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].draft.basis.captions, canonicalCaptionBasis(source));
  assert.deepEqual(reopened[0].draft.captions, entry.draft.captions);
  const restored = restoredCaptions(reopened[0], source)!;
  assert.equal(restored.length, edits.length);
  for (let index = 0; index < edits.length; index += 1) {
    assert.deepEqual(
      [restored[index].id, restored[index].text, restored[index].startMs, restored[index].endMs,
        Boolean(restored[index].textLocked), Boolean(restored[index].timingLocked)],
      [edits[index].id, edits[index].text, edits[index].startMs, edits[index].endMs,
        Boolean(edits[index].textLocked), Boolean(edits[index].timingLocked)],
      `restored order and editable data must match index ${index}`,
    );
  }
  assert.equal(restored[55].approved, false);
  assert.equal(restored[9].approved, false, 'a new cue never gains approval');
  const unchangedWord = restored.find((caption) => caption.id === source.captions[113].id)!;
  assert.deepEqual(unchangedWord.wordTiming, source.captions[113].wordTiming);
  assert.equal(JSON.stringify(source), before, 'writing and parsing never mutate saved evidence');

  for (const changed of [
    { ...source, transcriptNeedsSync: false },
    { ...source, mediaAlignment: { ...source.mediaAlignment, sourceRevision: 'revision-b' } },
    { ...source, captions: source.captions.map((cue, index) => index === 50 ? { ...cue, confidence: 0.86 } : cue) },
    { ...source, captions: source.captions.map((cue, index) => index === 50 ? { ...cue, timingQuality: 'low' as const } : cue) },
    { ...source, captions: source.captions.map((cue, index) => index === 50 ? { ...cue, timingSource: 'manual' as const } : cue) },
    { ...source, captions: source.captions.map((cue, index) => index === 0 ? { ...cue, approved: !cue.approved } : cue) },
    { ...source, captions: source.captions.map((cue, index) => index === 0 ? {
      ...cue, wordTiming: { ...cue.wordTiming!, words: [{ ...cue.wordTiming!.words[0], needsReview: !cue.wordTiming!.words[0].needsReview }] },
    } : cue) },
  ]) assert.equal(assessRecovery(reopened[0], changed), 'changed', 'saved provenance changes require comparison');
});

test('mixed compact wire retains field-scoped Accuracy and Appearance plus exact media and context checks', () => {
  const source = project(uuidCaptions(3000));
  const storage = new MemoryStorage();
  const store = createUnfinishedEditRecoveryStore(() => storage, 'writer');
  const captions = source.captions.map((caption, index) => index === 12 ? { ...caption, text: 'កែសម្រួល' } : caption);
  const accuracy = { description: 'និយាយអំពីការដឹកជញ្ជូន\n', vocabulary: 'ពាក្យចាស់ | ពាក្យថ្មី' };
  const appearanceBasis = normalizeCaptionAppearance(undefined);
  const appearance = normalizeCaptionAppearance({ ...appearanceBasis, fontSize1080: 90 });
  const result = store.write({ project: source, captions, accuracy, appearance, appearanceBasis });
  assert.equal(result.status, 'saved');
  const entry = result.entry!;
  assert.equal(JSON.parse(entry.raw).version, 4);
  const reopened = createUnfinishedEditRecoveryStore(() => storage, 'new-page').list(source.id)[0];
  assert.deepEqual(reopened.draft.accuracy, accuracy);
  assert.deepEqual(restoredAppearance(reopened, source), appearance);
  assert.equal(restoredCaptions(reopened, source)?.[12].text, 'កែសម្រួល');
  assert.equal(assessRecovery(reopened, { ...source, transcriptionContext: { description: 'Changed', vocabulary: [] } }), 'changed');
  assert.equal(assessRecovery(reopened, { ...source, media: { ...source.media, filename: 'new.mp4' } }), 'media-changed');
  assert.equal(assessRecovery(reopened, { ...source, captionAppearance: appearance }), 'matching');
  assert.equal(restoredAppearance(reopened, { ...source, captionAppearance: appearance }), undefined);
  assert.equal(assessRecovery(reopened, { ...source, captionAppearance: normalizeCaptionAppearance({ fontSize1080: 88 }) }), 'changed');
});

test('malformed compact wire is rejected before restore, without deleting the altered raw record', () => {
  const source = project(uuidCaptions(3000));
  const edits = source.captions.map((cue, index) => index === 0 ? { ...cue, text: 'New caption' } : cue);
  const { storage, store, entry } = savedCompact(source, edits);
  const original = JSON.parse(entry.raw);
  const corruptions: Array<(wire: any) => void> = [
    (wire) => { wire.unexpected = true; },
    (wire) => { wire.basis.extra = true; },
    (wire) => { wire.basis.captions[0] = true; },
    (wire) => { wire.basis.captions[1] = { state: 'unverified-audio-change', acceptedAt: 'today', sourceRevision: 'r', extra: 'x' }; },
    (wire) => { wire.basis.captions[2][0][4] = 8; },
    (wire) => { wire.basis.captions[2][0][4] = 4294967296; },
    (wire) => { wire.basis.captions[2][0][4] = 1.5; },
    (wire) => { wire.basis.captions[2][0].push('unexpected'); },
    (wire) => { wire.basis.captions[2][0][2] = -1; },
    (wire) => { wire.basis.captions[2][0][3] = wire.basis.captions[2][0][2]; },
    (wire) => { wire.basis.captions[2][1][0] = wire.basis.captions[2][0][0]; },
    (wire) => { wire.basis.captions[2][0][8][2][0][6] = 2; },
    (wire) => { wire.basis.captions[2][0][8][2][0][2] = 999999; },
    (wire) => { wire.basis.captions[2][0][8][2][0][5] = 'foreign'; },
    (wire) => { wire.basis.captions[2][0][8].push('extra'); },
    (wire) => { wire.basis.captions[2][0][5] = -0.1; },
    (wire) => { wire.basis.captions[2][0][1] = 'ខ'.repeat(limits.maxFieldChars + 1); },
    (wire) => { wire.captions[1] = -1; },
    (wire) => { wire.captions[1] = 3000; },
    (wire) => { wire.captions[1] = 0.5; },
    (wire) => { wire.captions[1] = wire.captions[0]; },
    (wire) => { wire.captions[1] = 2; wire.captions[2] = 2; },
    (wire) => { wire.captions[0][4] = 4; },
    (wire) => { wire.captions[0][2] = -10; },
    (wire) => { wire.captions[0].push(true); },
    (wire) => { wire.captions[0][1] = 'ខ'.repeat(limits.maxFieldChars + 1); },
    (wire) => { delete wire.captions; },
    (wire) => { delete wire.basis.captions; },
    (wire) => { wire.version = 3; },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const wire = structuredClone(original);
    corrupt(wire);
    const raw = JSON.stringify(wire);
    storage.setItem(entry.key, raw);
    assert.equal(store.contains({ ...entry, raw }), false, `malformed v4 case ${index} cannot be current`);
    assert.equal(store.list(source.id).length, 0, `malformed v4 case ${index} cannot be listed`);
    assert.equal(assessRecovery({ ...entry, raw }, source), 'changed');
    assert.equal(restoredCaptions({ ...entry, raw }, source), undefined);
    assert.equal(storage.getItem(entry.key), raw, 'invalid data stays for user comparison');
  }
  storage.setItem(entry.key, entry.raw);
  assert.equal(store.contains(entry), true);
});

test('compact records enforce exact raw ownership, quota failure retention, and seven-day expiry', () => {
  const source = project(uuidCaptions(3000));
  const storage = new MemoryStorage();
  let now = Date.now();
  const store = createUnfinishedEditRecoveryStore(() => storage, 'writer', () => now);
  const captions = source.captions.map((cue, index) => index === 5 ? { ...cue, text: 'កែសម្រួល A' } : cue);
  const result = store.write({ project: source, captions });
  assert.equal(result.status, 'saved');
  const entry = result.entry!;
  assert.equal(JSON.parse(entry.raw).version, 4);
  storage.failOnSet = true;
  assert.equal(store.write({ project: source, captions: source.captions.map((cue, index) =>
    index === 5 ? { ...cue, text: 'កែសម្រួល B' } : cue) }).status, 'unavailable');
  storage.failOnSet = false;
  assert.equal(storage.getItem(entry.key), entry.raw);
  storage.setItem(entry.key, entry.raw + ' ');
  assert.equal(store.contains(entry), false);
  assert.equal(store.remove(entry), false, 'another tab changed the exact raw value');
  assert.equal(storage.getItem(entry.key), entry.raw + ' ');
  storage.setItem(entry.key, entry.raw);
  const otherTab = createUnfinishedEditRecoveryStore(() => storage, 'other-tab', () => now);
  assert.equal(otherTab.contains(entry), true);
  now += limits.ttlMs + 1;
  assert.equal(otherTab.contains(entry), false);
  assert.equal(storage.getItem(entry.key), entry.raw, 'a non-mutating lookup preserves expired copy');
  assert.equal(otherTab.list(source.id).length, 0);
  assert.equal(storage.getItem(entry.key), null, 'expired valid compact record is pruned');
});

test('truly long and word-heavy saved bases fail closed without overwriting an existing copy', () => {
  const storage = new MemoryStorage();
  const store = createUnfinishedEditRecoveryStore(() => storage, 'writer');
  const small = project(benchCaptions(2));
  const first = store.write({ project: small, accuracy: { description: 'protected', vocabulary: 'មិនបាត់' } });
  assert.equal(first.status, 'saved');
  const previous = first.entry!;
  const long = project(Array.from({ length: 300 }, (_, index) => ({
    id: `long-${index}`, text: 'ខ'.repeat(2500), startMs: index * 2000, endMs: index * 2000 + 1500,
  })));
  assert.equal(store.write({ project: long, captions: long.captions.map((cue, index) =>
    index === 0 ? { ...cue, text: cue.text + 'កែ' } : cue) }).status, 'too-large');

  const token = 'ខ្មែរ ';
  const wordHeavy = project(Array.from({ length: 350 }, (_, index) => {
    const startMs = index * 3000;
    const text = token.repeat(60);
    return {
      id: `word-heavy-${index}`, text, startMs, endMs: startMs + 2000,
      wordTiming: { version: 1 as const, text, words: Array.from({ length: 60 }, (_, wordIndex) => ({
        id: `word-${index}-${wordIndex}`, startOffset: wordIndex * token.length,
        endOffset: wordIndex * token.length + token.length - 1,
        startMs: startMs + wordIndex * 20, endMs: startMs + wordIndex * 20 + 15,
        source: 'manual' as const,
      })) },
    };
  }));
  assert.equal(store.write({ project: wordHeavy, captions: wordHeavy.captions.map((cue, index) =>
    index === 0 ? { ...cue, text: cue.text + 'កែ' } : cue) }).status, 'too-large');
  assert.equal(storage.getItem(previous.key), previous.raw);
  assert.equal(store.contains(previous), true);
});
