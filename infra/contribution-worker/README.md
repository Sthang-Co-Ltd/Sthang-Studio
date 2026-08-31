# Sthang Studio contribution service

This directory defines the **unreleased** Sthang-owned intake service for the optional Khmer Caption Contributor program.

It is intentionally separate from PostHog. PostHog receives only allow-listed product events; this service receives opted-in correction samples consisting of a bounded short WAV clip plus generated/corrected caption evidence.

## Data boundary

The public client protocol accepts:

- a random contributor id and an HTTPS bearer-equivalent contributor token;
- a deterministic candidate id used for idempotency/deduplication;
- exact caption and contributed-clip timing;
- original generated wording and final corrected wording;
- generated-timing/model/app-version evidence;
- a mono WAV clip bounded to 16 seconds / 1.2 MB plus its SHA-256.

It must not receive project titles, source filenames, local filesystem paths, full videos, topic/context text, correction-memory databases, SRT exports, Gemini API keys, or PostHog identifiers.

The Worker hashes the contributor token before storing it. Audio objects stay in a **private** R2 bucket. D1 stores the correction metadata and private object key. A contributor-wide withdrawal authenticated with the same local token deletes R2 objects and blanks contributed text in D1 before marking records withdrawn.

## Verification lifecycle

New samples enter `submitted`. They are **not** shown as verified merely because upload succeeded. A separate maintainer-only status endpoint can mark a sample `verified` or `rejected` after corpus QA. The admin token is a Worker secret and must never be committed.

This separation is deliberate: user edits are candidate evidence, not automatic training truth.

## Provisioning (separately approval-gated)

Production provisioning/deployment is not authorized merely by merging this source. An approved operator must:

1. Create the private R2 bucket and D1 database.
2. Apply `schema.sql` to D1.
3. Copy `wrangler.template.jsonc` to a local ignored Wrangler config and replace the D1 id.
4. Add `CONTRIBUTION_ADMIN_TOKEN` using Wrangler secret storage.
5. Apply Cloudflare rate limiting/WAF policy to `contribute.sthang.app` in addition to the Worker’s validation and per-contributor daily cap.
6. Deploy the Worker and verify `/health` over the production hostname.
7. Configure released Studio with `STHANG_CONTRIBUTION_ENDPOINT=https://contribute.sthang.app` only after the privacy/release gates are complete.

Do not commit Wrangler credentials, API tokens, D1 access material, private corpus samples, or production configuration containing secrets.

## Withdrawal contract

`POST /v1/contributors/:id/withdraw` is idempotent at the data-model level. Studio retains its local withdrawal credential specifically so a contributor can request deletion without creating a Sthang account. If the service is unavailable, Studio records deletion as pending and retries at a later startup or explicit sync.

For v0.8, corpus collection and verification are the production boundary. Any future training pipeline must retain sample provenance/split discipline and honor the published contribution/withdrawal policy; deploying or training a production model remains a separate product/governance action.
