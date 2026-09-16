import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import test from 'node:test';
import {
  STUDIO_REPOSITORY,
  STUDIO_REPOSITORY_ID,
  STUDIO_SIGNING_ACTOR_ID,
  STUDIO_SIGNING_ACTOR_LOGIN,
  acceptedMainFromAtom,
  assertExactSourceTree,
  assertPackageMatchesSource,
  compareStudioVersions,
  handleRequest,
  latestPointerDocument,
  parseZip,
  promotionIssueCommand,
  releaseChecksum,
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
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const content = Buffer.from(entry.content);
    const method = entry.method ?? 8;
    const flags = entry.flags ?? 0x0800;
    const localFlags = entry.localFlags ?? flags;
    const localMethod = entry.localMethod ?? method;
    const compressed = method === 0 ? content : zlib.deflateRawSync(content);
    const crc = crc32(content);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(localFlags), u16(localMethod), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(content.length), u16(localName.length), u16(0), localName, compressed,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(content.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(entry.externalAttributes ?? 0), u32(offset), name,
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

function requiredSource() {
  return new Map([
    ['package.json', Buffer.from('{}')],
    ['package-lock.json', Buffer.from('{}')],
    ['config/update-trust-root.json', Buffer.from('{}')],
    ['scripts/update-protocol.mjs', Buffer.from('protocol')],
    ['scripts/update-runtime.mjs', Buffer.from('runtime')],
    ['scripts/launch-studio.ps1', Buffer.from('launch')],
    ['scripts/prepare-studio-update.ps1', Buffer.from('prepare')],
    ['run-windows.bat', Buffer.from('run')],
    ['apps/server/src/index.ts', Buffer.from('source')],
  ]);
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

test('ZIP parser rejects unsafe Windows paths, protected state, symlinks, and local-header mismatches', async () => {
  const cases = [
    [{ name: '../evil.txt', content: 'x' }],
    [{ name: 'data/projects.json', content: 'x' }],
    [{ name: 'apps/server/.env', content: 'x' }],
    [{ name: 'apps\\server\\evil.txt', content: 'x' }],
    [{ name: 'apps/server/file.txt:stream', content: 'x' }],
    [{ name: 'apps/server/CON.txt', content: 'x' }],
    [{ name: 'apps/server/file. ', content: 'x' }],
    [{ name: 'apps/server/link', content: 'target', externalAttributes: 0xA0000000 }],
    [{ name: 'apps/server/file.txt', localName: 'apps/server/other.txt', content: 'x' }],
  ];
  for (const entries of cases) await assert.rejects(() => parseZip(makeZip(entries)));
});

test('source-archive mode may inspect protected scaffolding without allowing it into the OTA payload', async () => {
  const zip = makeZip([
    { name: 'repo-abcd/package.json', content: '{}' },
    { name: 'repo-abcd/data/.gitkeep', content: '' },
    { name: 'repo-abcd/apps/server/src/index.ts', content: 'source' },
  ]);
  await assert.rejects(() => parseZip(zip, { stripFirstSegment: true }), /protected runtime state/i);
  const parsed = await parseZip(zip, { stripFirstSegment: true, allowProtectedRuntimeState: true });
  assert.equal(parsed.entries.has('data/.gitkeep'), true);
  assert.equal(parsed.entries.has('apps/server/src/index.ts'), true);

  const source = requiredSource();
  source.set('data/.gitkeep', Buffer.from(''));
  const exactPayload = new Map([...source].filter(([path]) => path !== 'data/.gitkeep'));
  assert.doesNotThrow(() => assertPackageMatchesSource(exactPayload, source));
  const protectedPackage = new Map(source);
  assert.throws(() => assertPackageMatchesSource(protectedPackage, source), /file set/i);
});

test('package/source byte comparison requires critical files and rejects changed or extra files', () => {
  const source = requiredSource();
  const exact = new Map(source);
  assert.doesNotThrow(() => assertPackageMatchesSource(exact, source));

  const changed = new Map(exact);
  changed.set('apps/server/src/index.ts', Buffer.from('changed'));
  assert.throws(() => assertPackageMatchesSource(changed, source));

  const extra = new Map(exact);
  extra.set('README-extra.txt', Buffer.from('no'));
  assert.throws(() => assertPackageMatchesSource(extra, source));

  const missing = new Map(exact);
  missing.delete('scripts/update-runtime.mjs');
  assert.throws(() => assertPackageMatchesSource(missing, source));
});

test('GitHub commit feed parsing accepts only the first exact commit entry', () => {
  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  const atom = `<?xml version="1.0"?><feed><entry><id>tag:github.com,2008:Grit::Commit/${first}</id></entry><entry><id>tag:github.com,2008:Grit::Commit/${second}</id></entry></feed>`;
  assert.equal(acceptedMainFromAtom(atom), first);
  assert.throws(() => acceptedMainFromAtom('<feed><entry><id>not-a-commit</id></entry></feed>'));
});

test('recovery tag source tree must exactly equal accepted source', () => {
  const accepted = new Map([
    ['package.json', Buffer.from('package')],
    ['README.md', Buffer.from('readme')],
  ]);
  assert.doesNotThrow(() => assertExactSourceTree(new Map(accepted), accepted, 'fixture tag'));
  const changed = new Map(accepted);
  changed.set('README.md', Buffer.from('changed'));
  assert.throws(() => assertExactSourceTree(changed, accepted, 'fixture tag'), /does not match/i);
  const missing = new Map(accepted);
  missing.delete('README.md');
  assert.throws(() => assertExactSourceTree(missing, accepted, 'fixture tag'), /does not match/i);
});

test('GitHub recovery checksum parser binds the exact archive filename', () => {
  const digest = 'c'.repeat(64);
  assert.equal(releaseChecksum(`${digest}  Sthang-Studio-Windows-v0.85.2.zip\r\n`, 'Sthang-Studio-Windows-v0.85.2.zip'), digest);
  assert.throws(() => releaseChecksum(`${digest}  other.zip\n`, 'Sthang-Studio-Windows-v0.85.2.zip'));
  assert.throws(() => releaseChecksum('not-a-checksum', 'Sthang-Studio-Windows-v0.85.2.zip'));
});

test('release command is exact, owner-bound, and never accepts pull-request comments', () => {
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
  const pr = releasePayload();
  pr.issue.pull_request = { url: 'https://example.invalid/pr' };
  assert.throws(() => releaseIssueCommand(pr));
});

test('latest promotion command is separately exact and owner-bound', () => {
  const payload = releasePayload();
  payload.comment.body = '/studio-ota-promote';
  assert.deepEqual(promotionIssueCommand(payload), {
    issueNumber: 30,
    commentId: 123,
    actor: STUDIO_SIGNING_ACTOR_LOGIN,
    actorId: STUDIO_SIGNING_ACTOR_ID,
  });
  assert.throws(() => releaseIssueCommand(payload));
  const extra = releasePayload();
  extra.comment.body = '/studio-ota-promote now';
  assert.throws(() => promotionIssueCommand(extra));
  const outsider = releasePayload();
  outsider.comment.body = '/studio-ota-promote';
  outsider.sender = { login: 'attacker', id: 9 };
  assert.throws(() => promotionIssueCommand(outsider));
});

test('promotion pointer construction is version-ordered and immutable-manifest bound', () => {
  assert.equal(compareStudioVersions('0.85.2', '0.85.0'), 1);
  assert.equal(compareStudioVersions('0.85.2', '0.85.2'), 0);
  assert.equal(compareStudioVersions('0.85.2-beta.1', '0.85.2'), -1);
  const manifestSha256 = 'a'.repeat(64);
  assert.deepEqual(latestPointerDocument('0.85.2', manifestSha256), {
    schemaVersion: 1,
    product: 'sthang-studio',
    platform: 'windows-x64',
    channel: 'preview',
    version: '0.85.2',
    manifestUrl: 'https://updates.sthang.app/studio/windows/v0.85.2/release.json',
    manifestSha256,
  });
  assert.throws(() => latestPointerDocument('0.85.2', 'bad'));
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
