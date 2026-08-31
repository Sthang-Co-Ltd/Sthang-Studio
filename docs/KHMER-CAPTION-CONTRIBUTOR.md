# Khmer Caption Contributor

This document defines the unreleased v0.8 Sthang Studio contribution program and corpus contract.

## Product promise

Sthang Studio has two clear caption-data modes:

1. **Private** — the default. Studio does not contribute caption/audio examples to Sthang.
2. **Khmer Caption Contributor** — explicit opt-in. Eligible corrections made **after** joining may contribute a short matching audio clip and correction evidence to improve Khmer caption technology.

Declining contribution does not reduce caption quality, disable features, or remove local correction memory. Imported Studio profiles never carry contribution consent onto another installation.

The contributor invitation is progressively disclosed after a successful export when production contribution hosting is configured. It is not a first-launch gate and dismissal for the current session is not treated as consent.

## Why this exists

The goal is to build a high-quality Khmer speech/correction evidence base from real creator workflows so Sthang can:

- measure recurring Khmer transcription errors;
- compare prompts/models against mistakes real creators encountered;
- improve correction/vocabulary intelligence;
- create leak-resistant Khmer evaluation sets;
- prepare verified training data for future Khmer caption/speech systems.

A user edit is never automatically treated as training truth. A candidate must trace back to generated wording, materially change the caption, occur after consent, and be approved after the correction. Formatting-only changes and manually-authored starting captions are excluded.

## What one eligible contribution can contain

- a random contributor id unrelated to PostHog;
- a deterministic sample id for deduplication;
- the caption's start/end time;
- a short mono WAV containing the caption plus about 180 ms of local context on each side;
- the original generated caption wording;
- the final corrected wording;
- generated timing source and model/app version evidence;
- a SHA-256 of the WAV.

The client and intake Worker must not send/accept project titles, source filenames, local paths, full videos, unrelated captions, topic/context text, correction-memory databases, SRT exports, Gemini API keys, or PostHog identifiers.

## Quality lifecycle

```text
human correction
      ↓
local Correction Event lineage
      ↓
final caption approval
      ↓
eligibility filters
      ↓
local queued candidate
      ↓
short-audio extraction + hash
      ↓
private Sthang intake
      ↓
submitted
      ↓
corpus QA
   ↙       ↘
verified   rejected
```

**Submitted is not verified.** Studio's contributor counter may call a correction "verified" only after the Sthang corpus service has explicitly promoted that sample to `verified`.

Rejected samples are removed from private R2 when rejection is recorded. Submitted samples that remain unverified are intended to expire after 180 days. Verified source samples remain associated with the contributor until withdrawal or program retirement.

## Storage and identity

The production design uses a Sthang-controlled Cloudflare Worker, private R2 bucket, and D1 metadata database. The contributor id is random. A separate high-entropy local withdrawal token authenticates uploads/status/deletion; only its SHA-256 is stored by the service.

This contributor identity is intentionally unrelated to the random PostHog analytics installation id.

Local upload state is fail-open for caption work: network errors keep eligible samples queued and never make editing, Review, generation, saving, or SRT export fail. Studio retries once on startup and after new eligible contribution work; it does not continuously poll.

## Withdrawal and deletion

Turning contribution off stops future candidate creation and removes unsent local contribution candidates. **Request deletion** additionally asks Sthang to remove contribution data already sent under that contributor identity.

The Sthang intake service deletes the contributor's private R2 audio objects and blanks contributed caption text before marking stored sample rows withdrawn. If the service is unavailable, Studio keeps a local pending-withdrawal state and can retry later without requiring a Sthang account.

If verified contribution data has already influenced a trained model, deleting the stored source sample cannot literally rewind an already-trained model. Withdrawal excludes the sample from retained source data and future training/retraining. This limitation must remain disclosed before any production model is trained from the corpus.

## Rights and appropriate media

Contributor mode should be enabled only for media the user has the right or permission to contribute for improving Sthang's Khmer caption/speech technology, including where another person's voice is present.

Production terms/privacy text require owner/legal review before the corpus is enabled publicly. Source implementation, a deployed test Worker, or a merged commit is not sufficient release evidence.

## Product analytics is separate

Optional PostHog product analytics is a different consent choice. It uses a random installation id and a small server-owned event/property allow-list. It never receives caption text, audio, filenames, project names, local paths, topic/vocabulary text, SRT content, Gemini keys, or the contributor id.

Studio does not load PostHog's browser SDK, session replay, or autocapture. The local Node server sends allow-listed events only when the analytics preference is explicitly enabled and a PostHog project ingestion key is configured.

## Production gates

Before a public v0.8 release can enable contribution:

- provision `contribute.sthang.app`, private R2, D1, admin secret, WAF/rate limits, and the 180-day submitted-sample cleanup;
- test upload, idempotency, verification status, offline retry, and contributor-wide withdrawal against non-sensitive fixtures;
- configure `STHANG_CONTRIBUTION_ENDPOINT` only after the service is verified;
- approve final privacy/program terms and website/docs representation;
- synchronize approved product evidence through Sthang HQ and Distribution;
- complete the normal v0.8 Windows/release/OTA validation gates.

Before optional PostHog analytics can be publicly enabled, provision the Studio PostHog project, use the EU ingestion host unless governance decides otherwise, configure the project ingestion key, and verify the event allow-list with synthetic events.

Production provisioning, cross-repository synchronization, public release publication, OTA promotion, and model training are separately approval-gated actions.
