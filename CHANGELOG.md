# Changelog

## Unreleased

## 0.85.5 — Fine Timing, caption handoff, effects, and Khmer transcription

- Keep unfinished Fine Timing timestamps scoped to their selected caption or
  word, including selections with identical times. Expose word review status to
  screen readers and explain recovery when no valid word interval is available.
  Clarify locked timing and the inspect-before-applying word-sync proposal.
- Add native Rise and Soft Pop beside Fade, sharing the original caption clock,
  saved presets, explicit replay and preview/export rendering. Keep overlap
  geometry steady with disclosed per-caption fades; preserve native wrapping
  through proportional Soft Pop width compensation.
- Preserve Rise/Soft Pop in caption-data version 3; retain version-1/default and
  version-2/Glow/Fade compatibility and explicit rejection by older readers.
- Polish appearance replay with a visible target, static-Look replay, Cancel
  preparation and Stop controls; native player seeking releases replay ownership.
- Prevent obsolete preview requests from clearing a replacement's pending frames.
  Refresh preview caches after font changes and preserve newer font/preset edits
  when older loading or saving responses arrive.
- Reuse identical plain text wrapping across native Fade/Glow/background paint
  states, reducing repeated preparation without changing the rendered output.
- Add six original Studio Looks with independent font/layout, Motion and Word
  emphasis controls, appearance Undo/Redo, Reset look and explicit replay.
- Add bounded native Glow and caption-clock Fade in/out. Preserve full-text Khmer
  shaping, original fade phase through word/overlap states, and separate Review
  focus at transparent boundaries. Prepare a bounded native replay opening.
- Preserve new effect settings in local presets and caption-data version 2;
  continue reading version 1 and exporting legacy-compatible default-effect data.
- Add destination-guided editable caption handoff: SRT, WebVTT, plain TTML,
  ready word-by-word SRT/VTT, styled ASS, Studio caption data and a ZIP guide kit.
  Explain CapCut Desktop/mobile import differences and per-format styling limits.
- Add bounded, previewed captions-only JSON restore with History, exact snapshot
  and candidate guards, fresh caption identities, lock protection and no imported
  correction/Contributor lineage. Preserve source media and current appearance.
- Add optional spoken-word highlighting to native preview and captioned MP4.
  Keep the full caption visible and restore its normal color between words.
  Incomplete, stale, or uncertain word timing leaves that caption plain; SRT
  continues to contain only caption text and cue start/end times.
- Add editable per-caption word timing, word edge/move controls, local exact-text
  Sync words proposals, explicit apply/discard, and undo. Preserve provable word
  timings through corrections, caption movement, splitting, merging, and History;
  mark ambiguous or changed words for review instead of stretching old timings.
- Prevent new or increased caption overlaps by default. Offer explicit overlap
  and shared-edge modes, with atomic two-caption undo and timing-lock protection.
- Preserve the full combined time span when merging overlapping or nested
  captions, without moving their retained word intervals.
- Keep Khmer glyph shaping and layout stable across highlight states using the
  native whole-text shaping path. Word offsets respect grapheme boundaries.
- Fix waveform delivery when the application or state folder has a dot-prefixed
  ancestor, such as a development worktree. Keep delivery restricted to the
  selected project's normalized audio, and exercise real HTTP delivery in tests.
- Use UTF-8 for persistent local timing worker input, output, and diagnostics so
  Windows pipe encoding cannot corrupt Khmer text or trigger avoidable recovery.
- Focus Fine Timing on the selected caption independently of recording length.
  Keep source playback visible while timing controls scroll, and provide labeled
  timestamp fields, edge/whole-caption nudges, set-to-playhead actions, edge
  auditions, optional bounded looping, and timing undo/redo.
- Commit canvas drags once on release; cancel unfinished drags with Escape or
  pointer cancellation. Validate typed timestamps on Enter/blur instead of saving
  partial input. Preserve timing locks and keep moved captions chronological.
- Allow manual timing without generated word anchors and retain numeric edits
  and source playback when the waveform preview fails to load.
- Start the first Deep Verify local alignment while its second independent listen
  completes. Preserve fresh listens, candidate precedence, deduplication, failure
  handling, timing accuracy, and existing cache boundaries.

## 0.85.4 — Windows OTA recovery

- Supersedes the broken `0.85.2` public Windows OTA offer. Version `0.85.3` remains
  signed immutable evidence and was deliberately never promoted.
- Supports the unchanged `0.8.0` preparation broker through a tightly bounded
  compatibility bridge that requires the legacy broker markers, the
  `updates/work/.../source` runtime location, and absence of repository tests.
- Keeps current OTA preparation and curated/manual Windows setup on explicit
  runtime-only TypeScript validation. Runtime validation still checks
  `packages/shared`, `apps/server`, and `apps/web`; normal source `npm run typecheck`
  still checks `tests/tsconfig.json`.
- Repairs npm's Windows workspace junctions when the prepared OTA tree moves from
  `updates/work/.../source` into its immutable `versions/<version>` location, so
  the activated runtime resolves shared/server/web workspaces from the final tree.
- Stabilizes Studio-managed Windows font transaction cleanup without weakening the
  existing import/remove assertions or deleting unrelated files.
- Preserves signed verification, fail-closed preparation, transactional activation,
  health checks, rollback, stable user state, and explicit **Download & verify**
  followed by **Install & restart**.
- Keeps Apple Silicon macOS 12.3+ on the curated manual-download path and otherwise
  preserves accepted 0.85.x product and privacy behavior.

## 0.85.3 — Emergency OTA activation hotfix

- Supersedes the `0.85.2` Windows signed-OTA offer after real updater preparation
  exposed a runtime-package/source-check mismatch before activation.
- Keeps normal repository `npm run typecheck` complete, including
  `tests/tsconfig.json`, while the OTA preparation broker explicitly requests the
  runtime-only path for a package that intentionally excludes repository tests.
- Runtime-only validation still checks `packages/shared`, `apps/server`, and
  `apps/web`, followed by the production build before any active-version switch.
- Preserves signed staging, package verification, dependency preparation,
  health-check, rollback, fail-closed behavior, stable user state, and the two
  explicit **Download & verify** then **Install & restart** decisions.
- Otherwise carries the accepted `0.85.2` product behavior, including curated
  Windows 10/11 x64 and Apple Silicon macOS 12.3+ recovery packages. The macOS
  package remains manual-download only and does not implement Windows OTA.
- Preserves existing Gemini/Files API, Khmer Caption Contributor, and optional
  analytics privacy disclosures and consent boundaries.

## 0.85.0 — Public Beta

### Caption appearance and finished-video export

- Added a project Appearance workspace with saved caption styling visible directly
  on the source video and carried consistently through editing, Review, history,
  native preview, and export.
- Added local captioned-video export with quality-aware MP4 rendering, persistent
  jobs/progress, cancellation/recovery, output verification, fixed export-location
  handoff, and Khmer complex shaping through FFmpeg/libass. Source media is never
  overwritten, and rendered frames/video are not uploaded by this local render path.
- Locked settled browser preview to the same native layout plan used by export so
  typography, wrapping, alignment, position, and effects remain visually consistent
  before encoding/display scaling.
- Added immediate Size/Position interaction feedback from the last matching native
  caption image while exact native pixels catch up, plus frame-coalesced/latest-value
  scheduling and bounded persistent local FFmpeg preview processes. The caption
  remains visible during continuous styling instead of disappearing between renders.

### Local Khmer font workflow

- Expanded caption typography to compatible Khmer families already installed on
  Windows, macOS, and Linux, with local coverage/shaping validation before use.
- Added **Add font…** for creator-selected `.ttf`/`.otf` files, local Studio-owned
  copies, immediate selection, live search results, **Manage added fonts**, and
  automatic Regular fallback when a chosen family has no Bold face.
- Font discovery/import/rendering stays local. Studio does not bundle a font catalog,
  install/remove operating-system fonts, or upload added font files as part of the
  font workflow.

### Apple Silicon macOS public Beta

- Added the first curated Apple Silicon macOS GitHub Release package targeting
  macOS 12.3 Monterey or newer on native arm64, while rejecting Intel/Rosetta mixes.
- Added a three-item ordinary-user package with **Install Sthang Studio.command**,
  **Read Me.txt**, and **Sthang Studio Files**. Setup installs under the user's
  Application Support directory and creates `~/Applications/Sthang Studio.command`
  for later launches.
- Added Node 22.12+ compatibility, Monterey/Ventura native dependency constraints,
  macOS Keychain-backed Gemini key storage, and a shared platform/runtime policy
  across installation, local timing setup, and launch.
- The macOS Beta remains command-based rather than a signed/notarized `.app` or
  `.dmg`; the Windows signed OTA updater is not implemented on macOS.

### Responsiveness, playback, and project performance

- Added project-summary loading, latest-request protection, deferred advanced
  workspaces, memoized caption indexing, lazy spectrum work, waveform extrema reuse,
  targeted project metadata reads, and reduced unnecessary project/history writes.
- Added bounded deterministic timing/preview caches and same-job persistence work
  while preserving fresh AI requests for Alternative takes and Deep Verify.
- Stabilized playback ownership, caption selection/grouping, and shared launcher
  readiness; fixed privacy/settings clipping and kept captions single-line by default.
- Added extensive local regression/measurement coverage for timing, browser behavior,
  rendering, cache invalidation, failure recovery, and macOS compatibility policy.

### Distribution and privacy continuity

- Bumped the public release identity to `0.85.0` and added curated Windows and
  Apple Silicon macOS ZIPs with SHA-256 checksum assets.
- Khmer Caption Contributor and optional product analytics remain separate,
  default-off, explicit-opt-in choices. Gemini Files API disclosure and provider
  retention guidance remain unchanged.
- Windows retains the updater verification trust introduced in 0.8.0, but this
  GitHub Release does not promote a public signed `latest.json`; OTA availability
  is therefore not claimed by 0.85.0.

## 0.8.0 — Public Beta

### Khmer Caption Contributor and privacy-safe product analytics

- Added exactly two caption-data states for the new Contributor program: Studio remains private by default, while **Khmer Caption Contributor** requires explicit opt-in and never makes core caption features conditional on participation.
- Added a non-blocking post-export invitation, a dedicated **Privacy** settings surface, installation-local consent, contributor status, verified-correction counts, verified-speech duration, opt-out, and contributor-wide deletion controls.
- Redesigned the Privacy surface around standardized decision cards with deliberate status chips, visible data boundaries, 48px consent controls, keyboard focus states, and separate lime Contributor / restrained-blue analytics accents. Existing pre-v0.8 installations with an unset Contributor choice receive one dismissible startup explanation; fresh installations keep the post-export path, and closing or reviewing the migration notice never grants consent or enables analytics.
- Extended the existing local correction pipeline with generated-wording lineage so incremental human edits resolve back to the original machine caption. Only eligible post-consent material corrections that are later approved can become contribution candidates; formatting-only and manually-authored starting captions are excluded.
- Added a serialized local contribution queue with explicit queued/uploading/submitted/verified/rejected/withdrawn states, deterministic sample ids, bounded short-WAV extraction, offline retry, safe in-flight opt-out, and local data minimization after remote submission.
- Added the Sthang-owned `contribute.sthang.app` Cloudflare Worker with private R2 audio, D1 metadata, hashed contributor credentials, strict payload validation, idempotency, rate bounds, corpus verification/rejection, 180-day expiry for submitted-unverified samples, and contributor-wide withdrawal/deletion.
- Added separate optional product analytics with a random installation id and a fixed event/property allow-list. Studio talks only to the Sthang-owned `analytics.sthang.app` relay; normal Studio app/runtime/configuration contains no downstream analytics-vendor endpoint, project key, browser SDK, session replay, or autocapture.
- Added a stateless Sthang analytics relay that revalidates the narrow event schema and forwards accepted personless events to the formally disclosed EU analytics processor with person-profile processing and GeoIP enrichment disabled. Formal privacy guidance does not claim the relay is an IP-anonymization guarantee.
- Added versioned, fail-closed public service configuration so existing upgraded installations do not depend on preserved `.env` files. After production synthetic validation passed, v0.8.0 was configured with only the two public Sthang service origins; both privacy choices remain default-off and explicit-consent-only.
- Added repository guards and tests for contribution eligibility, corpus intake, analytics data minimization, Sthang relay boundaries, public service configuration, and vendor-neutral shipped Studio/app/release-note copy.
- Added operator-only synthetic checks for contribution upload → verification → withdrawal and for analytics relay → downstream ingestion. Both production checks passed against the provisioned services. The v0.8.0 GitHub Release is public; OTA promotion, HQ intake, Distribution synchronization, and production model training remain separately gated.

### Gemini request resilience

- Bounded Gemini upload and transcription requests so a stalled external call fails/retries instead of blocking Studio's serialized processing queue indefinitely.
- Preserved the Google SDK's resumable Files API upload path while applying cancellation safely; the final compatibility fix was exercised successfully with caption generation on Windows Sandbox before publication.

### Signed Studio updater architecture — bootstrap trust published, OTA not publicly enabled

- Added a Studio-native signed Windows updater around the existing
  `%LOCALAPPDATA%\\Sthang Studio\\app` installation instead of migrating the app
  to Tauri or Electron.
- Added a Studio-only Ed25519 trust root, signed mutable latest pointer, signed
  immutable version manifests, byte/hash verification, bounded plain-text
  release notes, and release tooling suitable for separately approved hosting
  at `updates.sthang.app` and immutable Cloudflare R2 objects.
- Published the `0.8.0` bootstrap with the reviewed public Ed25519 verification
  key. The matching private key remains outside the repository behind the
  dedicated production signing-service custody boundary.
- Deployed the runner-free production signer, private R2 staging path, and GitHub
  issue-comment webhook separately from OTA publication. Provider-specific
  credentials and private custody coordinates remain outside public source.
- Added one non-blocking update check per browser session plus a manual **Check
  for updates** action. Downloads and installs always require separate explicit
  confirmation; Studio does not continuously poll, auto-download, or
  auto-install.
- Added staged package verification, safe ZIP extraction, isolated version-local
  Node/Python dependency preparation, atomic active-version selection, exact
  API/web health validation, startup recovery, and automatic rollback.
- Kept projects, media, captions, locks, history, correction memory, processing
  jobs/checkpoints, proposals, exports, compatible caches, the advanced `.env`
  fallback, and Windows-protected Gemini key storage outside swappable source
  versions.
- Published `v0.8.0` as the verified public Beta through the curated GitHub
  Release package, which remains the public manual download and recovery path.
  No public signed `latest.json` pointer has been promoted, so OTA availability
  is not claimed by this release.

### Repository maintenance

- Reject forbidden paths in locally available Git history, including deleted
  files, binary media paths, renamed files, and merge changes. Require a complete
  clone and avoid printing Git output when a history scan fails.
- Add isolated public-readiness regression tests to the contributor and CI flow.
- Align contributor setup with locked dependency installation, document commit
  email privacy, and distinguish historical audit/release records from current
  requirements and maintainer-only portfolio coordination.

## 0.7.14 — Public Beta disclosure repair

- Synchronized the workspace package versions and public runtime identity at
  `0.7.14`.
- Corrected the source and packaged release guidance so public Beta users are
  directed to the matching curated GitHub Release instead of stale private or
  pre-release-status wording.
- Clarified that Studio requests `store: false` for Gemini interactions while
  uploading normalized WAV audio through the separate Files API, does not
  explicitly delete that remote file, and relies on Google's currently
  documented retention of up to 48 hours.
- Added a product-owned Sthang intake manifest plus fail-closed checks for
  release identity, package truth, manifest structure, and Gemini disclosure.
- No caption transcription, Khmer handling, timing, Review, project,
  correction-memory, regeneration, installer, or SRT export behavior changed.

## 0.7.13 — Public Beta

- Made Windows setup and hosted validation explicitly include the locked development toolchain when running `npm ci`, including npm environments that otherwise omit development dependencies.
- Made release checksum generation independent of PowerShell module auto-loading so npm-invoked Windows packaging remains reliable across mixed PowerShell installations.

## 0.7.12 — Public Beta Candidate

- Fixed the clean-clone release validation path so `npm ci` followed by `npm run typecheck` emits shared declarations before the downstream server and web checks.

## 0.7.11 — Studio Identity Refresh

- Replaced the previous approved Studio mark with the owner-selected interlocking ribbon-S identity and preserved the white/lime dark-surface, dark/lime light-surface, and monochrome variants on transparent backgrounds.
- Converted the supplied in-house STHANG wordmark geometry into protected transparent SVG variants for dark and light surfaces so the app never re-typesets the parent wordmark with a substitute font.
- Updated `StudioBrand` to choose both the Studio mark and STHANG wordmark by surface, with a forward-slanted lime divider and a smaller, lighter, widely tracked `STUDIO` descriptor.
- Removed the old boxed treatment around the Studio mark and tuned hero/compact proportions so the new mark reads cleanly in the home launcher and project header.
- Regenerated the browser favicon, 512px application icon, and Windows shortcut icon from the new primary mark.
- Expanded `brand-manifest.json` and brand verification to protect the Studio marks and STHANG wordmarks together, and updated `BRAND.md`, `DESIGN.md`, `AGENTS.md`, the public brand README, README, and trademark guidance.
- Fixed fresh-install TypeScript validation for the replace-media upload route by narrowing Express/Multer route parameters to a single non-empty project id before store lookup.
- Hardened clean Windows installation by using the committed npm lockfile, preferring binary Python packages, forcing UTF-8 mode for legacy setup scripts, and pinning KFA's `khmercut` dependency to the wheel-backed 0.0.2 release instead of the source-only 0.1.0 package that failed under the Windows code page.
- Aligned the wheel-backed Khmer tokenizer dependencies for Python 3.12 and treated KFA 0.2.0's stale `sosap==0.0.1` wheel metadata as one explicit compatibility exception while still failing every other `pip check` error and functionally verifying the newer Windows `sosap` wheel through KFA import/model preload.
- Added a no-WinGet prerequisite fallback for clean Windows installs, including direct per-user Node.js/Python setup, a pinned FFmpeg 8.1.2 GitHub Release download with SHA-256 verification, visible download progress/timeouts, and clearer recovery messages.
- Made the Windows launcher wait for both local services, respect the registered default browser when Windows has a usable `http://` association, and print the local Studio URL when no browser association is available; Chrome is never assumed.
- Added a curated Windows Release packager that keeps the extracted first-run folder to `Install Sthang Studio.bat`, `Read Me.txt`, and one `Sthang Studio Files` folder; setup copies the app to `%LOCALAPPDATA%\Sthang Studio\app`, preserves user runtime state during source refresh, and emits a SHA-256 checksum alongside the release ZIP.
- Removed stale hard-coded version labels from Windows setup/launcher banners and routed incomplete-install recovery back through `INSTALL-NEW-PC.bat`.
- No caption transcription, Khmer handling, timing, Review, project, correction-memory, regeneration, installer, or SRT output behavior changed.

## 0.7.10 — Focus Loop & Clear Copy

- Split Review playback into a full **context pass** followed by a tight **focus pass** around the selected caption.
- Auto-play on a newly selected review item still uses the configured surrounding context; subsequent loops cap lead-in at 140 ms and tail audio at 120 ms.
- **Replay** now immediately uses the tight focus pass, while **Play with context** in advanced Review controls restores surrounding speech for one pass.
- Completing a caption text or timing edit in Review immediately replays the selected caption with the tight focus pass.
- Renamed **Loop current** to **Tight loop** to match the new behavior.
- Audited tooltips and working-surface microcopy for unnecessary implementation detail and shortened them to action-oriented language.
- Removed KFA/Gemini/Whisper/model-stack wording from normal tooltips, home/setup surfaces, waveform recovery copy, and regeneration action help.
- Simplified the Windows launcher status copy so routine startup does not foreground provider/aligner names.
- Kept provider/model details only where they are needed for setup or diagnostics, including AI connection, Details, and System check internals.
- Preserved Review Focus, caption timing/data, non-destructive regeneration, exports, correction memory, projects, and the approved SVG brand system.

## 0.7.9 — Review Focus

- Added a video-centric Review Focus marker so the caption currently being reviewed is obvious without looking at the right-hand queue.
- The marker activates only when playback actually enters that caption, preserving clean pre-roll.
- Added an angular Studio-lime bracket treatment that does not alter caption text, size, position, timing, or exports.
- Added a persistent Review Focus preference: **Brackets + label**, **Brackets only**, or **Off**.
- Regeneration A/B preview also keeps the active proposal range visually focused while Current/Proposed text is compared.
- Review Focus is editor chrome only and never appears in SRT or rendered source media.


## 0.7.8 — Sequential Review

- Changed the Review workspace primary action to **Approve & next** and moved it to the far-right decision position.
- Approving now advances to the next unapproved flagged caption instead of leaving focus on an item that just disappeared from the review queue.
- Added persistent **Auto-play next** preference; when enabled, the next review item starts with the existing pre-roll and can continue using the optional current-item loop.
- Renamed generic **Next** to **Skip** so moving forward without approval is explicit.
- Renamed **Preview regeneration** to the simpler **Improve…** entry point beside the approval decision.
- Added one-step **Undo** for the most recent review approval.
- Added review shortcuts: `Enter`/`A` approve and advance, `R` replay, and `S` skip.
- Kept sequential auto-advance strictly inside Review mode; free timeline editing remains stationary.

## 0.7.7 — Focused Home

- Replaced the marketing-style home headline with **Accurate Khmer captions, ready for CapCut.**
- Shortened the supporting copy to one task-oriented sentence.
- Removed the redundant `KHMER-FIRST WORKSPACE` descriptor from the home brand lockup.
- Collapsed the completed three-step setup checklist into a compact **Studio ready** status.
- Removed the repeated workflow sentence from the setup card.
- Kept incomplete setup guidance intact for genuinely new users.

## 0.7.6 — Adaptive Workspace Canvas

- Fixed the large unintended empty region beneath the video when no advanced workspace was selected.
- The collapsed workspace now lets the media canvas expand to consume the available left-column height instead of reserving dead space.
- Opening Review, Fine timing, Accuracy, Caption style, or Details restores the normal tool-oriented media sizing and scrolling behavior.
- Preserved the existing stacked/mobile layout so smaller screens do not force an oversized media canvas.
- Encoded the no-dead-space rule in DESIGN.md and AGENTS.md so future frontend regeneration does not reintroduce the layout regression.
- No changes to captions, Gemini, KFA timing, correction memory, projects, profiles, or SRT output.

## 0.7.5 — Calm Workspace & Frontend Audit

- Audited the Captions frontend with the Impeccable 4.1.1 accessibility, performance, responsive, theming, implementation-integrity, distillation, onboarding, and craft-floor criteria.
- Reduced the persistent project header to Review, Tools, Save, and Export SRT. Guide, Correct, History, Jobs, Corrections, Replace, and Settings now live in a labeled Tools menu with plain-language descriptions and status counts.
- Added progressive disclosure beneath the video: only one of Review, Fine timing, Accuracy, Caption style, or Details renders at a time. The default workspace returns focus to video evidence and caption editing.
- Simplified caption rows so Approve remains visible while locks, nudges, split, merge, and delete move into an explicit per-caption menu.
- Replaced multiple alarming risk chips on unselected rows with one calm Review suggested summary; detailed reasons remain visible on selection.
- Added a global focus-visible system, larger operational type, more ergonomic targets, persistent responsive labels, and reduced-motion handling.
- Fixed overlapping busy/job/error/notice messages with a single ordered toast stack and dismissible notices/errors.
- Moved recent projects and setup warnings into normal page flow to prevent them covering upload content.
- Presented Settings, History, Jobs, Corrections, and similar utility surfaces as consistent right-side sheets.
- Renamed the visible System Doctor surface to System check and simplified beginner-facing copy while keeping technical details available.
- Added PRODUCT.md, DESIGN.md, UX-AUDIT.md, and durable frontend invariants in AGENTS.md for future regeneration.
- Preserved the approved three-SVG Studio logo system byte-for-byte and added no npm/Python dependency or model.

## 0.7.4 — Approved Studio Logo Integration

- Replaced the previous generated Studio graphical mark with the exact three owner-supplied SVGs.
- Added the white/lime primary mark for dark surfaces, dark/lime ink mark for light surfaces, and white monochrome mark for one-colour use.
- Added a surface-aware `StudioMark` component so UI code selects an approved asset explicitly rather than recolouring or approximating the mark.
- Regenerated the browser favicon, 512px application icon, and multi-resolution Windows shortcut icon from the approved primary SVG.
- Added `brand-manifest.json` with approved asset roles and SHA-256 fingerprints.
- Added a build/typecheck brand-verification step that fails if an approved SVG is silently modified.
- Added persistent developer/agent guidance that the supplied SVGs are source-of-truth and must not be replaced with generated artwork.
- No caption, Gemini, KFA, project, correction-memory, regeneration, timing, or SRT behaviour changed.

## 0.7.3 — Live A/B Regeneration Review

- Replaced the blocking regeneration modal with a non-modal review dock beneath the video.
- Added live Current/Proposed caption switching on the video, range replay, looping, and changed-caption navigation.
- Added editable proposed wording plus accept-all, text-only, timing-only, and keep-current actions.
- Added independent alternative takes, accepted-baseline refinement, optional accuracy hints, and pass-by-pass proposal history metadata.
- Added Deep Verify with two differently prompted Gemini candidates and advisory local-alignment ranking.
- Added exact user-text realignment that skips Gemini and uses local KFA timing.
- Added honest UI messaging that repeated AI passes cannot guarantee ambiguous names and that exact-text realignment is the deterministic text fallback.
- Fixed the regeneration close button’s invisible white-on-white styling.
- Added a three-step home setup checklist and a six-step in-project Quick Guide for first-time users.
- Increased review/onboarding label sizes, improved control targets, added explanatory tooltips, and clarified that baseline refinement is temporary until an explicit Accept action.
- Linked new-user timing help to System Doctor and API-key setup to AI Connection.
- Added backward migration for stored v0.7.x regeneration proposals.
- Improved reconstruction of Khmer caption-range text so editing/review does not insert artificial spaces between continuous Khmer blocks.
- Kept the Gemini wording + local KFA timing architecture, correction memory, locks, history, jobs, waveform recovery, and CapCut SRT export.

## 0.7.2 — Resilient Precision Timeline

- Fixed the Precision Timeline error `Unable to decode audio data` seen when Chrome rejected a cached normalized WAV preview.
- Added direct decoding for PCM WAV, including RIFF/RIFX/RF64 containers, PCM/float samples, and mono downmixing.
- Kept Web Audio decoding as a secondary fallback.
- Added automatic no-cache retry with server-side waveform regeneration after a decode failure.
- Added an in-editor **Rebuild waveform** recovery action and clearer non-destructive error messaging.
- The server validates WAV headers, minimum file size, and ffprobe duration before reusing cached audio.
- Rebuilding a corrupt preview for unchanged media preserves existing Gemini and KFA stage caches.
- Waveform responses now use no-store headers, and send-file errors are handled explicitly.
- No changes to captions, KFA timing anchors, project/profile formats, correction memory, or SRT output.

## 0.7.1 — In-App AI Setup + UI Polish

- Added **Settings → AI connection** with first-run onboarding, masked connection status, paste/show/hide controls, and a direct Google AI Studio key link.
- Added **Save & connect**, which validates the selected Gemini model/key before persisting it, plus a non-destructive **Test only** action.
- Added configurable primary and fallback Gemini model IDs without editing source or `.env` files.
- Added Windows user-protected API-key storage outside the project folder using DPAPI-backed encryption. The plaintext key is never returned to the browser after saving.
- Kept `GEMINI_API_KEY` from `.env`/environment as a backward-compatible advanced fallback; a securely saved in-app key takes priority.
- Added **Forget saved key**, connection-source indicators, System Doctor integration, and profile/diagnostic exclusion guarantees.
- Updated transcription and cache signatures to resolve the active in-app model settings at job time.
- Guarded full and selected regeneration with a direct route to AI setup when no key is connected.
- Bound Vite and the API to loopback only, tightened allowed browser origins, and disabled caching on AI-settings responses.
- Removed the launcher's hard dependency on a pre-existing `.env`; it creates an optional placeholder file automatically.
- Reworked scrollbars across the editor, caption list, settings, review, corrections, history, and jobs panels with slimmer rounded thumbs, transparent tracks, hidden buttons, and low-contrast resting states.
- No changes to Gemini/KFA caption quality, local timing, project/profile formats, correction memory, or SRT output.

## 0.7.0 — Professional Review

- Added a local waveform/spectral timing workspace backed by the cached normalized WAV.
- Added KFA timed-word anchor visualization, zoom/pan, playhead following, playback-speed control, and draggable caption boundaries.
- Added word, nearby-silence, and off snapping modes for manual timing.
- Added Approved, Text lock, and Timing lock states per caption plus bulk selection controls.
- Automatic regeneration, regrouping, Khmer cleanup, and timing post-processing preserve relevant locks.
- Adjacent reviewed locks are assigned independently, preventing one locked caption from consuming another during regrouping or regeneration.
- Replaced destructive regeneration of existing projects with persisted before/after proposals.
- Added Accept all, text-only, timing-only, and reject actions with lock preservation and stale-proposal protection.
- Added Correct Everywhere with literal, case-insensitive, and regex search; project/selection scope; locked-caption protection; preview; and optional glossary memory.
- Added QA profiles for fast Khmer TikTok, comfortable Khmer TikTok, CapCut SRT, and accessibility workflows.
- Added QA checks for CPS, line length/count, duration, gaps, overlaps, media bounds, weak timing, duplicates, aliases, mixed-script entities, and spacing.
- Added safe timing post-processing with KFA-boundary snapping, lead-in/out, minimum gaps/durations, and timing-lock protection.
- Added debounced autosave that pauses while text fields are active.
- Added persistent, human-readable project history with restore checkpoints.
- Added a persistent local job queue for full transcription and selected/full regeneration, with progress, retry/resume, cancellation requests, and completed-result reopening.
- Media replacement/deletion is blocked while a project job is active; replacing media clears old-media history/proposals so stale timing cannot be restored onto a new export.
- Kept the Gemini wording + local KFA timing architecture, local Whisper fallback, correction memory, profile format, and UTF-8 CapCut SRT export.

## 0.6.2 — Stable Timeline UX + Khmer Typography

- Replaced unconditional active-caption auto-scroll with a tracking-band follower that scrolls only when necessary.
- Manual wheel/touch/scroll interaction and text editing pause follow mode automatically.
- Added **Current** (jump to playhead), an explicit **Following / Follow** toggle, and keyboard shortcut `J`.
- Structural caption edits preserve the list viewport. Deleting the selected caption now selects a nearby surviving row instead of resolving to the first caption.
- Added selection repair for caption IDs replaced by delete, split, merge, regrouping, or backend regeneration.
- Added pause-aware Khmer token-spacing normalization while preserving Latin/model/version spacing.
- Added a non-destructive **Clean Khmer spacing** project action for existing caption text; timestamps remain unchanged and no correction events are generated.
- Manual caption merge now joins Khmer-to-Khmer text without an English-style space.
- No KFA timing, Gemini model, project schema, profile schema, or SRT timestamp format changes.

## 0.6.1 — Intentional Brand Lockup

- Rebuilt the `STHANG / STUDIO` lockup so the product name is optically baseline-aligned with the parent wordmark.
- Added a restrained forward-slanted divider to make the parent/product relationship explicit.
- Tightened spacing, reduced excess tracking, and increased product-name weight.
- Applied the same lockup logic to the compact project header and responsive layouts.
- No transcription, timing, project, profile, cache, or correction-memory behavior changed.

## 0.6.0 — Sthang Studio Brand Foundation

- Rebranded the product from **Khmer Caption Studio** to **Sthang Studio**.
- Positioned the existing caption tool as the **Captions** workspace inside the broader short-form video finishing product.
- Added the supplied parent STHANG wordmark to the home screen and workspace header.
- Added a distinct Studio-specific **S-frame** mark with a media playhead; the Sthang ACO falcon/eagle remains exclusive to ACO.
- Added branded browser title, favicon, Windows icon, and desktop shortcut.
- Added `STOP-STHANG-STUDIO.bat`; retained the old stop filename as a compatibility alias.
- Renamed exported profiles to `sthang-studio-profile.json`.
- Updated installer, launcher, server logs, setup doctor version, documentation, and all user-facing labels.
- Kept internal project/profile/cache schemas and localStorage migration keys compatible with v0.5.x.
- No caption transcription, KFA timing, correction-memory, review, or SRT behavior was changed.

## 0.5.1 — Stable Runtime Hotfix

- Removed Node `--watch` from the end-user backend launcher. The watcher could restart the API during a long transcription, producing `ECONNRESET`, repeated Vite `ECONNREFUSED` proxy errors, and a misleading `Request failed (500)` toast.
- The launcher now waits for both the backend health endpoint and the Vite frontend before opening the browser, preventing startup-race errors.
- No transcription, KFA, correction-memory, profile, or project data format changes. Existing v0.5.0 installations can upgrade by extracting this release over the app folder.

## 0.5.0 — Workflow Intelligence

### Correction learning

- Automatically captures caption text edits as Correction Events on blur, Save, and Export.
- Stores Got / Expected text, exact audio timestamps, project identity, and nearby caption context.
- Added Correction Inbox with pending/history views, exact audio replay, copyable reports, and safe memory decisions.
- Added conservative correction classification:
  - Khmer phonetic form to Latin entity can become an explicit alias, e.g. `Terra | ថេរ៉ា`.
  - Unrelated entity substitutions are never turned into destructive global replacements; only the corrected term is protected.
- Added global and project-only correction scopes.
- Added duplicate-event protection and bounded correction history.

### Review workflow

- Added Risk Review Mode and export-readiness scoring.
- Flags low/interpolated timing, medium timing, short/long display duration, fast reading speed, overlaps, duplicates, mixed Khmer/English entities, acronyms/version numbers, repeated spaces, and noncanonical aliases.
- Added Shift-click range selection.
- Added selected-range audio replay and optional auto-loop with pre/post roll.
- Added keyboard shortcuts for playback, replay, editing, risk navigation, timing nudges, and save/advance.

### Selective regeneration and caching

- Added `Regenerate selected only` for a selected caption range.
- Extracts only the requested audio plus configurable context padding.
- Re-runs Gemini + local timing only for that region and preserves captions/manual edits outside it.
- Added persistent normalized-audio cache per project/media fingerprint.
- Added signed Gemini and local-timing stage checkpoints.
- Interrupted initial runs can resume from completed stages; deliberate full regeneration forces fresh stages.
- Replacing/deleting project media invalidates its cache.

### Profile and portability

- Moved default vocabulary and My TikTok Style from browser-only storage into a transferable server-side profile.
- Added profile export/import containing glossary, approved rules, correction history, topic packs, style presets, and review preferences.
- Added reusable topic packs for project context + vocabulary.
- Added one-time migration from v0.4 browser localStorage settings.

### System and installation QoL

- Added System Setup Doctor for Node, FFmpeg/FFprobe, Python, KFA, ONNX, KFA model cache, Whisper fallback, Gemini key presence, writable storage, and Khmer segmentation support.
- Added safe Copy Diagnostic Report output that never includes the Gemini key.
- Added `INSTALL-NEW-PC.bat`:
  - WinGet prerequisite installation/checks;
  - npm/Python/KFA setup;
  - KFA model preload;
  - secure Gemini-key prompt;
  - desktop shortcut creation.
- Added `STOP-KHMER-CAPTION-STUDIO.bat` for clearing stale ports 8787/5188 after confirmation.
- Improved launcher shutdown to terminate complete Windows child-process trees, reducing orphaned Vite/Node processes.
- Kept direct Node CLI invocation so folders containing `&` continue to work.

### Existing core retained

- Gemini 3.7 Flash primary transcription with transient retry and Gemini 3.6 Flash fallback.
- Context-aware vocabulary/native-bias path and deterministic user-owned alias canonicalization.
- Local KFA Khmer forced alignment with local faster-whisper fallback.
- Dynamic, Word, Phrase, and Line regrouping without timing drift.
- Editable timeline, manual split/merge/nudge, video preview, and UTF-8 CapCut SRT export.
- No automatic paid Google Cloud timing fallback.

## 0.4.0 — Context-aware vocabulary

- Added project topic context, protected vocabulary, explicit aliases, global glossary, proper-noun preservation, caption rhythm refinements, active-row follow, and context-aware regeneration.

## 0.3.1 — Gemini resilience

- Added transient retry/backoff and Gemini fallback-model handling.

## 0.3.0 — Local Khmer alignment

- Added KFA local forced alignment and local faster-whisper fallback.

## 0.2.0 — Hybrid timing experiment

- Separated transcription wording from dedicated timing anchors.

## 0.1.x — Initial MVP

- Added upload, Gemini transcription, editable captions, grouping modes, project history, and SRT export.
