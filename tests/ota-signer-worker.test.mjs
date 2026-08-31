import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import test from 'node:test';
import {
  STUDIO_REPOSITORY,
  STUDIO_REPOSITORY_ID,
  STUDIO_SIGNING_ACTOR_ID,
  STUDIO_SIGNING_ACTOR_LOGIN,
  assertPackageMatchesSource,
  handleRequest,
  parseZip,
  releaseIssueCommand,
  verifyGithubWebhook,
} from '../infra/ota-signer/src/index.mjs';

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(value) {
  const b = Buffer.alloc(2); b.writeUInt16LE(value); return b;
}
function u32(value) {
  const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content);
    const method = entry.method ?? 8;
    const compressed = method === 0 ? content : zlib.deflateRawSync(content);
    const crc = crc32(content);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(content.length), u16(name.length), u16(0), name, compressed,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(content.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
}

function releasePayload(overrides = {}) {
  return {
    action: 'created',
    repository: { full_name: STUDIO_REPOSITORY, id: STUDIO_REPOSITORY_ID },
    issue: { state: 'open', title: 'release: v0.8.0', number: 30 },
    comment: {
      id: 123,
      body: '/studio-ota-sign',
      author_association: 'OWNER',
      user: { login: STUDIO_SIGNING_ACTOR_LOGIN, id: STUDIO_SIGNING_ACTOR_ID },
    },
    sender: { login: STUDIO_SIGNING_ACTOR_LOGIN, id: STUDIO_SIGNING_ACTOR_ID },
    ...overrides,
  };
}

test('ZIP parser verifies stored and deflated entries and strips GitHub archive root', async () => {
  const zip = makeZip([
    { name: 'repo-abcd/package.json', content: '{"version":"0.8.0"}', method: 8 },
    { name: 'repo-abcd/config/update-trust-root.json', content: '{}', method: 0 },
  ]);
  const parsed = await parseZip(zip, { stripFirstSegment: true });
  assert.equal(Buffer.from(parsed.entries.get('package.json')).toString(), '{"version":"0.8.0"}');
  assert.equal(Buffer.from(parsed.entries.get('config/update-trust-root.json')).toString(), '{}');
});

test('ZIP parser rejects traversal and protected runtime state', async () => {
  await assert.rejects(() => parseZip(makeZip([{ name: '../evil.txt', content: 'x' }])));
  await assert.rejects(() => parseZip(makeZip([{ name: 'data/projects.json', content: 'x' }])));
  await assert.rejects(() => parseZip(makeZip([{ name: 'apps/server/.env', content: 'x' }])));
});

test('package/source byte comparison rejects changed or extra files', () => {
  const source = new Map([
    ['package.json', Buffer.from('{}')],
    ['apps/server/src/index.ts', Buffer.from('source')],
  ]);
  const exact = new Map([
    ['package.json', Buffer.from('{}')],
    ['apps/server/src/index.ts', Buffer.from('source')],
  ]);
  assert.doesNotThrow(() => assertPackageMatchesSource(exact, source));
  const changed = new Map(exact);
  changed.set('apps/server/src/index.ts', Buffer.from('changed'));
  assert.throws(() => assertPackageMatchesSource(changed, source));
  const extra = new Map(exact);
  extra.set('README-extra.txt', Buffer.from('no'));
  assert.throws(() => assertPackageMatchesSource(extra, source));
});

test('release command is exact and owner-bound', () => {
  assert.deepEqual(releaseIssueCommand(releasePayload()), {
    issueNumber: 30,
    commentId: 123,
    actor: STUDIO_SIGNING_ACTOR_LOGIN,
    actorId: STUDIO_SIGNING_ACTOR_ID,
  });
  assert.throws(() => releaseIssueCommand(releasePayload({ sender: { login: 'attacker', id: 9 } })));
  const wrong = releasePayload();
  wrong.comment.body = '/studio-ota-sign please';
  assert.throws(() => releaseIssueCommand(wrong));
});

test('GitHub webhook HMAC must match exact request body', async () => {
  const secret = 'a-very-long-production-webhook-secret';
  const body = Buffer.from('{"action":"created"}');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const request = new Request('https://signer.sthang.app/github/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': `sha256=${signature}` },
    body,
  });
  await assert.doesNotReject(() => verifyGithubWebhook(request, body, secret));
  const bad = new Request('https://signer.sthang.app/github/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
    body,
  });
  await assert.rejects(() => verifyGithubWebhook(bad, body, secret));
});

test('health endpoint exposes only public signer identity', async () => {
  const response = await handleRequest(new Request('https://signer.sthang.app/health'), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.keyId, 'studio-updates-ed25519-root-v1');
  assert.equal(JSON.stringify(body).includes('private'), false);
});
