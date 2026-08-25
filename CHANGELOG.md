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
- Added a no-WinGet prerequisite fallback for clean Windows installs, including direct per-user Node.js/Python setup, a pinned FFmpeg 8.1.2 GitHub Release download with SHA-256 verification, visible download progress/timeouts, and clearer recovery messages.
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
