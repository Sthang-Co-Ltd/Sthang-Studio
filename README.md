# Sthang Studio

**Accurate Khmer captions, ready for CapCut.**

Sthang Studio is a Windows-first caption workspace for Cambodian Khmer creators.
It combines AI-assisted Khmer transcription with local timing, fast review tools,
correction memory, and CapCut-compatible SRT export.

The product is designed around one practical workflow:

```text
Upload → generate → review → export SRT
```

Advanced timing, regeneration, history, corrections, and diagnostics stay
available without crowding the main editing flow.

## Highlights

- Khmer-first transcription and text handling.
- Local caption timing with a Khmer forced aligner and local Whisper fallback.
- Sequential Review with context on first listen and tight replay while editing.
- Caption approval, text/timing locks, correction memory, and project history.
- Non-destructive Current/Proposed regeneration review.
- Precision waveform timing for difficult captions.
- UTF-8 SRT export designed for CapCut workflows.
- Local projects, history, caches, proposals, and exports.
- Windows-protected in-app storage for a Gemini API key.
- Unreleased v0.8 source adds a default-private **Khmer Caption Contributor**
  foundation and separate optional product analytics; both require explicit
  consent and production service configuration before any new data leaves Studio.

## Distribution status

Sthang Studio is available as a public Beta. Windows users should download the
curated **Sthang Studio for Windows** ZIP from GitHub Releases. The currently
verified public release remains
[0.7.14 Beta](https://github.com/Sthang-Co-Ltd/Sthang-Studio/releases/tag/v0.7.14),
even while this source tree prepares the unreleased `0.8.0` release. GitHub's
**Code → Download ZIP** is the source tree for developers and is intentionally
not the end-user installer.

The Windows release package keeps the first-run folder simple: **Install Sthang
Studio.bat**, **Read Me.txt**, and one **Sthang Studio Files** folder. Setup copies
the application into `%LOCALAPPDATA%\Sthang Studio\app`, so the downloaded setup
folder can be deleted after installation while projects and local app state stay
in the stable installed location.

## Current source changes (unreleased)

The current source version is `0.8.0`, but that version is **not a published
release yet**. The verified public Beta remains `v0.7.14` until a matching
Windows package, release evidence, clean-Windows validation, and publication are
completed deliberately.

Unreleased source includes performance-oriented pipeline work such as reusable
normalized/range audio, warm local timing, transcript-independent KFA acoustic
evidence caching, exact timing-result caching, resumable same-job AI checkpoints,
concurrent Deep Verify listens, browser-memory waveform reuse, and per-project/
history persistence that avoids rewriting unrelated projects.

It also contains the source foundation for two new privacy-controlled features:

- **Khmer Caption Contributor** — private by default. After explicit opt-in,
  eligible corrections made after joining can queue a bounded short WAV plus the
  generated/corrected wording and timing evidence for a separately governed
  Sthang corpus service. Submitted samples are not called verified until corpus
  QA promotes them.
- **Optional product analytics** — separate explicit consent. Studio sends only
  a fixed allow-list of coarse workflow events/properties to the Sthang-owned
  `analytics.sthang.app` relay. The relay validates that narrow schema again and
  forwards accepted events to Sthang's configured PostHog EU processor. Studio
  contains no browser analytics SDK, replay, or autocapture, and its normal app
  configuration contains no processor endpoint or project ingestion key.

Both new cloud paths fail closed when their production configuration is absent.
The current source therefore does **not** establish that contribution hosting or
product analytics is publicly enabled.

### Signed updates in source — bootstrap trust prepared, OTA not public

The unreleased `0.8.0` source contains a Studio-native signed Windows updater
designed around the existing `%LOCALAPPDATA%\Sthang Studio\app` installation.
It checks at most once per browser session plus a manual **Check for updates**
action, never polls continuously, and requires separate explicit confirmation
before download and before installation.

The planned public update origin is `updates.sthang.app`. Release metadata and
immutable version packages are verified with a Studio-only Ed25519 public trust
root, staged before activation, prepared with version-local Node and Python
dependencies, and health-checked after an atomic version switch. Failed or
interrupted activation rolls back to the previous healthy version. Projects,
media, captions, history, correction memory, jobs, exports, compatible caches,
the `.env` fallback, and Windows-protected Gemini key storage remain in the
stable state root.

The production private signing key remains outside the repository behind the
separately deployed signing service. Signing infrastructure and private R2
staging exist, but **no v0.8.0 release has been published and no public
`latest.json` pointer has been promoted**. This source architecture is **not
evidence that OTA updates are publicly available**. The curated GitHub Release
remains the public manual download and recovery path. See
[`docs/OTA-UPDATES.md`](docs/OTA-UPDATES.md) for the protocol and remaining
release gates.

### Khmer Caption Contributor source contract

The Contributor program has exactly two caption-data states: **Private** and an
explicit **Khmer Caption Contributor** opt-in. Importing a Studio profile never
copies consent to another installation. Corrections made before joining are not
harvested later.

Eligible examples must trace back to generated wording, contain a material human
text correction after consent, and become approved. Formatting-only changes and
manually-authored starting captions are excluded. The client extracts only a
short mono WAV around that caption and does not send the full video, project
name, filename, local path, topic/context text, unrelated captions, correction
memory, SRT contents, Gemini key, or product-analytics id.

The planned Sthang intake is a Cloudflare Worker backed by **private R2 + D1**.
The source includes idempotent sample ids, a pseudonymous contributor credential
stored server-side only as a hash, offline retry, separate submitted/verified
states, contributor-wide withdrawal, rejection cleanup, and a 180-day limit for
samples that remain submitted but unverified. Production deployment at
`contribute.sthang.app` remains separately approval-gated.

See [`docs/KHMER-CAPTION-CONTRIBUTOR.md`](docs/KHMER-CAPTION-CONTRIBUTOR.md) and
[`PRIVACY.md`](PRIVACY.md) for the complete contract, including future model
training and withdrawal limitations.

## Contributor development setup

The following setup is for contributors building from source. It is development
guidance, not the end-user download or release path.

### Install from source on Windows

1. Clone or otherwise check out this repository into a stable folder. Do not run
   it directly from a temporary ZIP-preview location.
2. Double-click `INSTALL-NEW-PC.bat`.
3. The installer checks/installs Node.js LTS, Python 3.12, FFmpeg, and the
   Microsoft Visual C++ runtime needed by local timing. WinGet is preferred when
   available; clean x64 Windows machines can use the reviewed direct per-user
   fallback instead.
4. Launch **Sthang Studio** from the desktop shortcut or run `run-windows.bat`.
   After the local services are healthy, Studio opens in the registered default
   Windows browser. Chrome is not required; Microsoft Edge-only Windows
   environments are supported. If a browser cannot be opened automatically, the
   launcher prints the local Studio address so it can be opened manually.
5. Open **Settings → AI connection** and add your own Gemini API key.
6. Upload media, generate captions, review the uncertain parts, and export SRT.

The first local timing setup can download a Khmer alignment model (roughly a few
hundred MB). The local Whisper fallback downloads its selected model only if it
is needed.

### Requirements

- Windows 10/11 x64.
- WinGet recommended but not required for the one-click installer.
- Internet access for initial dependency/model setup and Gemini transcription.
- A Gemini Developer API key for AI caption wording.
- Enough local disk space for local timing resources and your media.

macOS/Linux contributors may run the source with compatible Node/Python/FFmpeg
setups, but the installer, desktop shortcut, and protected in-app key storage are
currently Windows-first.

## Local and cloud data flow

Sthang Studio is local-first, but it is **not fully offline** when generating AI
caption wording.

For current source builds, the local pipeline may include unreleased cache and
prewarm behavior described below. The verified `0.7.14` public release remains
defined by its matching release notes and package evidence.

**Local on your computer by default:**

- the Sthang Studio frontend and API (`127.0.0.1`);
- imported media, project state, history, correction memory, caches, proposals,
  jobs, and SRT exports;
- normalized audio and bounded reusable selected-range PCM audio;
- caption timing/alignment;
- a persistent local KFA timing worker while Studio is open, with cached transcript-independent acoustic evidence;
- deterministic exact-transcript timing caches and the faster-whisper timing fallback;
- resumable same-job processing checkpoints;
- decoded Fine Timing waveform/spectrum data in browser memory while the page remains open;
- default-off analytics preferences/identity state and the default-off Contributor
  queue/withdrawal credential.

Studio may begin **local-only** normalization and timing-runtime preparation shortly
after new or replacement media is saved. It does not speculatively upload that
media to Gemini or Sthang before the corresponding user action/consent.

**Sent to Gemini when you generate/regenerate AI wording:**

- the normalized WAV audio needed for the transcription operation;
- relevant topic context, protected vocabulary, accuracy hints, and accepted or
  proposed wording when those are part of the requested pass.

Repeated listens over the same immutable audio range may reuse one short-lived
Gemini Files API upload instead of uploading duplicate copies. A fresh
Alternative/Deep Verify request is still a fresh model listen; only resuming the
same persisted job may reuse a completed AI candidate when its full signature
still matches.

Sthang Studio requests `store: false` for Gemini transcription interactions,
which opts out of the Interactions API's default state storage. The normalized
WAV is uploaded separately through the Gemini Files API. Studio does not
explicitly delete that remote file after processing. Google currently documents
that Files API uploads are stored for up to 48 hours and that Files API storage
is independent of interaction storage controls. See Google's
[Files API guide](https://ai.google.dev/gemini-api/docs/files),
[zero-data-retention guidance](https://ai.google.dev/gemini-api/docs/zdr), and
[`PRIVACY.md`](PRIVACY.md) for the full data-flow summary.

**Only after separate explicit v0.8 opt-ins and production configuration:**

- Khmer Caption Contributor may send the bounded correction sample described
  above to Sthang's private corpus service;
- optional product analytics may send coarse allow-listed workflow events to
  `analytics.sthang.app`, where the Sthang relay validates them before forwarding
  accepted events to the disclosed EU analytics processor.

Those two identities and data flows are intentionally separate.

## API-key handling

On Windows, the recommended **Settings → AI connection** flow stores the Gemini
key using Windows user-protected storage under `%LOCALAPPDATA%\Sthang Studio`.
The browser receives only a masked key. An `apps/server/.env` key remains
supported as an advanced fallback and is excluded from Git.

Current source builds may keep the already-decrypted key/model settings in
process memory briefly to avoid starting PowerShell/DPAPI for every AI pass.
Save/Forget actions invalidate that memory immediately; the plaintext key is
never written to an unencrypted cache.

Never commit or publish a real API key.

## Performance architecture

Current unreleased source optimizes repeated caption work around a simple rule:
**reuse deterministic prerequisites, never reuse a fresh AI opinion as though it
were new.**

Examples of safe reuse include normalized/range audio, KFA acoustic emissions,
exact transcript+timing results, decoded waveform data, and completed stages of
the same resumable job. New Alternative/Deep Verify jobs still ask Gemini again.
The local timing daemon is an optimization only; Studio retains its one-shot
Python worker/CLI recovery path for setup, diagnostics, and daemon-transport failure.

Projects and history are stored in atomic per-project files so an autosave no
longer rewrites every project or dozens of full history snapshots. Existing
legacy project/history JSON is preserved while the new representation is
migrated.

## Development

Read [`AGENTS.md`](AGENTS.md) before changing the application. Product and UX
behavior are also documented in [`PRODUCT.md`](PRODUCT.md),
[`DESIGN.md`](DESIGN.md), and [`UX-AUDIT.md`](UX-AUDIT.md).

Typical setup:

```text
npm ci --include=dev
npm run test:public
npm run test:contribution
npm run check:public
npm run test:updater
npm run typecheck
npm run build
npm run dev
```

The explicit `--include=dev` flag keeps the locked build and typecheck toolchain
available even when the local npm configuration would otherwise omit it.

The public-readiness guard requires a complete clone with relevant refs fetched;
it does not fetch them itself. It checks current and historical forbidden paths
and common secret patterns in text. The regression tests use disposable Git
repositories. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for scope limits and commit
email privacy.

For the full Windows local-timing environment:

```text
setup-local-timing-windows.bat
```

The Python worker can be syntax-checked without downloading models:

```text
python -m py_compile local-timing/worker.py
```

### Build the curated Windows release ZIP

On a clean Windows checkout, run:

```text
npm run package:windows
```

The packager reruns public-readiness, typecheck, and production build checks,
requires a clean tracked working tree, packages only the runtime/public-install
payload, and writes the ZIP plus SHA-256 file to ignored `release-artifacts/`.
The resulting archive is the candidate GitHub Release asset; the repository
source ZIP is not.

A v0.8 source branch that still truthfully says `v0.7.14` is the verified public
Beta is **not yet a publishable v0.8 package**. Final release documentation must
be switched to matching v0.8 public evidence only after its clean-Windows,
privacy/service, and publication gates are ready; do not weaken that packager
block merely to produce an artifact.

On Windows, `npm run package:ota` creates an **unsigned, local-only** OTA
candidate and protocol metadata under ignored `release-artifacts/`. It does not
sign, upload, publish, deploy, or advance `latest.json`. See
[`docs/OTA-UPDATES.md`](docs/OTA-UPDATES.md) before using the separate release
verification tooling.

Pull requests are expected to pass the repository CI on both Windows and Linux.
The build/typecheck flow also verifies the owner-approved Studio brand assets
byte-for-byte.

## Repository workflow

`main` is the latest accepted Sthang Studio baseline. Development uses focused,
short-lived branches and pull requests. Please avoid committing directly to
`main` for normal feature work.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution expectations and
[`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## Documentation

- [`PRODUCT.md`](PRODUCT.md) — product purpose and priorities
- [`DESIGN.md`](DESIGN.md) — interface and interaction rules
- [`BRAND.md`](BRAND.md) — approved Sthang Studio identity system
- [`CHANGELOG.md`](CHANGELOG.md) — version history
- [`UX-AUDIT.md`](UX-AUDIT.md): historical UX findings and validation targets
- [`PRIVACY.md`](PRIVACY.md) — local/cloud data flow and key handling
- [`docs/KHMER-CAPTION-CONTRIBUTOR.md`](docs/KHMER-CAPTION-CONTRIBUTOR.md) — v0.8 contributor/corpus privacy and quality contract
- [`infra/contribution-worker/README.md`](infra/contribution-worker/README.md) — Sthang corpus-service provisioning and synthetic validation
- [`infra/analytics-worker/README.md`](infra/analytics-worker/README.md) — Sthang analytics-relay boundary and provisioning
- [`docs/OTA-UPDATES.md`](docs/OTA-UPDATES.md) — unreleased signed-update protocol, rollback model, and production gates
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — dependency/model notices
- [`TRADEMARKS.md`](TRADEMARKS.md) — Sthang name and brand-asset terms

## License and brand

The software is licensed under the [MIT License](LICENSE), except where a file
or third-party component states otherwise.

The **Sthang**, **Sthang Studio**, wordmarks, approved Studio marks, icons, and
other Sthang identity assets are not granted for unrestricted trademark use by
the MIT software license. See [`TRADEMARKS.md`](TRADEMARKS.md).

Third-party libraries, downloaded models, hosted APIs, and external tools such as
FFmpeg remain subject to their own terms. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Product relationship

Sthang Studio is a Sthang product. Captions is its current Khmer-first
workspace. CapCut is a third-party product; Google/Gemini and PostHog are
third-party services. Their names are used only to describe compatibility or
configured integrations and do not imply sponsorship or endorsement.

---

**Sthang Studio** is developed by Sthang. Product information: https://sthang.app/
