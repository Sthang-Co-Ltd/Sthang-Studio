# Changelog

## 0.7.11 — Studio Identity Refresh

- Replaced the previous approved Studio mark with the owner-selected interlocking ribbon-S identity and preserved the white/lime dark-surface, dark/lime light-surface, and monochrome variants on transparent backgrounds.
- Converted the supplied in-house STHANG wordmark geometry into protected transparent SVG variants for dark and light surfaces so the app never re-typesets the parent wordmark with a substitute font.
- Updated `StudioBrand` to choose both the Studio mark and STHANG wordmark by surface, with a forward-slanted lime divider and a smaller, lighter, widely tracked `STUDIO` descriptor.
- Removed the old boxed treatment around the Studio mark and tuned hero/compact proportions so the new mark reads cleanly in the home launcher and project header.
- Regenerated the browser favicon, 512px application icon, and Windows shortcut icon from the new primary mark.
- Expanded `brand-manifest.json` and brand verification to protect the Studio marks and STHANG wordmarks together, and updated `BRAND.md`, `DESIGN.md`, `AGENTS.md`, the public brand README, README, and trademark guidance.
- Fixed fresh-install TypeScript validation for the replace-media upload route by narrowing Express/Multer route parameters to a single non-empty project id before store lookup.
- Hardened clean Windows installation by using the committed npm lockfile, preferring binary Python packages, forcing UTF-8 mode for legacy setup scripts, and pinning KFA's `khmercut` dependency to the wheel-backed 0.0.2 release instead of the source-only 0.1.0 package that failed under the Windows code page.
- Aligned the wheel-backed Khmer tokenizer dependencies for Python 3.12 and treated KFA 0.2.0's stale `sosap==0.0.1` wheel metadata as one explicit compatibility exception while still failing every other dependency-check error and functionally verifying the newer Windows `sosap` wheel through KFA import/model preload.
- Removed stale hard-coded version labels from Windows setup/launcher banners and routed incomplete-install recovery back through `INSTALL-NEW-PC.bat`.
- No caption transcription, Khmer handling, timing, Review, project, correction-memory, regeneration, or SRT export behavior changed.

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
- The marker activates only when playback actually enters the selected review caption, preserving clean pre-roll.
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
- Removed the launcher’s hard dependency on a pre-existing `.env`; it creates an optional placeholder file automatically.
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
- Editable timeline, manual split/merge/nudge, video preview, and UTF-8 SRT export.
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
