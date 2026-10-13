# Gemini availability and fallback recovery

Change ID: `studio-gemini-fallback-20261013`

Status: development source; this document does not establish a new public build,
release, update offer, or completed real-media acceptance.

## Provider change and symptoms

Google's October 8, 2026 release notes say that `gemini-3.7-flash` is deprecated
and its API requests now route to `gemini-3.8-flash`. The endpoint remains online,
but a 3.8 primary followed by a 3.7 fallback now retries the same effective model.
The separate deprecated alias is `gemini-3.5-flash`, which routes to 3.6 Flash.
Google lists no shutdown date for 3.6 or 3.8 Flash as checked on October 13, 2026.

Sources:

- [Google Gemini release notes, October 8, 2026](https://ai.google.dev/gemini-api/docs/changelog)
- [Google Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
- [Google API errors](https://ai.google.dev/gemini-api/docs/api-errors)
- [Google retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting)

HTTP 503 indicates temporary service unavailability. It can occur without recent
use of the key. HTTP 429 indicates rate limiting; these statuses do not establish
the same cause. A fallback can fail too, so changing models is not a guarantee of
provider capacity or project quota.

**Test only** in AI connection checks the key and model metadata. A successful
lookup does not prove that a transcription request will succeed. Its result now
states that distinction, and a configured key is no longer labeled as proof of
live generation readiness.

## Current source behavior

The recommended chain is **3.8 Flash primary, 3.6 Flash fallback**, using the
existing Gemini key, full Accuracy/topic prompt, Files API upload, and
`store: false` Interactions request.

The source resolves Google's documented aliases before model execution and avoids
running a fallback that resolves to the primary. Existing historical default
selections are migrated when settings are resolved, including the old default
pair in `apps/server/.env`. Blank fallback remains disabled. Other custom model
selections are retained, subject to documented alias resolution and duplicate
removal. The migration does not rewrite existing environment files, keys, projects,
or captions.

Transient request retries remain bounded and respect supported provider backoff.
A 30-second `Retry-After` still receives that delay when it fits the configured
retry maximum. A requested delay beyond that maximum stops the current model;
Studio does not shorten the provider's delay and retry it early.
After the configured chain is exhausted, the job fails with a recovery message
and remains available in **Activity → Resume**. No transcription-only rescue is
enabled by this correction. Existing experimental opt-in remains separate.

The job queue does not automatically restart a failed job. A second complete
primary/fallback sequence can come from a new action or explicit Resume. Deep
Verify deliberately makes independent listens and has a larger total request
count. The console's KFA acoustic-emission cache hit is local prerequisite reuse;
it is not evidence that a failed Gemini answer was cached or that the queue
automatically restarted.

## Recovery for the published 0.85.6 build

Open **Settings → AI connection** and use:

```text
Primary model:  gemini-3.8-flash
Fallback model: gemini-3.6-flash
```

Save the settings, then use **Activity → Resume** when ready to retry the failed
operation. A successful model lookup is not a live generation test. If Google
continues returning 503 or 429, further Studio changes alone cannot establish
that capacity or quota has recovered.

For source users who configure only through `apps/server/.env`, these are the
corresponding variables:

```text
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-3.6-flash
```

Restart a source server after manually editing its environment. Saved in-app
model settings take precedence over environment defaults.

## Validation scope

Offline regressions cover legacy model selection, alias equivalence, blank and
custom fallbacks, transient exhaustion, permanent request failures, and actual
SDK transport request counts with a synthetic response. Required source checks
include `npm run test:gemini`, `npm run verify:brand`, `npm run verify:manifest`,
`npm run typecheck`, and `npm run build`.

On October 13, 2026, all 37 Gemini regressions passed, including the real SDK's
offline transport checks. Full source typecheck, production build, brand and
product-manifest verification passed. Tests/typecheck/build used the repository's
checksum-verified Node 24.21.0 runtime in an ignored local work directory. The
host PATH Node 24.13.0 failed the existing bootstrap prerequisite; the guard was
preserved and no global Node installation was changed.

The public-readiness check also passed for the current tree and locally available
Git references/history. Two independent read-only reviews of the final source
reported no implementation blocker. These checks did not publish a release.

Bounded live checks used static diagnostic text, with no project audio or user
prompt. Model metadata lookups succeeded for 3.8, 3.7 and 3.6, while an Interactions
request returned HTTP 503 for 3.8 and HTTP 429 for 3.6. A separate 3.8
GenerateContent request also returned HTTP 503/UNAVAILABLE. These observations
apply to the tested local key and time only; they do not establish a global outage
or the quota/access state of a different installation.

Passing those checks does not establish live provider availability, transcription
quality on a real Khmer clip, or a published application update. A diagnostic
against a different computer or saved key cannot certify the key used in a pasted
console log. Do not copy keys, raw provider responses, source media, or user
prompts into issues or public diagnostic evidence.

## Public impact and maintainer handoff

**Public impact: required** for model-selection and troubleshooting guidance.
Product-owned evidence is `README.md`, `.env.example`, this document,
`apps/server/src/config.ts`, `apps/server/src/services/llm-settings.ts`,
`apps/server/src/services/gemini-model-policy.ts`,
`apps/server/src/services/gemini.ts`, and the AI settings interface.

`.sthang/product-manifest.json` was compared against this change. Its existing
Google provider, user-action triggers, data categories, key ownership, Files API
retention, and `interactionStore: false` disclosures remain applicable. The
current public version and download evidence remain 0.85.6; this source fix must
not replace that release evidence or be described as shipped automatically.

The connected Distribution guide `docs/studio/index.md` describes the old
3.8/3.7 chain at its Highlights and Gemini wording sections. Its
`https://docs.sthang.app/studio/` guidance needs a dated provider-change/recovery
note while preserving the historical 0.85.6 behavior. The `/studio/` landing source
`landing/studio/index.html` also advertises the old pair in its wording summary
and processing details; those sections need the same dated recovery guidance.
No Distribution files were changed by this task.

HQ intake and any additional public-surface changes remain pending: an authorized
HQ checkout and its Phase 3 intake instructions are not available in this task's
approved roots. The remaining HQ synchronization impact is uncertain until that
evidence is reviewed. Use the change ID above for a new intake proposal, inspect
`proposal.publicClaims` and any model-specific guidance, then follow the
Distribution README's Phase 2 workflow if approved portfolio fields need to
change. No change to `proposal.dataProcessing`, release/download fields, privacy,
brand assets, or visibility is proposed by this fix. Obtain the applicable exact
plan digest and approval class before synchronization and separate authorization
before website edits, publication, or deployment.
