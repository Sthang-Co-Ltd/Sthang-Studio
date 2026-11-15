import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportSessionStorage, EXPORT_SESSION_MAX_AGE, EXPORT_SESSION_PREFIX } from '../apps/web/src/export-session-storage.js';
import { createExportWorkspaceSession } from '../apps/web/src/export-session.js';

function fixture() {
  const values = new Map<string, string>();
  const storage: Storage = { get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, clear: () => values.clear() };
  let time = 1_800_000_000_000;
  return { values, storage, advance: (ms: number) => { time += ms; }, store: createExportSessionStorage(() => storage, () => time) };
}
const project = (id = 'project-a', filename = 'source.mp4') => ({ id, media: { filename, size: 123 } }) as Parameters<ReturnType<typeof createExportSessionStorage>['read']>[0];
const choices = () => ({ ...createExportWorkspaceSession(true), settingsHydrated: true,
  settings: { resolution: '1080p', frameRate: 30, quality: 'high', codec: 'h264', encoder: 'auto' } } as ReturnType<typeof createExportWorkspaceSession>);

test('project choices survive a new store, stay isolated, and never carry captions or private UI fields', () => {
  const f = fixture(); const input = { ...choices(), captions: [{ text: 'private caption' }], title: 'private title' };
  assert.equal(f.store.write(project(), input), true);
  assert.deepEqual(createExportSessionStorage(() => f.storage, () => 1_800_000_000_000).read(project()), choices());
  assert.equal(f.store.read(project('other')), null);
  assert.equal(f.store.read(project('project-a', 'replacement.mp4')), null);
  assert(![...f.values.values()][0].includes('private'));
});
test('caption destination and advanced output remain separate from video choices', () => {
  const f = fixture(); const value = { ...choices(), outputMode: 'captions' as const,
    handoff: { destination: 'resolve' as const, advancedFormat: 'vtt' as const, advancedOpen: true } };
  assert(f.store.write(project(), value)); assert.deepEqual(f.store.read(project()), value);
});
test('layout diagnostics and support revisions stay in memory when output choices are remembered', () => {
  const f = fixture(); const value = { ...choices(), layoutCapabilityRevision: 7,
    layoutCheck: { key: 'private caption text and layout basis', result: { status: 'blocked' as const, width: 640, height: 360,
      issues: [{ code: 'caption-overflow', captionIds: ['private-caption-id'], message: 'private diagnostic' }] } } };
  assert.equal(f.store.write(project(), value), true);
  const raw = [...f.values.values()][0];
  assert.equal(raw.includes('private'), false); assert.equal(raw.includes('layoutCheck'), false);
  assert.equal(raw.includes('layoutCapabilityRevision'), false);
  assert.deepEqual(f.store.read(project()), choices());
});
test('expired, corrupt, oversized, noncanonical and future records are never adopted', () => {
  const f = fixture(); assert(f.store.write(project(), choices()));
  const key = [...f.values.keys()][0], valid = f.values.get(key)!;
  for (const raw of ['{broken', 'x'.repeat(4097), JSON.stringify({ ...JSON.parse(valid), savedAt: 1_900_000_000_000 }),
    JSON.stringify({ ...JSON.parse(valid), session: { ...choices(), settings: { ...choices().settings, codec: 'unsafe' } } })]) {
    f.values.set(key, raw); assert.equal(f.store.read(project()), null);
  }
  f.values.set(key, valid); f.advance(EXPORT_SESSION_MAX_AGE + 1);
  assert.equal(f.store.read(project()), null); assert.equal(f.values.has(key), false);
});
test('optional storage failure preserves the previous choices and does not throw', () => {
  const f = fixture(); assert(f.store.write(project(), choices())); const original = [...f.values.entries()];
  f.storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  assert.equal(f.store.write(project(), createExportWorkspaceSession(true)), false);
  assert.deepEqual([...f.values.entries()], original);
  assert.equal(createExportSessionStorage(() => { throw new Error('blocked'); }).write(project(), choices()), false);
  assert.equal(createExportSessionStorage(() => null).read(project()), null);
});
test('retention bounds affect only this optional choice store and newest choices survive', () => {
  const f = fixture(); f.values.set('sthang:unfinished-edits:keep', 'private draft');
  for (let i = 0; i < 23; i++) { f.advance(100); assert(f.store.write(project('project-' + i), choices())); }
  assert.equal([...f.values.keys()].filter((key) => key.startsWith(EXPORT_SESSION_PREFIX)).length, 20);
  assert.equal(f.store.read(project('project-0')), null);
  assert.deepEqual(f.store.read(project('project-22')), choices());
  assert.equal(f.values.get('sthang:unfinished-edits:keep'), 'private draft');
});
