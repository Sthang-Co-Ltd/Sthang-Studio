import crypto from 'node:crypto';

const endpoint = String(process.env.STHANG_CONTRIBUTION_ENDPOINT || '').trim().replace(/\/+$/, '');
const adminToken = String(process.env.CONTRIBUTION_ADMIN_TOKEN || '').trim();

if (!endpoint.startsWith('https://')) throw new Error('Set STHANG_CONTRIBUTION_ENDPOINT to the approved HTTPS contribution origin.');
if (adminToken.length < 16) throw new Error('Set CONTRIBUTION_ADMIN_TOKEN through the operator secret environment.');

function makeWave(durationMs = 720) {
  const sampleRate = 16_000;
  const samples = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${endpoint}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* surfaced below */ }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body?.error || 'unexpected response'}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const suffix = crypto.randomBytes(8).toString('hex');
const contributorId = `synthetic_${suffix}`;
const contributorToken = crypto.randomBytes(32).toString('base64url');
const candidateId = crypto.createHash('sha256').update(`sthang-synthetic:${suffix}`).digest('hex').slice(0, 32);
const audio = makeWave();
const audioSha256 = crypto.createHash('sha256').update(audio).digest('hex');
const authHeaders = { 'X-Sthang-Contributor-Token': contributorToken };

console.log('Checking contribution health...');
const health = await request('/health');
if (health?.ok !== true) throw new Error('Contribution health response is not healthy.');

console.log('Submitting synthetic Khmer correction...');
const submitted = await request('/v1/contributions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify({
    schemaVersion: 1,
    contributorId,
    candidateId,
    captionStartMs: 1000,
    captionEndMs: 1500,
    clipStartMs: 900,
    clipEndMs: 1620,
    originalText: 'ខុស',
    correctedText: 'ត្រូវ',
    sourceTimingSource: 'stt',
    sourceTextModel: 'synthetic-validation',
    sourceEngineVersion: '0.8.0-synthetic',
    appVersion: '0.8.0-synthetic',
    audioDurationMs: 720,
    audioSha256,
    audioBase64: audio.toString('base64'),
  }),
});
if (!submitted?.receiptId || submitted?.status !== 'submitted') throw new Error('Synthetic sample was not recorded as submitted.');

console.log('Checking submitted status...');
let status = await request(`/v1/contributors/${contributorId}/status`, { headers: authHeaders });
let sample = status?.samples?.find((item) => item.candidateId === candidateId);
if (sample?.status !== 'submitted') throw new Error('Synthetic sample is missing from contributor status.');

console.log('Marking synthetic sample verified...');
await request(`/v1/admin/samples/${candidateId}/status`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
  body: JSON.stringify({ status: 'verified' }),
});

status = await request(`/v1/contributors/${contributorId}/status`, { headers: authHeaders });
sample = status?.samples?.find((item) => item.candidateId === candidateId);
if (sample?.status !== 'verified' || !sample?.verifiedAt) throw new Error('Synthetic verification state did not round-trip.');

console.log('Withdrawing synthetic contributor data...');
const withdrawn = await request(`/v1/contributors/${contributorId}/withdraw`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: '{}',
});
if (withdrawn?.withdrawn !== true) throw new Error('Synthetic withdrawal was not confirmed.');

status = await request(`/v1/contributors/${contributorId}/status`, { headers: authHeaders });
sample = status?.samples?.find((item) => item.candidateId === candidateId);
if (sample?.status !== 'withdrawn') throw new Error('Synthetic sample did not end in withdrawn state.');

console.log('Contribution production synthetic validation passed.');
