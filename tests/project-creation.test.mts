import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-create-test-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { createProjectFromUpload, ProjectCreationError } = await import('../apps/server/src/services/project-creation.js');
const projectDir = path.join(path.dirname(config.dataFile), 'projects');
await fs.mkdir(config.uploadDir, { recursive: true });
await store.list();
let sequence = 0;
const ids = new Set<string>();
const token = () => { const id = `upload_${String(++sequence).padStart(32, '0')}`; ids.add(id); return id; };
const details = (id: string) => ({ creationAttemptId: id, title: 'Synthetic captured title', lastModified: '1767225600000' });
async function upload(name = 'synthetic.wav', bytes = 'Synthetic media fixture') {
  const file = path.join(config.uploadDir, `incoming-${++sequence}`);
  await fs.writeFile(file, bytes);
  return { path: file, originalname: name, mimetype: 'audio/wav', size: Buffer.byteLength(bytes) };
}
const exists = async (file: string) => fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
afterEach(() => { for (const id of ids) cancelScheduledProjectPrewarm(id); });
after(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

test('a proven pre-publication failure removes only its owned media and the same attempt can retry', async (t) => {
  const id = token();
  const unrelated = path.join(config.uploadDir, 'unrelated-saved-source.wav');
  await fs.writeFile(unrelated, 'Keep existing source');
  const incoming = await upload();
  const rename = fs.rename;
  const fault = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === path.join(projectDir, `${id}.json`)) throw new Error('Synthetic project publication failure');
    return rename(...args);
  });
  try {
    await assert.rejects(createProjectFromUpload(incoming, details(id)), (error: unknown) => {
      assert.ok(error instanceof ProjectCreationError);
      assert.equal(error.code, 'PROJECT_CREATE_NOT_APPLIED');
      assert.equal(error.outcome, 'not-created');
      return true;
    });
    assert.equal(await store.get(id), null);
    assert.equal(await exists(incoming.path), false);
    assert.equal((await fs.readdir(config.uploadDir)).some((name) => name.startsWith(id)), false);
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'Keep existing source');
  } finally { fault.mock.restore(); }
  const saved = await createProjectFromUpload(await upload(), details(id));
  cancelScheduledProjectPrewarm(id);
  assert.equal(saved.project.id, id);
  assert.equal(saved.reused, false);
  assert.equal(saved.orderSaved, true);
  assert.equal((await store.listSummaries()).filter((item) => item.id === id).length, 1);
});

test('a post-publication index failure retains the project, source and current summaries', async (t) => {
  const id = token();
  const rename = fs.rename;
  const fault = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === path.join(projectDir, 'order.json')) throw new Error('Synthetic index failure');
    return rename(...args);
  });
  try {
    const saved = await createProjectFromUpload(await upload(), details(id));
    cancelScheduledProjectPrewarm(id);
    assert.equal(saved.orderSaved, false);
    assert.equal(saved.reused, false);
    assert.equal(await exists(path.join(config.uploadDir, saved.project.media.filename)), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(projectDir, `${id}.json`), 'utf8')).id, id);
    assert.equal((await store.listSummaries()).filter((item) => item.id === id).length, 1);
    const duplicate = await upload();
    const recovered = await createProjectFromUpload(duplicate, details(id));
    assert.equal(recovered.reused, true);
    assert.equal(recovered.project.media.filename, saved.project.media.filename);
    assert.equal(await exists(duplicate.path), false);
    assert.equal((await fs.readdir(config.uploadDir)).filter((name) => name.startsWith(id)).length, 1);
  } finally { fault.mock.restore(); }
});

test('concurrent duplicate receipts serialize to one project and mismatched metadata cannot overwrite it', async () => {
  const id = token();
  const first = await upload(); const second = await upload();
  const receipts = await Promise.all([createProjectFromUpload(first, details(id)), createProjectFromUpload(second, details(id))]);
  cancelScheduledProjectPrewarm(id);
  assert.deepEqual(receipts.map((item) => item.reused).sort(), [false, true]);
  assert.equal(receipts[0].project.media.filename, receipts[1].project.media.filename);
  assert.equal(await exists(first.path), false); assert.equal(await exists(second.path), false);
  const original = (await store.get(id))!;
  for (const changed of [
    { originalname: 'different.wav' }, { size: first.size + 1 }, { mimetype: 'video/mp4' },
  ]) {
    const incoming = { ...await upload(), ...changed };
    await assert.rejects(createProjectFromUpload(incoming, details(id)), (error: unknown) => error instanceof ProjectCreationError && error.code === 'PROJECT_CREATE_ATTEMPT_MISMATCH');
    assert.equal(await exists(incoming.path), false);
  }
  await assert.rejects(createProjectFromUpload(await upload(), { ...details(id), lastModified: '1767225600001' }), (error: unknown) => error instanceof ProjectCreationError && error.code === 'PROJECT_CREATE_ATTEMPT_MISMATCH');
  assert.deepEqual(await store.get(id), original);
  assert.equal((await fs.readdir(config.uploadDir)).filter((name) => name.startsWith(id)).length, 1);
  const disk = JSON.parse(await fs.readFile(path.join(projectDir, `${id}.json`), 'utf8'));
  assert.deepEqual(disk.creationAttempt, { id, source: { name: first.originalname, size: first.size, mimeType: first.mimetype, lastModified: 1767225600000 } });
});

test('unsafe identities and unreadable existing records are never overwritten', async () => {
  const invalid = await upload();
  await assert.rejects(createProjectFromUpload(invalid, details('../outside')), (error: unknown) => error instanceof ProjectCreationError && error.code === 'PROJECT_CREATE_NOT_APPLIED');
  assert.equal(await exists(invalid.path), false);
  const id = token();
  const record = path.join(projectDir, `${id}.json`);
  await fs.writeFile(record, '{Unreadable saved project fixture');
  const incoming = await upload();
  await assert.rejects(createProjectFromUpload(incoming, details(id)), (error: unknown) => error instanceof ProjectCreationError && error.outcome === 'unknown');
  assert.equal(await fs.readFile(record, 'utf8'), '{Unreadable saved project fixture');
  assert.equal(await exists(incoming.path), false);
  assert.equal((await fs.readdir(config.uploadDir)).some((name) => name.startsWith(id)), false);
});

test('ordinary non-creation upserts retain their index-error rejection contract', async (t) => {
  const id = token();
  const sample = (await store.list())[0];
  const rename = fs.rename;
  const fault = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === path.join(projectDir, 'order.json')) throw new Error('Synthetic ordinary index failure');
    return rename(...args);
  });
  try { await assert.rejects(store.upsert({ ...sample, id, title: 'Ordinary caller' }), /Synthetic ordinary index failure/); }
  finally { fault.mock.restore(); }
});
