# Privacy and data flow

Sthang Studio is designed as a local-first desktop-style workspace served from
your own computer. Caption wording currently uses Google's Gemini service;
caption timing and project editing are handled locally.

The verified public `v0.7.14` Beta does not contain Sthang product analytics or
a Khmer training-contribution service. The current **unreleased 0.8.0 source**
adds two separate, explicit opt-in paths described below. Their production
services have been provisioned and synthetic-validated for the unreleased v0.8
work, but both choices remain default-off and this is not evidence that 0.8.0 has
been released or that either choice is available in the verified public Beta.

This document describes the behavior of the application itself. It is not a
substitute for the privacy terms of third-party services you choose to use.

## What stays on your computer

The application runs its frontend and local API on loopback (`127.0.0.1`).
Projects, source media, timing data, caches, and exports persist locally on your
computer unless you explicitly export/share them or explicitly opt into the
Khmer Caption Contributor program described below:

- imported source media and normalized working audio;
- reusable selected-range PCM WAVs created from that normalized audio;
- caption projects and edits;
- correction memory and profile data;
- project history, proposals, processing-job metadata, and resumable job checkpoints;
- project-scoped KFA acoustic-emission caches and deterministic local timing-result caches;
- browser-memory waveform/spectrum data while Studio remains open;
- SRT exports;
- local timing/alignment using KFA, with faster-whisper as a local fallback.

Performance caches are derived from media already owned by the local project. They
are bounded and are kept under the project's existing cache/runtime locations so
normal project/media invalidation can remove them. Browser waveform caches are
memory-only and disappear when the browser page/process is closed.

Runtime data lives under the installation's local directories and is excluded
from Git by `.gitignore`.

## Local preparation before Generate

After new or replacement media is saved, Studio may begin local-only preparation
shortly afterward: normalizing the audio and warming the local timing runtime.
This is intended to reduce the delay after you later choose Generate or Improve.
This prewarming does **not** upload audio to Gemini or to Sthang's contribution
service. A cloud transcription request still begins only after you explicitly
request caption generation/regeneration. A contribution upload can occur only
after explicit Contributor opt-in plus a later eligible human correction and
approval.

## What is sent to Gemini

When you generate or regenerate AI caption wording, Sthang Studio sends the
normalized WAV audio needed for that operation, plus relevant topic context,
protected vocabulary, accuracy hints, and accepted or proposed wording, directly
to Google using your Gemini API key. The request includes only the details that
are relevant to the requested transcription pass.

When more than one AI listen uses the same immutable audio range, Studio may reuse
the same Gemini Files API upload instead of uploading duplicate copies of that
range. This reduces repeated transfer but does not change the category of data sent
to Google. Model/context/guidance settings are still resolved for each requested
listen, and a new user-requested Alternative/Deep Verify pass remains a new model
request rather than a cached old answer.

If an interrupted processing job is resumed, Studio may reuse a completed Gemini
candidate saved locally for that **same job ID** when its audio, context, guidance,
model settings, API-key fingerprint, vocabulary mode, and thinking configuration
still match. Fresh jobs do not inherit those AI candidate checkpoints.

Sthang Studio requests `store: false` for Gemini transcription interactions.
This opts out of the Interactions API's default state storage, but it does not
control files uploaded through the separate Gemini Files API.

Studio uploads the normalized WAV through the Gemini Files API and does not
explicitly delete that remote file after processing. Google currently documents
that Files API uploads are stored under provider control for up to 48 hours and
that Files API storage is independent of interaction zero-data-retention
controls. As a result, `store: false` does not make Studio's current Gemini flow
a zero-data-footprint workflow. See Google's
[Files API guide](https://ai.google.dev/gemini-api/docs/files) and
[zero-data-retention guidance](https://ai.google.dev/gemini-api/docs/zdr).
Google's Gemini Developer API terms, quotas, and privacy policies also apply.

Sthang Studio does not use Gemini for final local timing alignment. Timing and
project editing remain on-device after the transcript is returned.

## Khmer Caption Contributor (unreleased 0.8.0 source)

Khmer Caption Contributor is **off by default**. It is separate from product
analytics and from Gemini transcription. Importing a Studio profile never carries
Contributor consent onto another installation.

When contribution hosting is configured, Studio may offer the program after a
successful export. Joining is an explicit choice. Corrections made before joining
are not collected retroactively, and declining does not disable any caption
feature or local correction memory.

An eligible sample is created only when a caption can be traced back to generated
wording, receives a material human text correction after consent, and is later
approved. Formatting-only changes and corrections whose starting caption was
manually authored are excluded. Each eligible contribution is limited to:

- a random Contributor id that is not the product-analytics installation id;
- a deterministic sample id used for idempotency/deduplication;
- generated caption wording and final corrected wording;
- caption timing and generated timing/model/Studio-version evidence;
- a mono WAV containing the caption plus about 180 ms of surrounding audio on
  each side, bounded to 16 seconds and 1.2 MB;
- the audio SHA-256.

The client protocol does **not** contribute the full video, project title, source
filename, local filesystem path, unrelated captions, topic/context text,
correction-memory database, SRT content, Gemini API key, or product-analytics
identifier. The Sthang intake Worker also rejects those private fields if they
appear in the payload.

Eligible samples are first queued locally. Network failure never makes caption
editing, Review, saving, generation, or export fail. Studio retries queued work
after new eligible corrections and once at startup; it does not continuously
poll the contribution service.

The production contribution service is Sthang-controlled infrastructure at
`contribute.sthang.app`, using a private Cloudflare R2 bucket for WAV clips and
D1 for correction metadata. A high-entropy local withdrawal token authenticates
the pseudonymous Contributor identity; only a SHA-256 of that token is stored by
the service. The production service has passed a synthetic upload → submitted →
verified → contributor-wide withdrawal validation. That validation does not make
v0.8.0 a public release or complete the remaining privacy/release approvals.

New uploads are `submitted`, not automatically `verified`. Only a separate
corpus-quality decision may promote a sample to `verified`; Studio's verified
counter follows that status. Rejected samples have their private R2 audio removed.
Submitted samples that remain unverified expire after 180 days under the Worker
retention job. Verified source samples may be retained until the Contributor
withdraws or the program is retired.

Turning contribution off stops new candidate creation and removes unsent local
contribution candidates. **Request deletion** additionally asks Sthang to delete
contribution data already sent under that Contributor identity. The service
removes that Contributor's private R2 audio and blanks contributed caption text;
if the service is unavailable, Studio keeps a pending-withdrawal state for retry.
No Sthang account is required for that deletion request.

Contribution data is intended to evaluate, develop, and improve Khmer caption
technology, including preparing verified datasets for future model training. If
a verified sample has already influenced a trained model, deleting the stored
source sample cannot literally rewind an already-trained model; withdrawal
excludes the source sample from retained corpus data and future training/retraining.
This limitation must remain disclosed before production model training begins.

Only enable Contributor mode for media you have the right or permission to share
for this improvement purpose, including where another person's voice is present.
See `docs/KHMER-CAPTION-CONTRIBUTOR.md` for the complete source contract and
remaining release gates.

## Optional product analytics (unreleased 0.8.0 source)

Product analytics is a **separate, default-off choice**. Studio does not load a
third-party browser analytics SDK, session replay, or autocapture. When the user
explicitly enables analytics and the production service is provisioned, Studio's
local Node server creates a random analytics installation id and sends only its
small allow-listed event payload to the Sthang-controlled relay at
`analytics.sthang.app`.

The relay validates the same fixed event/property vocabulary again before
forwarding an accepted event to Sthang's configured PostHog EU project. The
processor-specific project ingestion key and endpoint are held by the relay,
not shipped in Studio's normal app configuration. The relay requests
`$process_person_profile: false` and `$geoip_disable: true` for forwarded events.
The relay is designed not to intentionally persist Studio event payloads. The
production relay has passed a synthetic relay → downstream-ingestion validation;
that does not make the unreleased v0.8 analytics choice part of the verified
public Beta.

Allow-listed events measure coarse workflow milestones such as Studio startup,
project creation, caption generation start/completion/failure, caption approval,
and SRT export. Properties are restricted to Studio/platform version and coarse
buckets such as caption count, duration, processing time, and approval count.

Analytics does **not** send caption/transcript text, audio/video, filenames,
project names, local paths, topic/vocabulary/context text, correction memory,
SRT contents, Gemini keys, Contributor ids, contribution audio, email addresses,
or names. Studio does not deliberately include the creator's IP address as an
event property. However, Cloudflare and PostHog can receive ordinary
infrastructure/HTTPS metadata associated with requests or Worker subrequests;
the relay must not be described as an IP-anonymization guarantee. PostHog's
service terms/privacy policy apply to analytics data processed by PostHog.

Analytics outages are fail-open. Turning analytics off stops new analytics
events and removes the local random analytics identity so a later opt-in starts
with a fresh id. The analytics identity is intentionally separate from Contributor
identity, and the contribution service does not receive it.

## API keys

On Windows, the preferred in-app setup stores the Gemini API key using Windows
user-protected storage (DPAPI) under `%LOCALAPPDATA%\Sthang Studio`. The browser
receives only a masked representation. An `apps/server/.env` `GEMINI_API_KEY`
remains supported as an advanced fallback and is ignored by Git.

To avoid repeatedly starting PowerShell/DPAPI for every AI pass, Studio may keep
the already-resolved key and model settings in server process memory for a short
period. The plaintext key is not written to an unencrypted cache or returned to
the browser; in-app Save/Forget actions invalidate that memory cache immediately.

Never commit, paste into issues, or publish a real API key. If a key is exposed,
revoke/rotate it with the provider immediately.

## Downloaded local models

The first local timing setup may download KFA model assets into the user's local
cache. The faster-whisper fallback downloads its selected model when needed.
Those model files are not committed to this repository and remain subject to
their upstream distribution and license terms.

The local timing worker may remain running while Studio is open so the KFA ONNX
session does not need to be loaded for every caption range. faster-whisper remains
lazy and is loaded only when the KFA fallback is actually needed.

## Local project/history storage migration

Current Studio builds may migrate the former monolithic project/history JSON
layout into per-project atomic files to reduce repeated disk I/O. Existing project
data is preserved during migration; the legacy project source/history files are
not silently discarded as part of the migration itself.

## Update checks (unreleased 0.8.0 bootstrap source)

The unreleased `0.8.0` bootstrap source contains the Studio public verification
key for the signed updater and is configured for the Sthang-controlled metadata
host `updates.sthang.app`. This source change does not mean that `0.8.0` or a
public OTA release is available: the verified public Beta remains `v0.7.14`, and
a public signed `latest.json` pointer is not promoted during source preparation.

A released build containing this provisioned public key may make one
update-metadata request per browser session/startup and additional requests only
when you choose **Check for updates**. The request uses the public update URL and
ordinary HTTPS metadata such as the source IP address and request headers. Studio
may disclose the installed version and update channel needed to compare an offer,
but it does not send projects, captions, media, exports, correction memory,
history, the Gemini API key, a license, an enrollment record, D1/device
credentials, or a Sthang analytics identifier to check for an update. The
installed version is compared locally; the public package URL reveals the chosen
public version only after you confirm a download.

Studio downloads a signed update package only after explicit confirmation and
installs it only after a second explicit confirmation. A failed or unavailable
update-service request is non-destructive and does not affect caption work on the
installed version. See `docs/OTA-UPDATES.md` for the unreleased protocol and
remaining production/release gates.

## Deleting local data

Because projects and caches are local files, removing an installation does not
necessarily remove data stored elsewhere on the same computer (for example the
Windows-protected Gemini key, random analytics identity, or Contributor withdrawal
credential under the Studio state root). Use the application's available
delete/forget/privacy actions and remove local runtime folders deliberately when
you no longer need them.

Deleting a local project removes unsent contribution candidates tied to that
project, but it does not silently revoke contribution data that was already sent.
Use **Privacy → Request deletion** for contributor-wide remote corpus deletion.

For security reporting, see `SECURITY.md`.
