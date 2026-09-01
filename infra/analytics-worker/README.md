# Sthang Studio product analytics relay

This **unreleased** Cloudflare Worker keeps Studio's optional product-analytics implementation behind a Sthang-owned origin. Normal Studio UI/runtime/configuration knows only `analytics.sthang.app`; the third-party processor is disclosed in formal privacy/governance documentation, not product copy.

## Boundary

Studio sends only:

- a random installation-scoped UUID created after explicit analytics opt-in;
- one of seven fixed workflow event names;
- allow-listed coarse properties such as Studio/platform version and duration/count buckets.

The relay rejects unknown event names, unknown/nested properties, content-like property names, oversized requests, and malformed installation ids. It does not accept caption/transcript text, media, filenames, project names, local paths, context/vocabulary, Gemini keys, Contributor ids, names, or email addresses.

The relay is stateless at the application layer: it does not intentionally persist Studio event payloads. It forwards accepted events to the approved EU analytics processor with person-profile processing and GeoIP enrichment disabled. Cloudflare and the downstream processor still receive ordinary infrastructure/HTTPS metadata under their respective service behavior and policies.

## Production provisioning

Use an authenticated Cloudflare operator environment. Copy `wrangler.template.jsonc` to the ignored `wrangler.local.jsonc`, then set the project ingestion key through Worker secret storage and deploy:

```text
cd infra/analytics-worker
npx wrangler@latest login
npx wrangler@latest secret put ANALYTICS_PROJECT_KEY --config ./wrangler.local.jsonc
npx wrangler@latest deploy --config ./wrangler.local.jsonc
curl https://analytics.sthang.app/health
```

The Worker is the origin for `analytics.sthang.app`, so it uses a Custom Domain and disables `workers.dev`. Apply Cloudflare rate limiting/WAF rules to the public hostname. Do not commit the project key, Cloudflare credentials, local Wrangler configuration, or account identifiers.

## Synthetic validation

After the relay is deployed and its secret is configured, run from the repository root:

```text
STHANG_ANALYTICS_ENDPOINT=https://analytics.sthang.app \
node scripts/verify-product-analytics-ingestion.mjs
```

The smoke check sends one synthetic personless workflow event through the Sthang relay. The relay returns success only when the downstream ingestion request is accepted. Only after this passes should `config/product-services.json` set product analytics to `provisioned: true` with `https://analytics.sthang.app`.

No analytics deployment, project creation, or public enablement is evidence that Studio v0.8 has been released. Release/publication remains separately gated.
