const WORKER_VERSION = '1';
const MAX_REQUEST_BYTES = 1_650_000;
const MAX_AUDIO_BYTES = 1_200_000;
const MAX_TEXT = 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const CANDIDATE_RE = /^[a-f0-9]{32}$/;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

function base64Bytes(value) {
  if (typeof value !== 'string' || value.length < 56 || value.length > 1_650_000) throw new Error('audioBase64 is invalid');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isWave(bytes) {
  if (bytes.length < 44) return false;
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  const riff = ascii(0, 4);
  return ['RIFF', 'RF64'].includes(riff) && ascii(8, 12) === 'WAVE';
}

function compact(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ');
}

function hasKhmer(value) {
  return /[\u1780-\u17FF]/u.test(value);
}

export async function validateSubmission(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('body must be an object');
  if (raw.schemaVersion !== 1) throw new Error('unsupported schemaVersion');
  const contributorId = String(raw.contributorId || '');
  const candidateId = String(raw.candidateId || '');
  if (!ID_RE.test(contributorId)) throw new Error('invalid contributorId');
  if (!CANDIDATE_RE.test(candidateId)) throw new Error('invalid candidateId');

  const captionStartMs = Math.round(Number(raw.captionStartMs));
  const captionEndMs = Math.round(Number(raw.captionEndMs));
  const clipStartMs = Math.round(Number(raw.clipStartMs));
  const clipEndMs = Math.round(Number(raw.clipEndMs));
  if (![captionStartMs, captionEndMs, clipStartMs, clipEndMs].every(Number.isFinite)) throw new Error('invalid timing');
  if (captionStartMs < 0 || captionEndMs <= captionStartMs || captionEndMs - captionStartMs > 15_000) throw new Error('caption timing out of range');
  if (clipStartMs < 0 || clipEndMs <= clipStartMs || clipEndMs - clipStartMs > 16_000) throw new Error('clip timing out of range');
  if (clipStartMs > captionStartMs || clipEndMs < captionEndMs) throw new Error('clip must contain caption range');

  const originalText = compact(raw.originalText);
  const correctedText = compact(raw.correctedText);
  if (!originalText || !correctedText || originalText.length > MAX_TEXT || correctedText.length > MAX_TEXT) throw new Error('caption text out of range');
  if (originalText === correctedText) throw new Error('correction must change text');
  if (!hasKhmer(`${originalText}${correctedText}`)) throw new Error('sample must contain Khmer script');

  const sourceTimingSource = String(raw.sourceTimingSource || '');
  if (!['stt', 'stt-split', 'interpolated'].includes(sourceTimingSource)) throw new Error('source timing is not generated evidence');
  const sourceTextModel = String(raw.sourceTextModel || '').slice(0, 120);
  const sourceEngineVersion = String(raw.sourceEngineVersion || '').slice(0, 80);
  const appVersion = String(raw.appVersion || '').slice(0, 40);
  if (!appVersion) throw new Error('appVersion is required');

  const audio = base64Bytes(raw.audioBase64);
  if (audio.length > MAX_AUDIO_BYTES || !isWave(audio)) throw new Error('audio must be a bounded WAV');
  const audioSha256 = String(raw.audioSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(audioSha256) || await sha256(audio) !== audioSha256) throw new Error('audio hash mismatch');
  const audioDurationMs = Math.round(Number(raw.audioDurationMs));
  if (!Number.isFinite(audioDurationMs) || audioDurationMs < 250 || audioDurationMs > 16_000) throw new Error('audio duration out of range');

  return {
    contributorId,
    candidateId,
    captionStartMs,
    captionEndMs,
    clipStartMs,
    clipEndMs,
    originalText,
    correctedText,
    sourceTimingSource,
    sourceTextModel,
    sourceEngineVersion,
    appVersion,
    audio,
    audioSha256,
    audioDurationMs,
  };
}

async function readBoundedJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new Error('request too large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error('request too large');
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function contributorTokenHash(request) {
  const token = request.headers.get('X-Sthang-Contributor-Token') || '';
  if (token.length < 32 || token.length > 200) return null;
  return sha256(token);
}

async function requireContributor(env, request, contributorId) {
  const tokenHash = await contributorTokenHash(request);
  if (!tokenHash) return { error: json({ error: 'Contributor authorization required' }, 401) };
  const row = await env.DB.prepare('SELECT token_hash FROM contributors WHERE id = ?').bind(contributorId).first();
  if (!row || row.token_hash !== tokenHash) return { error: json({ error: 'Contributor authorization failed' }, 403) };
  return { tokenHash };
}

async function acceptContribution(request, env) {
  const tokenHash = await contributorTokenHash(request);
  if (!tokenHash) return json({ error: 'Contributor authorization required' }, 401);
  let sample;
  try {
    sample = await validateSubmission(await readBoundedJson(request));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Invalid contribution' }, 400);
  }

  const existingContributor = await env.DB.prepare('SELECT token_hash FROM contributors WHERE id = ?').bind(sample.contributorId).first();
  if (existingContributor && existingContributor.token_hash !== tokenHash) return json({ error: 'Contributor authorization failed' }, 403);

  const existingSample = await env.DB.prepare(
    'SELECT contributor_id, receipt_id, status FROM samples WHERE candidate_id = ?',
  ).bind(sample.candidateId).first();
  if (existingSample) {
    if (existingSample.contributor_id !== sample.contributorId) return json({ error: 'Candidate id is already registered' }, 409);
    return json({ receiptId: existingSample.receipt_id, status: existingSample.status });
  }

  const now = new Date().toISOString();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM samples WHERE contributor_id = ? AND created_at >= datetime('now', '-1 day')",
  ).bind(sample.contributorId).first();
  if (Number(recent?.count || 0) >= 500) return json({ error: 'Daily contribution limit reached' }, 429);

  const receiptId = crypto.randomUUID();
  const objectKey = `contributors/${sample.contributorId}/${sample.candidateId}.wav`;
  await env.CORPUS.put(objectKey, sample.audio, {
    httpMetadata: { contentType: 'audio/wav' },
    customMetadata: {
      receiptId,
      candidateId: sample.candidateId,
      audioSha256: sample.audioSha256,
      appVersion: sample.appVersion,
    },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO contributors (id, token_hash, created_at, last_seen_at, withdrawn_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, withdrawn_at = NULL`,
      ).bind(sample.contributorId, tokenHash, now, now),
      env.DB.prepare(
        `INSERT INTO samples (
          candidate_id, contributor_id, receipt_id, status, original_text, corrected_text,
          caption_start_ms, caption_end_ms, clip_start_ms, clip_end_ms,
          source_timing_source, source_text_model, source_engine_version, app_version,
          audio_sha256, audio_duration_ms, object_key, created_at, updated_at
        ) VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        sample.candidateId, sample.contributorId, receiptId, sample.originalText, sample.correctedText,
        sample.captionStartMs, sample.captionEndMs, sample.clipStartMs, sample.clipEndMs,
        sample.sourceTimingSource, sample.sourceTextModel, sample.sourceEngineVersion, sample.appVersion,
        sample.audioSha256, sample.audioDurationMs, objectKey, now, now,
      ),
    ]);
  } catch (error) {
    await env.CORPUS.delete(objectKey).catch(() => {});
    throw error;
  }

  return json({ receiptId, status: 'submitted' }, 201);
}

async function contributionStatus(request, env, contributorId) {
  const auth = await requireContributor(env, request, contributorId);
  if (auth.error) return auth.error;
  const rows = await env.DB.prepare(
    `SELECT candidate_id, receipt_id, status, verified_at, rejected_at, rejection_reason, audio_duration_ms
     FROM samples WHERE contributor_id = ? ORDER BY created_at DESC LIMIT 5000`,
  ).bind(contributorId).all();
  return json({
    samples: (rows.results || []).map((row) => ({
      candidateId: row.candidate_id,
      receiptId: row.receipt_id,
      status: row.status,
      verifiedAt: row.verified_at || undefined,
      rejectedAt: row.rejected_at || undefined,
      rejectionReason: row.rejection_reason || undefined,
      audioDurationMs: Number(row.audio_duration_ms || 0),
    })),
  });
}

async function withdrawContributor(request, env, contributorId) {
  const auth = await requireContributor(env, request, contributorId);
  if (auth.error) return auth.error;
  let removed = 0;
  while (true) {
    const rows = await env.DB.prepare(
      "SELECT object_key FROM samples WHERE contributor_id = ? AND status != 'withdrawn' LIMIT 500",
    ).bind(contributorId).all();
    const keys = (rows.results || []).map((row) => row.object_key).filter(Boolean);
    if (!keys.length) break;
    await env.CORPUS.delete(keys);
    removed += keys.length;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE samples SET status = 'withdrawn', updated_at = ?, original_text = '', corrected_text = '', rejection_reason = NULL WHERE contributor_id = ? AND status != 'withdrawn'",
    ).bind(now, contributorId).run();
  }
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE contributors SET withdrawn_at = ?, last_seen_at = ? WHERE id = ?').bind(now, now, contributorId).run();
  return json({ withdrawn: true, removed });
}

async function adminStatus(request, env, candidateId) {
  const expected = String(env.CONTRIBUTION_ADMIN_TOKEN || '');
  const supplied = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || !supplied || await sha256(expected) !== await sha256(supplied)) return json({ error: 'Not authorized' }, 403);
  let body;
  try { body = await readBoundedJson(request); } catch { return json({ error: 'Invalid status request' }, 400); }
  const status = String(body.status || '');
  if (!['verified', 'rejected'].includes(status)) return json({ error: 'Status must be verified or rejected' }, 400);
  const reason = status === 'rejected' ? compact(body.reason).slice(0, 160) : '';
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE samples SET status = ?, updated_at = ?, verified_at = ?, rejected_at = ?, rejection_reason = ?
     WHERE candidate_id = ? AND status != 'withdrawn'`,
  ).bind(status, now, status === 'verified' ? now : null, status === 'rejected' ? now : null, reason || null, candidateId).run();
  if (!result.meta?.changes) return json({ error: 'Sample not found' }, 404);
  return json({ candidateId, status });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'sthang-studio-contribution', version: WORKER_VERSION });
    if (request.method === 'POST' && url.pathname === '/v1/contributions') return acceptContribution(request, env);

    const statusMatch = url.pathname.match(/^\/v1\/contributors\/([A-Za-z0-9_-]{8,80})\/status$/);
    if (request.method === 'GET' && statusMatch) return contributionStatus(request, env, statusMatch[1]);
    const withdrawMatch = url.pathname.match(/^\/v1\/contributors\/([A-Za-z0-9_-]{8,80})\/withdraw$/);
    if (request.method === 'POST' && withdrawMatch) return withdrawContributor(request, env, withdrawMatch[1]);
    const adminMatch = url.pathname.match(/^\/v1\/admin\/samples\/([a-f0-9]{32})\/status$/);
    if (request.method === 'POST' && adminMatch) return adminStatus(request, env, adminMatch[1]);
    return json({ error: 'Not found' }, 404);
  },
};
