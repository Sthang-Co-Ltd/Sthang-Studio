# Sthang Studio contribution service

This directory defines the **unreleased** Sthang-owned intake service for the optional Khmer Caption Contributor program.

It is intentionally separate from product analytics. The contribution service receives opted-in correction samples consisting of a bounded short WAV clip plus generated/corrected caption evidence; the separate Sthang analytics relay receives only allow-listed coarse product events.

## Data boundary

The public client protocol accepts:

- a random contributor id and an HTTPS bearer-equivalent contributor token;
- a deterministic candidate id used for idempotency/deduplication;
- exact caption and contributed-clip timing;
- original generated wording and final corrected wording;
- generated-timing/model/app-version evidence;
- a mono WAV clip bounded to 16 seconds / 1.2 MB plus its SHA-256.

It must not receive project titles, source filenames, local filesystem paths, full videos, topic/context text, correction-memory databases, SRT exports, Gemini API keys, or analytics identifiers.

The Worker hashes the contributor token before storing it. Audio objects stay in a **private** R2 bucket. D1 stores the correction metadata and private object key. A contributor-wide withdrawal authenticated with the same local token deletes R2 objects and blanks contributed text in D1 before marking records withdrawn.

## Verification lifecycle

New samples enter `submitted`. They are **not** shown as verified merely because upload succeeded. A separate maintainer-only status endpoint can mark a sample `verified` or `rejected` after corpus QA. The admin token is a Worker secret and must never be committed.

This separation is deliberate: user edits are candidate evidence, not automatic training truth.

## Production provisioning

Provision only from an authenticated operator environment. Keep `wrangler.local.jsonc`, `.dev.vars`, provider credentials, and the admin secret out of Git.

```text
cd infra/contribution-worker
npx wrangler@latest login
npx wrangler@latest r2 bucket create sthang-studio-contribution-private --location apac
npx wrangler@latest d1 create sthang-studio-contribution --location apac
```

Copy `wrangler.template.jsonc` to the ignored `wrangler.local.jsonc`, replace `REPLACE_WITH_D1_DATABASE_ID` with the exact D1 id returned by the create command, then initialize the remote schema:

```text
npx wrangler@latest d1 execute sthang-studio-contribution --remote --file=./schema.sql --config ./wrangler.local.jsonc
```

The Worker is Studio's origin at `contribute.sthang.app`, so the template uses a Cloudflare **Custom Domain** rather than a route in front of another origin. `workers.dev` stays disabled. The template also declares `CONTRIBUTION_ADMIN_TOKEN` as a required Worker secret.

Once the D1 schema and private R2 binding are ready, set the admin secret using Wrangler's secret store and deploy the exact reviewed Worker:

```text
npx wrangler@latest secret put CONTRIBUTION_ADMIN_TOKEN --config ./wrangler.local.jsonc
npx wrangler@latest deploy --config ./wrangler.local.jsonc
```

The secret command prompts for the value; do not place it on the command line, in shell history, source, or logs. Confirm that the private R2 bucket has no public/custom-domain access of its own. Apply Cloudflare rate limiting/WAF protection to the public Worker hostname in addition to the Worker's schema checks and per-contributor daily cap.

Verify the public health endpoint:

```text
curl https://contribute.sthang.app/health
```

Then run the full synthetic lifecycle below before setting Studio's versioned contribution `provisioned` flag to `true`.

`config/product-services.json` is versioned source so existing Studio installations receive the same public Sthang service endpoints when they update. Operator/development environment variables may override it deliberately, but ordinary users must not need to edit `.env`.

Do not commit Wrangler credentials, API tokens, D1 access material, private corpus samples, production configuration containing secrets, or analytics-processor credentials.

## Production synthetic validation

After the production Worker, D1 schema, private R2 binding, Custom Domain, and admin secret are live, run the repository-owned destructive synthetic lifecycle check from an approved operator environment:

```text
STHANG_CONTRIBUTION_ENDPOINT=https://contribute.sthang.app \
CONTRIBUTION_ADMIN_TOKEN=<operator-secret> \
node scripts/verify-contribution-production.mjs
```

The script creates only synthetic Khmer text and generated silence audio, confirms `submitted`, marks that sample `verified` through the maintainer endpoint, then withdraws the synthetic contributor and confirms the sample ends `withdrawn`. It does not print the admin token or contributor token.

The optional product-analytics smoke check is separate and goes only through the Sthang relay:

```text
STHANG_ANALYTICS_ENDPOINT=https://analytics.sthang.app \
node scripts/verify-product-analytics-ingestion.mjs
```

That check submits one synthetic event and passes only if the relay's downstream ingestion request is accepted.

Only after **both** Sthang services pass their production synthetic checks should `config/product-services.json` be changed from fail-closed defaults to:

- `khmerContribution.provisioned: true` with `https://contribute.sthang.app`;
- `productAnalytics.provisioned: true` with `https://analytics.sthang.app`.

Those are public Sthang service coordinates. Do not enable either flag based only on source code or a dashboard resource existing.

## Withdrawal contract

`POST /v1/contributors/:id/withdraw` is idempotent at the data-model level. Studio retains its local withdrawal credential specifically so a contributor can request deletion without creating a Sthang account. If the service is unavailable, Studio records deletion as pending and retries at a later startup or explicit sync.

For v0.8, corpus collection and verification are the production boundary. Any future training pipeline must retain sample provenance/split discipline and honor the published contribution/withdrawal policy; deploying or training a production model remains a separate product/governance action.
