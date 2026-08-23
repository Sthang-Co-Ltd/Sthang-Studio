# Sthang Studio v0.7.10 — Focus Loop & Clear Copy

> **A calmer editor for first-time users without removing power-user capability.** The persistent workspace now centers on the video, caption list, Review, Save, and Export. Specialist controls open one focused surface at a time, caption-row actions are safer, status messages no longer overlap, and responsive layouts keep meaningful labels.

## New in v0.7.10

### Faster caption review playback

Review now separates **context** from **correction**. Entering or auto-advancing to a review item still starts with the normal surrounding context. After that first pass, **Replay** and automatic looping use a tight focus window around the selected caption so repeated listen → edit → listen cycles do not keep making you wait through nearby captions.

- First pass on a review item keeps the configured pre-roll and post-roll.
- Subsequent loops use at most 140 ms of lead-in and 120 ms of tail audio.
- **Replay** uses the tight focus pass immediately.
- **Play with context** remains available under the advanced Review controls whenever surrounding speech is useful again.
- Finishing a text or timing edit in Review automatically replays the selected caption with the tight focus pass.
- Review Focus brackets remain editor-only and continue to activate only inside the selected caption timestamp.

### Clearer, less technical microcopy

A tooltip and microcopy pass removed implementation details from normal working surfaces. Tooltips are shorter and action-oriented; primary onboarding and recovery copy now describes what Studio does instead of naming its internal timing/transcription stack. Provider/model names remain only where they are actually needed, such as **AI connection**, **Details**, and diagnostics.

The pass follows the existing Impeccable audit/distillation rules already captured in `UX-AUDIT.md`: keep the primary workflow calm, disclose technical detail progressively, and avoid making casual users learn infrastructure to complete a caption project.

### Compatibility

- No caption, project, profile, correction-memory, regeneration, timing, or SRT data format changed.
- No new npm package, Python package, model, or external service is required.
- The three owner-approved Studio SVGs remain byte-for-byte unchanged and are still verified during build/typecheck.

## Retained from v0.7.9

### Review Focus

Sequential Review now identifies the exact caption being judged directly on the video with non-destructive Studio-lime corner brackets. The marker appears only once playback enters the selected caption, so pre-roll remains visually honest. Under Review → advanced tools, choose **Brackets + label**, **Brackets only**, or **Off**. This is editor-only chrome and never affects SRT export.



### Sequential review flow

Review mode now behaves like a focused approval queue. The primary decision is the fixed far-right **Approve & next** action; approving immediately advances to the next unapproved flagged caption and can auto-play it with the normal review pre-roll. **Skip** moves forward without approving, **Improve…** opens the existing live regeneration workflow, and a short-lived **Undo** action protects against accidental approvals. `Enter` or `A` approves and advances, `R` replays, and `S` skips.

The behavior is intentionally scoped to Review mode. Free editing in the normal timeline never auto-advances.

### Focused home launcher

The home screen is now intentionally terse: **Accurate Khmer captions, ready for CapCut.** Setup collapses to a compact **Studio ready** status once Gemini, local Khmer timing, and at least one project are available. The upload action remains the dominant next step instead of competing with repeated explanatory copy.


### Adaptive collapsed workspace

When no advanced workspace is selected, the left editor column no longer reserves a large empty region beneath the video. The media canvas expands to use the available editor height while the workspace launcher remains compact. Opening Review, Fine timing, Accuracy, Caption style, or Details returns the media area to its normal tool-editing size. On narrow layouts, the existing stacked/mobile sizing is preserved.


### Impeccable frontend audit

- Added `UX-AUDIT.md` with a prioritized code/screenshot audit across accessibility, performance, responsive behavior, theming, and implementation integrity.
- Added `PRODUCT.md` and `DESIGN.md` so future development preserves the simple upload → generate → review → export path.
- Recorded UX invariants in `AGENTS.md` alongside the existing immutable-logo rules.

### Calmer project workspace

- Reduced the always-visible header to **Review**, **Tools**, **Save**, and **Export SRT**.
- Moved Correct Everywhere, History, processing Jobs, Correction Inbox, Replace Media, Guide, and Settings into a labeled Tools menu.
- Added one-at-a-time workspace tools: **Review**, **Fine timing**, **Accuracy**, **Caption style**, and **Details**. Advanced panels no longer form an intimidating stack below the video.
- Kept regeneration review docked beside the video and preserved all live Current/Proposed comparison behavior.

### Safer caption rows

- Kept **Approve** visible and moved locks, timing nudges, split, merge, and delete into a clearly labeled row menu.
- Collapsed unselected QA warnings into a calm **Review suggested** summary; selecting the row reveals the actual reasons.
- Added accessible labels to caption text and time fields plus explicit pressed/expanded states.

### Visual and interaction polish

- Added visible keyboard focus, larger operational copy, more ergonomic controls, reduced-motion behavior, and persistent labels at responsive breakpoints.
- Replaced overlapping toasts with one ordered status stack.
- Moved recent projects and setup messages into page flow so they cannot cover the upload surface.
- Changed utility overlays to predictable side sheets.
- Renamed the user-facing **System Doctor** to **System check** and simplified setup copy.

### Compatibility

- No caption, Gemini, KFA, project, profile, correction-memory, regeneration, timing, or SRT data format changed.
- No new npm package, Python package, model, or external service is required.
- The three owner-approved Studio SVGs remain byte-for-byte unchanged and are still verified during build/typecheck.

## Retained from v0.7.4 — Approved logo system

### Owner-approved Studio marks

- Replaced the previous in-app graphical mark with the exact supplied high-quality SVG geometry.
- Added three explicit source-of-truth variants:
  - `sthang-studio-mark.svg` — white + lime for dark surfaces;
  - `sthang-studio-mark-ink.svg` — dark ink + lime for white/light surfaces;
  - `sthang-studio-mark-mono.svg` — white monochrome for single-colour dark use.
- The home identity, compact project header, browser favicon, Windows app icon, and desktop shortcut now derive from the approved mark.
- Added a reusable `StudioMark` component with explicit `dark`, `light`, and `mono` surface variants so future light-theme or export surfaces use the correct artwork instead of recolouring the wrong file.

### Brand permanence for future development

- Added `brand-manifest.json` with the approved filenames, intended surfaces, and SHA-256 hashes.
- Added `npm run verify:brand`; normal typecheck and build commands verify the three SVG files byte-for-byte before continuing.
- Added root `AGENTS.md` and expanded brand documentation with a clear rule: do not redraw, trace, approximate, recolour, or replace these marks with generated artwork unless the owner supplies a newly approved set.
- Regenerated only derived favicon/PNG/ICO assets from the approved primary SVG; the three source SVGs remain unchanged.

### Compatibility

- No transcription, Gemini, KFA timing, correction memory, review, regeneration, project, profile, cache, or SRT behaviour changed.
- No new npm package, Python package, model, or external service is required.

## Retained from v0.7.3

> **Non-destructive accuracy workflow:** regeneration now opens as a live review dock beneath the video instead of a blocking modal. The video remains playable while users switch between current and proposed captions, replay/loop the affected range, request another take, run an advisory two-pass verification, or align exact user-entered wording locally. A first-run checklist and in-app Quick Guide make the core workflow understandable without learning the advanced controls first.


### Live review beside the video

- Replaced the blocking regeneration modal with a dock beneath the video.
- The video controls remain available throughout review.
- Switch the rendered video caption instantly between **Current** and **Proposed** without changing saved project data.
- Replay the complete affected range, loop it continuously, or jump through individual changed captions.
- Edit the proposed wording directly while listening.
- Fixed the invisible white close control with a dedicated, high-contrast dark close button.
- Keep the current version, accept text only, accept timing only, or accept the complete proposed range.

### Iterative accuracy refinement

- **Try another take** performs an independent second listen instead of repeating the previous output blindly.
- **Use as baseline & refine** carries the visible/user-edited wording forward as a high-value temporary baseline, allowing accepted correctness to accumulate across passes without changing the saved project until a bottom Accept action is chosen.
- **Deep verify** runs two differently instructed Gemini passes and uses local alignment coverage/score as advisory evidence when selecting the next proposal. This ranking is useful but is not proof that an ambiguous proper noun is semantically correct.
- **Accuracy hint** lets the user provide exact names, versions, scripts, or domain clues for the selected range.
- **Realign exact wording** skips Gemini completely, preserves the user-entered text, and uses local KFA timing. This is the deterministic text fallback when AI repeatedly mishears a name or number.
- Every proposal shows its pass number, strategy, accepted-baseline status, and (for Deep Verify) candidate evidence.
- Existing project edits and caption locks remain protected until the user explicitly accepts a result.

### Beginner-friendly onboarding

- Added a three-step first-run checklist: connect Gemini, verify local KFA timing, and upload media.
- Added a persistent **Guide** entry on both the home screen and project toolbar.
- The Quick Guide presents the first project as a six-step workflow: connect, verify timing, add optional context, generate, review risks, and export.
- Setup steps link directly to AI Connection or System check rather than requiring users to know which file or terminal command to open.
- Advanced features such as waveform timing, locks, QA profiles, correction memory, and Deep Verify are explicitly presented as optional.
- Regeneration review includes a plain-language “Start here” prompt, visibly larger labels and controls, a temporary-baseline safety explanation, and honest accuracy limitations.

### Compatibility and reliability

- Older persisted v0.7.x proposals are automatically upgraded with the metadata required for live A/B preview.
- Exact-text realignment uses a tightly cropped audio range so surrounding speech does not stretch the forced alignment.
- Khmer caption ranges are reconstructed for editing without reintroducing an English-style space between every Khmer caption block.
- The v0.7.2 direct PCM waveform decoder, cache validation, and **Rebuild waveform** recovery remain included.

## Retained platform features

### Gemini setup inside the app

Open **Settings → AI connection**, paste the Gemini API key, then choose **Save & connect**. The app verifies the key/model before saving and updates immediately—no restart or manual `.env` editing is required. New installations automatically open this setup screen until Gemini is connected.

The settings screen includes:

- masked connection status and key source;
- paste/show/hide controls;
- a direct Google AI Studio key link;
- primary and optional fallback model fields;
- **Test only**, **Save & connect**, and **Forget saved key** actions;
- System check integration without exposing the secret.

On Windows, the saved key is encrypted using the current Windows user’s protected storage and written outside the project folder under `%LOCALAPPDATA%\Sthang Studio`. The plaintext key is never returned by the backend, exported in a profile, or included in diagnostics. Existing `GEMINI_API_KEY` environment/`.env` configuration remains supported as an advanced fallback.

For local credential safety, the web app and API bind to loopback only (`127.0.0.1`), and browser API access is restricted to the Sthang Studio frontend origin.

### Refined scrollbars

Scrollable workspaces now use narrow rounded thumbs, transparent tracks, hidden scrollbar buttons, subtler resting contrast, and clearer hover contrast. The caption list uses an even slimmer treatment so the scrollbar stays usable without dominating the editor. Firefox receives its native thin-scrollbar equivalent.

## Professional Review retained from v0.7.0

### Precision timeline

- A local waveform is decoded from the same normalized 16 kHz audio used by the timing pipeline.
- Toggle between waveform and lightweight spectral views.
- Zoom and pan without moving the video playhead.
- Display KFA timed-word anchors; labels appear automatically at useful zoom levels.
- Drag caption starts/ends directly. Boundaries can snap to KFA words, nearby silence, or remain unsnapped.
- Change review playback speed from 0.5× to 2×.
- The waveform has its own optional follow mode, separate from the calm caption-list follow behavior introduced in v0.6.2.

### Approved captions and locks

Each caption can now be marked **Approved**, **Text locked**, and/or **Timing locked**. Locks are preserved through full regeneration, selected-range regeneration, regrouping, Khmer spacing cleanup, and timing post-processing. Bulk actions are available for the current Shift-click selection.

### Regeneration without destructive replacement

Regenerating an existing transcript now creates a proposal instead of replacing current work. The diff shows current/proposed text and timing, confidence, timing delta, unchanged captions, and protected locks. Apply all changes, text only, timing only, or reject the proposal.

### Correct Everywhere

Press `Ctrl+F` or use **Correct** to search the whole project or selected captions. Supported matching modes are literal, case-insensitive Latin matching, and regular expressions. Text-locked captions are displayed but skipped. A safe correction can optionally be remembered in the project or global glossary.

### Subtitle QA and timing post-processing

Built-in QA profiles:

- **Khmer TikTok — Fast**
- **Khmer TikTok — Comfortable**
- **CapCut SRT**
- **Accessibility**

Checks include reading speed, characters per line, line count, minimum/maximum duration, inter-caption gaps, overlap, media bounds, low/interpolated timing, duplicate text, aliases, mixed-script entities, and Khmer spacing. **Fix safe timing** snaps unlocked boundaries to nearby timed words, adds profile lead-in/out, enforces minimum gaps and durations, and creates a restore point first.

### Autosave, persistent history, and processing jobs

- Quiet autosave waits until text editing stops.
- Human-readable project checkpoints are created before meaningful edits and automatic operations.
- Restore an earlier version without losing the current one; a checkpoint is created before restore.
- Gemini/KFA work runs through a persistent local queue with visible stage/progress state.
- Jobs survive browser refreshes. Jobs interrupted by an app restart can be resumed and reuse valid normalized-audio/Gemini/timing checkpoints where available.
- Completed jobs remain in the queue and include **Open result**.

### Keyboard review workflow

```text
Space          Play / pause
R              Replay selected caption(s)
E              Edit selected caption
J              Jump caption list to playhead
Up / Down      Previous / next risk in Review mode
Alt+Left/Right Shift selected timing by 50 ms
Ctrl+F         Correct Everywhere
Ctrl+S         Save
```

## Upgrade from v0.6.x

Close the running Sthang Studio terminal, extract this package over the existing app folder, choose **Replace files**, and run `run-windows.bat`. No new Python package or model is required. Existing `.env`, KFA model, `.venv`, `node_modules`, projects, profile, correction memory, uploads, and caches are user data and are not distributed in release archives.

## New in v0.6.2

### Calm timeline navigation

- Playback still highlights the active caption, but automatic following only scrolls when the row leaves a generous tracking band.
- Scrolling the caption list, touching it, or focusing caption text automatically pauses follow mode so the interface never fights the user.
- Added a persistent **Current** button that jumps to the caption nearest the current video playhead.
- Added an explicit **Following / Follow** toggle and the `J` keyboard shortcut for jumping to the playhead.
- Deleting, splitting, or merging a caption preserves the visible scroll position and keeps selection on the nearest surviving row.
- Removed the stale-selection behavior that could resolve a deleted caption to row 1 and snap the list back to the top.

### Khmer-aware display spacing

- New generations detect English-style word-by-word spacing inside Khmer runs.
- Real acoustic pauses can still retain phrase-level Khmer spaces; Latin terms, model names, numbers, and mixed-script content keep their required spaces.
- Manual **Merge** no longer inserts an artificial space between adjacent Khmer text.
- Added **Clean Khmer spacing** for existing projects. It preserves caption timestamps and wording, changes only spacing/punctuation cleanup, and does not create Correction Inbox noise.

## Refined Sthang Studio lockup

The parent wordmark and product name now use an intentional split lockup:

```text
STHANG  /  STUDIO
```

A restrained, forward-slanted divider ties the upright product name to the italic parent wordmark. `STUDIO` is optically baseline-aligned instead of floating beside the logo. The same hierarchy is carried into the compact project header.

## Current workspace: Captions

Sthang Studio currently ships with its **Captions** workspace, which turns Khmer video/audio into editable, CapCut-ready captions with:

- Gemini for context-aware Khmer + English transcription;
- KFA for local Khmer forced alignment and stable word timing;
- faster-whisper as a local fallback;
- TikTok-style regrouping and UTF-8 SRT export for CapCut;
- correction memory, targeted review, selective regeneration, and profile transfer.

Google Cloud Speech-to-Text is **not** used by the automatic timing pipeline.

## Brand architecture

```text
STHANG
└── Sthang Studio
    └── Captions (current workspace)
```

The supplied assets use the parent **STHANG** wordmark and a new Studio-specific **S-frame** mark. The ACO falcon/eagle remains exclusive to Sthang ACO and is not reused here.

Brand assets are stored under:

```text
apps/web/public/brand/
```

The desktop installer creates a **Sthang Studio** shortcut using the new icon. `STOP-STHANG-STUDIO.bat` safely clears stale local ports; the older stop filename remains only as a compatibility alias.

## The pipeline

```text
video/audio
    |
    v
FFmpeg -> cached 16 kHz mono WAV
    |
    +-------------------------------+
    |                               |
    v                               |
Gemini 3.7 Flash                    |
what was said                       |
    |                               |
    v                               |
KFA Khmer Forced Aligner (LOCAL) <--+
when each word was said
    |
    v
canonical timed tokens
    |
Dynamic / Word / Phrase / Line
    |
    v
review + edit -> UTF-8 SRT -> CapCut
```

Gemini owns the wording. KFA owns the timing. Caption modes only group existing timed tokens, so changing rhythm does not create progressive drift.

---

## New in v0.5

### 1. Automatic Correction Events

Edit an incorrect caption normally. When the field loses focus—or when you Save or Export—the app automatically records:

```text
Spoken evidence: exact audio range
Got:              GPT-4o Mini
Expected:         GPT 5.6 Luna
Project:          your video
Time:             0:24.2–0:26.1
Nearby context:   captions before/after
```

Open **Corrections** to replay the exact spoken audio, copy a clean report, and decide what the app should remember.

The memory logic is intentionally conservative:

- `ថេរ៉ា -> Terra` can safely become `Terra | ថេរ៉ា`.
- `GPT-4o Mini -> GPT 5.6 Luna` does **not** become a global replacement. The app protects `GPT 5.6 Luna` as an expected entity instead.

Available decisions:

- **Remember globally** — add the safe vocabulary rule to future projects.
- **This project only** — add it only to the source project's glossary.
- **Ignore** — keep the edit but do not teach the glossary.

### 2. Correction Inbox

The Inbox provides:

- Pending and history views.
- Got / Expected comparison.
- Exact timestamp and nearby context.
- One-click spoken-audio replay.
- Copyable correction reports.
- Suggested safe glossary rules.

Profile export also carries the correction history/rules to another PC.

### 3. Risk Review Mode

Click **Review** to show captions that deserve attention, including:

- weak/interpolated timing;
- unusually fast or short captions;
- overlaps or duplicates;
- Khmer + English code-switching;
- model names, acronyms, versions, and numbers;
- aliases that probably should display as their canonical spelling.

The app calculates an **export readiness** score and warns before export when meaningful issues remain.

Review shortcuts:

```text
Space       Play / pause
R           Replay selected caption/range
E           Edit selected caption
Up/Down     Previous / next risky caption
Alt+Left    Nudge selected caption(s) 50 ms earlier
Alt+Right   Nudge selected caption(s) 50 ms later
Ctrl+S      Save
Enter       Save and advance during Review
```

Audio can auto-loop around the selected caption with configurable pre-roll and post-roll.

### 4. Selective Range Regeneration

Click a caption, then **Shift-click** another caption to select a range. Choose:

```text
Regenerate selected only
```

The app:

1. reuses the cached normalized audio;
2. extracts only the selected range plus a small context margin;
3. runs Gemini + KFA only for that audio;
4. replaces only the selected timed tokens/captions;
5. preserves captions and manual edits outside the selection.

This is useful when one five-second phrase is wrong and the rest of the video is already good.

### 5. Real Pipeline Checkpoints

The app now stores local stage checkpoints:

```text
normalized audio
Gemini transcript stage
local KFA/Whisper timing stage
```

If Gemini succeeded but timing failed, retrying the unfinished project can resume from the saved Gemini stage. If both AI stages completed but a later step failed, both can be reused. A deliberate **Regenerate full video** forces a fresh run.

Replacing project media invalidates the old cache automatically.

### 6. Transferable Profile + Topic Packs

Open **Settings → Profile** to manage or transfer:

- global protected vocabulary;
- approved correction rules;
- correction history;
- My TikTok Style;
- review preferences;
- reusable topic packs.

A topic pack stores context + vocabulary, for example:

```text
AI / Coding
Crypto / NFT
Port & Logistics
Skincare
Motorcycles
```

Use **Export profile** on one PC and **Import profile** on another. The profile JSON does not contain your Gemini API key.

### 7. System Setup Doctor

The Doctor checks:

- Node.js;
- FFmpeg and FFprobe;
- Python timing runtime;
- KFA;
- ONNX Runtime;
- cached Khmer KFA model;
- local Whisper fallback;
- Gemini API key presence (value hidden);
- writable upload/cache/data folders;
- Khmer `Intl.Segmenter` support.

Use **Copy diagnostic report** to share a compact report without exposing the API key.

### 8. Windows convenience

- `INSTALL-NEW-PC.bat` checks/installs Node.js LTS, Python 3.12, and FFmpeg through WinGet, sets up npm/Python/KFA, preloads the Khmer model, and creates a desktop shortcut. Gemini is connected from **Settings → AI connection** after launch.
- `run-windows.bat` opens the app automatically.
- The launcher now kills its complete child-process tree on exit, reducing stale Vite/Node port processes.
- `STOP-STHANG-STUDIO.bat` safely clears ports 8787 and 5188 after confirmation when an older process was left behind.

---

## Upgrade an existing working installation

1. Close the old caption-app terminal.
2. Make a quick backup of the project folder.
3. Extract the v0.7.10 ZIP directly over the existing folder and replace matching files.
4. Run `run-windows.bat`.

No new Python package or model is required compared with a working v0.6.x/KFA installation. Existing Node dependencies are compatible; run `setup-windows.bat` only if the launcher reports that dependencies are missing. On first launch, the app creates/updates a **Sthang Studio** desktop shortcut and removes the old shortcut only when it points to this same installation.

The release archive intentionally excludes:

```text
apps/server/.env
data/projects.json
data/profile.json
data/cache/
data/history/
data/proposals/
data/jobs.json
node_modules/
.venv/
uploaded media
exported SRT files
```

Therefore extracting over an existing installation does not bundle or overwrite your API key, projects, profile, local model environment, uploads, or exports.

If the app reports missing Node dependencies, run `setup-windows.bat` once.

---

## Fast installation on another Windows PC

Extract the ZIP anywhere, for example:

```text
C:\Users\<you>\Desktop\Sthang-Studio
```

Then double-click:

```text
INSTALL-NEW-PC.bat
```

The installer will:

1. check/install Node.js LTS;
2. check/install Python 3.12;
3. check/install FFmpeg;
4. install Node dependencies;
5. create the local Python environment;
6. install KFA + the local Whisper fallback;
7. download/cache the KFA Khmer ONNX model once (about 360 MB);
8. create a **Sthang Studio** desktop shortcut;
9. open the app, where **Settings → AI connection** handles the Gemini key.

Afterward, use the desktop shortcut or double-click:

```text
run-windows.bat
```

The app opens at:

```text
http://localhost:5188
```

If an old instance owns the ports, close its terminal or run:

```text
STOP-STHANG-STUDIO.bat
```

---

## Manual setup

Requirements:

- Node.js LTS;
- Python 3.12 64-bit (tested: 3.12.10);
- FFmpeg + FFprobe on `PATH`;
- Gemini API key;
- internet access for Gemini and one-time package/model downloads.

Run:

```text
setup-windows.bat
```

Then run the app and open:

```text
Settings → AI connection
```

Paste the Gemini API key and choose **Save & connect**. The optional `apps\server\.env` route remains available for administrators or scripted deployments, but casual users do not need it.

Finally run (or use the desktop shortcut):

```text
run-windows.bat
```

---

## Accuracy context and protected vocabulary

For a GPT video, use a compact topic description such as:

```text
This video discusses GPT 5.6 models. Luna and Terra are GPT 5.6 variants.
The speaker switches between Khmer and English. Preserve exact model names.
```

Protected vocabulary:

```text
GPT 5.6 Luna
GPT 5.6 Terra
Terra | ថេរ៉ា
Luna | លូណា
OpenAI
CapCut
```

Vocabulary syntax:

```text
Canonical display form | possible alias | phonetic/transcribed alias
```

Do not add unrelated entities as aliases. For example, do not map `GPT-4o Mini` as an alias of `GPT 5.6 Luna`.

---

## Main configuration

Advanced configuration can still be supplied through `apps/server/.env`. Settings saved inside the app take priority for the API key and selected Gemini models:

```env
# Optional advanced/server fallback. Normal users configure these in the app.
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.7-flash
GEMINI_FALLBACK_MODEL=gemini-3.6-flash
GEMINI_MAX_RETRIES=2
GEMINI_RETRY_BASE_MS=1000
GEMINI_RETRY_MAX_MS=60000
GEMINI_NATIVE_VOCABULARY_BIAS=true

LOCAL_KFA_ENABLED=true
LOCAL_WHISPER_FALLBACK_ENABLED=true
LOCAL_WHISPER_MODEL=turbo
LOCAL_WHISPER_DEVICE=auto
LOCAL_WHISPER_COMPUTE_TYPE=auto
LOCAL_WHISPER_LANGUAGE=km

PORT=8787
WEB_ORIGIN=http://localhost:5188
MAX_UPLOAD_MB=500
RANGE_CONTEXT_PADDING_MS=1200
```

No paid cloud timing provider is wired into the automatic fallback chain.

---

## Recommended v0.7.10 verification

1. Open **Review** on a flagged caption and play it once. Confirm the first pass includes normal surrounding context, then confirm the next automatic loop is tight around the selected caption.
2. Press **Replay** and confirm it starts almost immediately at the selected caption rather than replaying the full context lead-in.
3. Open the advanced Review controls and use **Play with context**; confirm the longer context pass returns for that pass only.
4. Edit caption text, leave the field, and confirm Review immediately replays the selected caption with the tight focus pass.
5. Hover the main editor controls, timing-quality indicator, regeneration actions, and waveform controls; confirm tooltips are short and do not expose KFA/Gemini/Whisper/model architecture.
6. Open an existing project and confirm captions, timing, correction history, glossary data, and branding remain available.
7. Open **Precision timeline**, zoom in, drag one unlocked caption boundary, and test word/silence snapping.
8. Approve a caption, lock its text or timing, then build a regeneration preview and confirm the lock is preserved.
9. Press `Ctrl+F`, preview a scoped correction, and verify text-locked matches are skipped.
10. Open **Review**, select a QA profile, run **Fix safe timing**, then inspect/restore the checkpoint from **History**.
11. Queue a regeneration, refresh the browser, and confirm **Jobs** continues showing its stage and result.
12. Export SRT once and import it into CapCut to confirm the normal handoff remains unchanged.
13. Open **Settings → AI connection**, verify **Save & connect**, then run **System check** and confirm the engine reports v0.7.10.
