# Sthang Studio

**Accurate Khmer captions, styled and finished or ready for CapCut.**

Sthang Studio is a desktop caption workspace for Cambodian Khmer creators on
Windows and Apple Silicon macOS.
It combines AI-assisted Khmer transcription with local timing, fast review tools,
visual caption styling, correction memory, and both CapCut-compatible SRT and
burned-in captioned video export.

The product is designed around one practical workflow:

```text
Upload → generate → review flagged captions → export
                                 ↘ Appearance (optional) ↗
                                           ↳ SRT
                                           ↳ Captioned video
```

Advanced timing, regeneration, history, corrections, and diagnostics stay
available without crowding the main editing flow.

## Highlights

- Khmer-first transcription and text handling.
- Local caption timing with a Khmer forced aligner and local Whisper fallback.
- Sequential Review with context on first listen and tight replay while editing.
- Caption approval, text/timing locks, correction memory, and project history.
- Native caption appearance styling with layout-locked preview matching final video export.
- Non-destructive Current/Proposed regeneration review.
- Precision waveform timing for difficult captions.
- Dual export paths: portable UTF-8 SRT for video editors, and local MP4 rendering with baked-in captions.
- Local projects, history, caches, proposals, and exports.
- OS-protected in-app Gemini key storage on Windows and macOS Keychain storage on Apple Silicon Macs.
- The default-private **Khmer Caption Contributor** program and
  separate optional product analytics; both require explicit consent before the
  corresponding Sthang cloud data flow is enabled.

## Development changes — unreleased

The source Fine Timing workspace now focuses on one caption at a time, keeps
playback visible, and provides precise start/end entry, bounded nudges, whole-cue
movement, edge auditions, optional looping, and timing undo/redo. Neighbor
protection prevents accidental overlaps; an explicit shared-edge option adjusts
the transition between two captions without shifting later speech.

**Word timing** lets creators adjust one word inside a caption. **Sync words**
aligns the current corrected wording locally and offers a candidate to review
before applying. Changed or ambiguous words remain reviewable rather than
receiving invented timings. **Appearance → Spoken word highlight** optionally
colors the current spoken word while keeping the entire caption visible. Captions
with unresolved word timing stay plain. The effect is included in native preview
and captioned MP4; SRT remains plain caption text and cue timing. See the
[Fine Timing guide](docs/FINE-TIMING.md) for controls, shortcuts, and limits.
These source changes do not establish availability in the released downloads below.

Deep Verify also starts its first local timing pass while the second independent
listen is still running. This removes an avoidable ordering dependency; it does
not change either listen or imply a measured end-to-end speedup on real media.

## Distribution status

Sthang Studio `0.85.4` is the current emergency Public Beta recovery identity for
**Windows 10/11 x64** and **Apple Silicon macOS 12.3+**. The matching
[0.85.4 Beta release](https://github.com/Sthang-Co-Ltd/Sthang-Studio/releases/tag/v0.85.4)
becomes the governed recovery-download location only after publication and byte
verification complete for this release.
GitHub's **Code → Download ZIP** is the source tree for developers and is
intentionally not the end-user installer.

The Windows release package keeps the first-run folder simple: **Install Sthang
Studio.bat**, **Read Me.txt**, and one **Sthang Studio Files** folder. Setup copies
the application into `%LOCALAPPDATA%\Sthang Studio\app`, so the downloaded setup
folder can be deleted after installation while projects and local app state stay
in the stable installed location.

The Apple Silicon macOS package uses the same simple three-item handoff:
**Install Sthang Studio.command**, **Read Me.txt**, and one **Sthang Studio Files**
folder. Double-clicking the installer places Studio at
`~/Library/Application Support/Sthang Studio/app`, prepares the reviewed local
dependencies, and creates `~/Applications/Sthang Studio.command` for later
launches. The downloaded setup folder can then be deleted. This Beta uses a
command-based installer rather than a signed/notarized `.app`; if Gatekeeper
blocks the downloaded command on first open, Control-click it and choose **Open**.

## Version 0.85.4

Version `0.85.4` is the emergency Windows signed-OTA recovery for the broken
`0.85.2` public offer. The immutable `0.85.2` release remains historical evidence:
unchanged `0.8.0` clients fail safely while preparing it because the runtime payload
intentionally excludes repository-only tests while the old broker still required
`tests/tsconfig.json`. Version `0.85.3` was production-signed as immutable evidence
but deliberately never promoted after the same unchanged-v0.8 broker path remained
unable to prepare it.

`0.85.4` supports that unchanged v0.8 broker through a narrowly bounded legacy
preparation bridge that applies only inside its verified `updates/work/.../source`
runtime context with the exact broker markers and repository tests absent. Current
OTA preparation and curated/manual Windows setup explicitly request runtime-only
TypeScript validation. Runtime validation still checks shared, server, and web
code before the production build, while normal source `npm run typecheck` still
includes `tests/tsconfig.json`.

Signed staging, verification, fail-closed preparation, transactional activation,
health checks, rollback, and stable user-state preservation remain in force.
Windows installs can be offered `0.85.4` only after its exact release evidence is
verified and the signed production `latest.json` pointer is deliberately promoted.
Studio still requires **Download & verify** and then **Install & restart**; it never
silently downloads or installs an update. Curated GitHub recovery packages remain
the recovery path for Windows and Apple Silicon macOS 12.3+. macOS remains a
manual-download path and does not implement the Windows updater. Product and
privacy behavior otherwise remains the accepted 0.85.x behavior.

## Version 0.85.0

Version `0.85.0` brings the accepted work since `0.8.0` into one public release:
project caption appearance editing against the real video, local captioned-MP4
export, native Khmer-safe preview/export layout, compatible local Khmer font
discovery plus **Add font…**, smoother live appearance controls, broader local
performance reuse, playback/grouping fixes, and the first curated Apple Silicon
macOS download. Windows and macOS share the same caption workflow and local-first
data boundary.

The release also carries forward performance-oriented pipeline work such as
reusable normalized/range audio, warm local timing, transcript-independent KFA
acoustic evidence caching, exact timing-result caching, resumable same-job AI
checkpoints, browser-memory waveform reuse, and per-project/history persistence
that avoids rewriting unrelated projects.

It also includes two new privacy-controlled features:

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

Both Sthang cloud paths remain default-off and fail open for caption work if a
service is unavailable. Their production endpoints are provisioned; no caption
or analytics data is sent through them until the corresponding explicit opt-in.

### Signed updates — Windows public OTA

The Windows build contains a Studio-native signed updater designed around
the existing `%LOCALAPPDATA%\Sthang Studio\app` installation. It checks at most
once per browser session plus a manual **Check for updates** action, never polls
continuously, and requires separate explicit confirmation before download and
before installation.

The public update origin is `updates.sthang.app`. Release metadata and
immutable version packages are verified with a Studio-only Ed25519 public trust
root, staged before activation, prepared with version-local Node and Python
dependencies, and health-checked after an atomic version switch. Failed or
interrupted activation rolls back to the previous healthy version. Projects,
media, captions, history, correction memory, jobs, exports, compatible caches,
the `.env` fallback, and Windows-protected Gemini key storage remain in the
stable state root.

The production private signing key remains outside the repository behind the
separately deployed signing service. Version 0.8.0 established the updater-capable
bootstrap. Version 0.85.2 became the first promoted public signed Windows offer,
but its runtime preparation fails safely before activation as described above.
Version 0.85.3 was signed as immutable evidence but deliberately never promoted.
Version 0.85.4 is the emergency recovery candidate and becomes visible to installed
clients only after its own signed and verified `latest.json` is deliberately
promoted.
The curated GitHub Release remains the manual download and recovery path. See
[`docs/OTA-UPDATES.md`](docs/OTA-UPDATES.md) for the protocol, confirmation flow,
and rollback guarantees.

### Khmer Caption Contributor contract

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

The Sthang intake is a Cloudflare Worker backed by **private R2 + D1**. The
service uses idempotent sample ids, a pseudonymous contributor credential stored
server-side only as a hash, offline retry, separate submitted/verified states,
contributor-wide withdrawal, rejection cleanup, and a 180-day limit for samples
that remain submitted but unverified. The production endpoint is
`contribute.sthang.app`; participation remains explicit opt-in.

See [`docs/KHMER-CAPTION-CONTRIBUTOR.md`](docs/KHMER-CAPTION-CONTRIBUTOR.md) and
[`PRIVACY.md`](PRIVACY.md) for the complete contract, including future model
training and withdrawal limitations.

## Caption appearance and captioned video export

Sthang Studio provides two distinct export workflows:

- **SRT export** — standard portable subtitle text and timing designed for editors like CapCut. SRT carries caption wording and timecodes; visual styling is controlled inside the destination editing application.
- **Captioned video export** — local MP4 render baking the saved project caption appearance directly into the picture. The source media is never overwritten.

### Native preview and export contract

- **Settled native layout parity**: Studio's native caption preview is powered directly by local FFmpeg and libass (`shaping=complex`), generating transparent RGBA PNG frames rather than approximating text layout through browser CSS. Settled native preview and export share the same caption layout and rasterization contract before video encoding; lossy encoding and display scaling may soften pixel edges without changing the intended typography, line layout, alignment, position, or effects. Temporary interactive feedback is described separately below.
- **Local rendering operations**: Studio does not upload rendered video frames or the resulting captioned MP4 as part of that rendering process. Caption generation/regeneration has a separate data flow involving normalized audio and related context, as described in the Gemini and Contributor sections.
- **Interactive appearance**: Size and Position can respond immediately by transforming the last matching native caption image while the newest native layout renders. The temporary result is labeled as refining and may differ in wrapping or effects; only the decoded native replacement is the exact layout reference. Other controls retain native pixels without browser re-typesetting. Requests prioritize the visible caption/overlap and coalesce intermediate edits instead of queuing them. Bounded local FFmpeg processes remain warm between requests, with the existing one-shot native renderer as fallback. See [`docs/SMOOTH-CAPTION-PREVIEW.md`](docs/SMOOTH-CAPTION-PREVIEW.md) for the architecture and local validation.
- **Runtime prerequisites**: Captioned-video export and native preview require an FFmpeg build with the native ASS/libass capabilities Studio checks locally (including complex shaping). Studio also detects whether the runtime exposes the alpha-mode metadata used by its preferred preview compositing path and selects the compatible rendering path automatically. If required complex shaping is unavailable, video export is safely blocked with actionable guidance rather than outputting distorted Khmer script. Validated against the exact local builds recorded in the release evidence.
- **Typography and fonts**: Khmer text requires complex shaping. Studio discovers compatible Khmer families already installed on Windows, macOS, or Linux by checking the local font files for Khmer coverage and shaping support. Appearance also provides **Add font…** for creator-selected `.ttf`/`.otf` files; those copies stay in Studio's local state, are not installed into the operating system, and can be removed from **Manage added fonts** without touching system fonts. Studio does not bundle or redistribute a font catalog for this feature. Large local libraries expose clickable matches immediately while the creator types. If the selected family has no Bold face, Studio switches only Weight to Regular, explains the fallback, and leaves the remaining appearance settings unchanged.
- **Temporary working files and cleanup**: Preview and render scratch files in `exports/.working` are temporary, and Studio attempts to remove them when the operation completes, fails, or is cancelled. Abnormal process termination or filesystem errors can leave temporary local working files until later cleanup or manual removal.

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

### Install from source on Apple Silicon macOS

The source path targets the same **macOS 12.3 Monterey or newer** native Apple
Silicon (`arm64`) boundary as the curated Beta package. Intel Mac support and a
macOS implementation of the Windows signed OTA updater are not provided.

1. Clone or check out this repository into a stable folder.
2. Install native **Node.js 22.12+ within the 22.x LTS line**, Python 3.12, and
   FFmpeg/ffprobe with libass complex shaping. Node 24+ is also accepted on
   macOS 13.5 or newer; macOS 12.3 through 13.4 must use Node 22. Use current
   security patches within the chosen runtime line. Run `bash ./INSTALL-MACOS.sh`.
   Existing compatible dependencies take priority. Automatic Homebrew installation
   is only attempted on macOS 15+ with Homebrew already installed; it is not a
   prerequisite on older macOS. See the [legacy/manual setup guide](docs/MACOS-COMPATIBILITY.md).
3. Start Studio with `bash ./run-macos.sh`. After both local services are
   healthy, Studio opens in the registered default macOS browser. Use Safari 17+
   or a maintained browser version compatible with your OS, not Monterey's
   original Safari 15.
4. Open **Settings → AI connection** and add your Gemini API key. macOS builds
   store it in the macOS Keychain; the browser receives only a masked value.
5. Upload media, generate captions, review, and export as on Windows.

macOS runtime state is kept under `~/Library/Application Support/Sthang Studio`
by the macOS launcher, while the Python environment and source dependencies stay
inside the checkout. Run `bash ./INSTALL-MACOS.sh` again to repair local source
dependencies after changing the checkout.

Monterey and Ventura use a dedicated native-dependency compatibility profile so Whisper
cannot upgrade its ONNX/PyAV runtime to a newer-macOS-only build. macOS 14+ and
Windows retain their separate dependency paths. No chip-name allow-list blocks
later Apple Silicon generations, but each Mac must run a macOS version supported
by that hardware; this does not make new Macs capable of booting Monterey.

### Windows public-release requirements

- Windows 10/11 x64.
- WinGet recommended but not required for the one-click installer.
- Internet access for initial dependency/model setup and Gemini transcription.
- A Gemini Developer API key for AI caption wording.
- Enough local disk space for local timing resources and your media.

Linux contributors may run the source with compatible Node/Python/FFmpeg setups.
Curated public packages are available for Windows x64 and Apple Silicon macOS;
the signed OTA updater remains Windows-only.

## Local and cloud data flow

Sthang Studio is local-first, but it is **not fully offline** when generating AI
caption wording.

Version 0.85.0 includes the cache, prewarm, resumable-job, Contributor, and
optional analytics behavior described below.

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

**Only after separate explicit opt-ins:**

- Khmer Caption Contributor may send the bounded correction sample described
  above to Sthang's private corpus service;
- optional product analytics may send coarse allow-listed workflow events to
  `analytics.sthang.app`, where the Sthang relay validates them before forwarding
  accepted events to the disclosed EU analytics processor.

Those two identities and data flows are intentionally separate.

## API-key handling

On Windows, the recommended **Settings → AI connection** flow stores the Gemini
key using Windows user-protected storage under `%LOCALAPPDATA%\Sthang Studio`.
On Apple Silicon macOS installs and source builds, the same flow stores the key in the macOS
Keychain and keeps settings metadata under `~/Library/Application Support/Sthang Studio`.
The browser receives only a masked key. An `apps/server/.env` key remains
supported as an advanced fallback and is excluded from Git.

Current builds may keep the already-decrypted key/model settings in
process memory briefly to avoid reopening the operating-system credential store
for every AI pass.
Save/Forget actions invalidate that memory immediately; the plaintext key is
never written to an unencrypted cache.

Never commit or publish a real API key.

## Performance architecture

Version 0.85.0 optimizes repeated caption work around a simple rule:
**reuse deterministic prerequisites, never reuse a fresh AI opinion as though it
were new.**

Examples of safe reuse include normalized/range audio, KFA acoustic emissions,
exact transcript+timing results, decoded waveform data, and completed stages of
the same resumable job. New Alternative/Deep Verify jobs still ask Gemini again.
Gemini upload and transcription requests are bounded so a stalled external call
cannot wedge the local processing queue indefinitely. The local timing daemon is
an optimization only; Studio retains its one-shot Python worker/CLI recovery path
for setup, diagnostics, and daemon-transport failure.

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

The release packager requires the packaged README and privacy guidance to match
the current release version and public data-flow truth. Do not weaken that guard
to package a stale or mismatched release.

### Build the curated Apple Silicon macOS release ZIP

On a clean checkout, run:

```text
npm run package:macos
```

The macOS packager reruns the macOS compatibility regressions, public-readiness,
typecheck, and production build checks; requires a clean tracked working tree;
and writes `Sthang-Studio-macOS-Apple-Silicon-v<version>.zip` plus its SHA-256
file under ignored `release-artifacts/`. The archive preserves executable bits
for its `.command`/shell entrypoints and keeps the extracted top level to the
installer, read-me, and one payload folder.

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
- [`docs/OTA-UPDATES.md`](docs/OTA-UPDATES.md) — signed-update protocol, rollback model, and production gates
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
