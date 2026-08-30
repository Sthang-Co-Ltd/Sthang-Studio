# Sthang Studio

**Accurate Khmer captions, ready for CapCut.**

Sthang Studio is a Windows-first caption workspace for Cambodian Khmer creators.
It combines AI-assisted Khmer transcription with local timing,
fast review tools, correction memory, and CapCut-compatible SRT export.

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

## Distribution status

Sthang Studio is available as a public Beta. Windows users should download the
curated **Sthang Studio for Windows** ZIP from GitHub Releases. For this `0.7.14`
source, use the matching
[0.7.14 Beta release](https://github.com/Sthang-Co-Ltd/Sthang-Studio/releases/tag/v0.7.14).
GitHub's **Code → Download ZIP** is the source tree for developers and is
intentionally not the end-user installer.

The Windows release package keeps the first-run folder simple: **Install Sthang
Studio.bat**, **Read Me.txt**, and one **Sthang Studio Files** folder. Setup copies
the application into `%LOCALAPPDATA%\Sthang Studio\app`, so the downloaded setup
folder can be deleted after installation while projects and local app state stay
in the stable installed location.

## Current source changes (unreleased)

The current `main` source may be ahead of the verified `0.7.14` Beta release.
Unreleased source currently includes performance-oriented pipeline work such as
reusable normalized/range audio, warm local timing, transcript-independent KFA
acoustic evidence caching, exact timing-result caching, resumable same-job AI
checkpoints, concurrent Deep Verify listens, browser-memory waveform reuse, and
per-project/history persistence that avoids rewriting unrelated projects.

These optimizations are intended to reduce repeated work without changing the
caption wording authority, local timing authority, Review decisions, caption
locks, correction memory, or SRT output. They are **not** release evidence and
should not be treated as part of the verified public Beta until a matching
release is deliberately built and published.

### Signed updates in source — not publicly enabled

Current unreleased source also contains a Studio-native signed Windows updater
designed around the existing `%LOCALAPPDATA%\Sthang Studio\app` installation.
It checks at most once per browser session plus a manual **Check for updates**
action, never polls continuously, and requires separate explicit confirmation
before download and before installation.

The proposed Sthang-controlled update origin is `updates.sthang.app`. Release
metadata and immutable version packages are verified with a Studio-only Ed25519
public trust root, staged before activation, prepared with version-local Node and
Python dependencies, and health-checked after an atomic version switch. Failed
or interrupted activation rolls back to the previous healthy version. Projects,
media, captions, history, correction memory, jobs, exports, compatible caches,
the `.env` fallback, and Windows-protected Gemini key storage remain in the
stable state root.

This source architecture is **not evidence that OTA updates are publicly
available**. The committed trust-root slot is intentionally unprovisioned, no
production private signing key exists in this repository, and no Cloudflare/R2
service has been deployed by this change. The curated GitHub Release remains the
public manual download and recovery path. See
[`docs/OTA-UPDATES.md`](docs/OTA-UPDATES.md) for the protocol and future release
gates.

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
- Enough local disk space for Python/Node dependencies, media, caches, and
  downloaded timing models.

macOS/Linux contributors may run the source with compatible Node/Python/FFmpeg
setups, but the installer, desktop shortcut, and protected in-app key storage are
currently Windows-first.

## What runs locally and what uses Gemini

Sthang Studio is local-first, but it is **not fully offline** when generating AI
caption wording.

For current source builds, the local pipeline may include unreleased cache and
prewarm behavior described below. The verified `0.7.14` public release remains
defined by its matching release notes and package evidence.

**Local on your computer:**

- the Sthang Studio frontend and API (`127.0.0.1`);
- imported media, project state, history, correction memory, caches, proposals,
  jobs, and SRT exports;
- normalized audio and bounded reusable selected-range PCM audio;
- caption timing/alignment;
- a persistent local KFA timing worker while Studio is open, with cached transcript-independent acoustic evidence;
- deterministic exact-transcript timing caches and the faster-whisper timing fallback;
- resumable same-job processing checkpoints;
- decoded Fine Timing waveform/spectrum data in browser memory while the page remains open.

Studio may begin **local-only** normalization and timing-runtime preparation shortly
after new or replacement media is saved. It does not speculatively upload that
media to Gemini before you choose Generate/Improve.

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
Python timing path as a recovery route if the persistent worker transport fails.

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
- [`docs/OTA-UPDATES.md`](docs/OTA-UPDATES.md) — unreleased signed-update
  protocol, rollback model, and production gates
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — dependency/model notices
- [`TRADEMARKS.md`](TRADEMARKS.md) — Sthang name and brand-asset terms

## License and brand

The software is licensed under the [MIT License](LICENSE), except where a file
or third-party component states otherwise.

The **Sthang**, **Sthang Studio**, wordmarks, approved Studio marks, icons, and
other Sthang identity assets are not granted for unrestricted trademark use by
the MIT software license. See [`TRADEMARKS.md`](TRADEMARKS.md).

Third-party libraries, downloaded models, hosted APIs, and external tools such
as FFmpeg remain subject to their own terms. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Product relationship

Sthang Studio is a Sthang product. Captions is its current Khmer-first
workspace. CapCut is a third-party product; Google/Gemini is a third-party
service. Their names are used only to describe compatibility or configured
integrations and do not imply sponsorship or endorsement.

---

**Sthang Studio** is developed by Sthang. Product information: https://sthang.app/
