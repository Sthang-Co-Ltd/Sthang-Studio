const SUBMITTED_RETENTION_DAYS = 180;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 20;

/**
 * Delete unverified audio after 180 days and blank its caption text. Each D1 row
 * is updated only after the matching R2 object has been deleted, so a partial
 * cron run cannot claim deletion that did not happen.
 */
export async function cleanupExpiredSubmitted(env, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - SUBMITTED_RETENTION_DAYS * 86_400_000).toISOString();
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const rows = await env.DB.prepare(
      "SELECT candidate_id, object_key FROM samples WHERE status = 'submitted' AND created_at < ? ORDER BY created_at LIMIT ?",
    ).bind(cutoff, BATCH_SIZE).all();
    const samples = rows.results || [];
    if (!samples.length) break;
    const keys = samples.map((sample) => sample.object_key).filter(Boolean);
    if (keys.length) await env.CORPUS.delete(keys);
    const changedAt = new Date(nowMs).toISOString();
    await env.DB.batch(samples.map((sample) => env.DB.prepare(
      `UPDATE samples
       SET status = 'rejected', updated_at = ?, rejected_at = ?, rejection_reason = 'expired-unverified', original_text = '', corrected_text = ''
       WHERE candidate_id = ? AND status = 'submitted'`,
    ).bind(changedAt, changedAt, sample.candidate_id)));
    removed += samples.length;
  }
  return removed;
}

export { SUBMITTED_RETENTION_DAYS };
