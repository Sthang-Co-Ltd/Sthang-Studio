import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadRecoveryStore, matchingUploadFile, UPLOAD_RECOVERY_LIMITS, UPLOAD_RECOVERY_PREFIX, uploadTitle } from '../apps/web/src/upload-recovery.js';

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const timestamp = Date.parse('2026-11-14T00:00:00Z');
const id = (index: number) => `upload_${index.toString(16).padStart(32, '0')}`;
const file = { name: 'Original.caption.clip.mp4', size: 42, type: 'video/mp4', lastModified: 1767225600000 };

test('a restart restores only exact minimal metadata, with no title or media bytes', () => {
  const storage = new MemoryStorage();
  const first = createUploadRecoveryStore(() => storage, () => timestamp);
  const saved = first.keep({ ...file, privateText: 'Private caption fixture', bytes: 'Media fixture' } as typeof file, id(1));
  assert.ok(saved.entry); assert.equal(saved.error, '');
  const reopened = createUploadRecoveryStore(() => storage, () => timestamp + 1000).read();
  assert.equal(reopened.error, ''); assert.equal(reopened.entries.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(saved.entry.raw)).sort(), ['capturedAt', 'id', 'lastModified', 'name', 'size', 'type', 'version']);
  assert.equal(saved.entry.raw.includes('Private caption fixture'), false);
  assert.equal(saved.entry.raw.includes('Media fixture'), false);
  assert.equal(uploadTitle(reopened.entries[0].metadata.name), 'Original.caption.clip');
  assert.equal(matchingUploadFile(file, reopened.entries[0].metadata), true);
});

test('independent attempts remain available and capacity never evicts an unresolved reminder', () => {
  const storage = new MemoryStorage(); const store = createUploadRecoveryStore(() => storage, () => timestamp);
  for (let index = 1; index <= UPLOAD_RECOVERY_LIMITS.maxEntries; index++) assert.ok(store.keep({ ...file, name: `${index}.mp4` }, id(index)).entry);
  const before = [...storage.values];
  assert.equal(store.keep(file, id(99)).entry, null);
  assert.deepEqual([...storage.values], before);
  const entries = store.read().entries;
  assert.equal(store.remove(entries[1]), true);
  assert.ok(store.keep(file, id(99)).entry);
  assert.equal(store.read().entries.some((entry) => entry.metadata.id === entries[0].metadata.id), true);
});

test('expired valid reminders are removed after seven days; malformed and future records are never trusted', () => {
  const storage = new MemoryStorage(); const store = createUploadRecoveryStore(() => storage, () => timestamp);
  const saved = store.keep(file, id(1)).entry!;
  storage.setItem(UPLOAD_RECOVERY_PREFIX + id(2), '{Unsupported JSON');
  storage.setItem(UPLOAD_RECOVERY_PREFIX + id(3), JSON.stringify({ ...saved.metadata, id: id(3), capturedAt: timestamp + UPLOAD_RECOVERY_LIMITS.futureClockAllowanceMs + 1 }));
  storage.setItem(UPLOAD_RECOVERY_PREFIX + id(4), JSON.stringify({ ...saved.metadata, id: id(4), version: 2 }));
  assert.deepEqual(store.read().entries.map((entry) => entry.metadata.id), [id(1)]);
  const expired = createUploadRecoveryStore(() => storage, () => timestamp + UPLOAD_RECOVERY_LIMITS.ttlMs + 1);
  expired.read();
  assert.equal(storage.getItem(saved.key), null);
  assert.equal(storage.getItem(UPLOAD_RECOVERY_PREFIX + id(2)), '{Unsupported JSON');
});

test('an old acknowledgement cannot remove changed metadata or another tab\'s newer attempt', () => {
  const storage = new MemoryStorage(); const store = createUploadRecoveryStore(() => storage, () => timestamp);
  const old = store.keep(file, id(1)).entry!;
  const newer = store.keep({ ...file, name: 'Newer.mp4' }, id(2)).entry!;
  storage.setItem(old.key, JSON.stringify({ ...old.metadata, capturedAt: timestamp + 1 }));
  assert.equal(store.isCurrent(old), false); assert.equal(store.remove(old), false);
  assert.equal(store.isCurrent(newer), true);
  assert.equal(store.read().entries.length, 2);
  assert.equal(store.remove(newer), true);
  assert.equal(store.read().entries[0].metadata.id, id(1));
});

test('reselection checks every original file detail and cannot replace an existing attempt identity', () => {
  const storage = new MemoryStorage(); const store = createUploadRecoveryStore(() => storage, () => timestamp);
  const original = store.keep(file, id(1)).entry!;
  for (const changed of [{ name: 'Other.mp4' }, { size: 43 }, { type: 'audio/wav' }, { lastModified: file.lastModified + 1 }]) {
    assert.equal(matchingUploadFile({ ...file, ...changed }, original.metadata), false);
    assert.equal(store.keep({ ...file, ...changed }, id(1)).entry, null);
    assert.equal(storage.getItem(original.key), original.raw);
  }
  assert.equal(matchingUploadFile({ ...file, type: '' }, { ...file, type: 'application/octet-stream' }), true);
});

test('storage denial, quota and oversized metadata report failure without losing earlier reminders', () => {
  assert.notEqual(createUploadRecoveryStore(() => { throw new Error('Denied'); }).read().error, '');
  const storage = new MemoryStorage(); const store = createUploadRecoveryStore(() => storage, () => timestamp);
  const earlier = store.keep(file, id(1)).entry!;
  storage.setItem = () => { throw new Error('Synthetic quota'); };
  assert.notEqual(store.keep(file, id(2)).error, '');
  assert.equal(store.isCurrent(earlier), true);
  assert.equal(store.keep({ ...file, name: 'x'.repeat(513) }, id(3)).entry, null);
  assert.equal(store.keep(file, '../unsafe').entry, null);
});
