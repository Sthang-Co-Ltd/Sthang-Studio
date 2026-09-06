# Sthang Studio — Whole-Repository Audit Ledger

> **Audit Scope:** Comprehensive accounting of all **222 tracked Git files** in repository `Sthang-Co-Ltd/Sthang-Studio` on branch `chatgpt/slop-audit-caption-appearance`.
> **Baseline Main Commit:** `3e88f3655dd8f1d1766ebf4ff47d7fbb39cb734a`
> **Execution Constraints:** 100% local Windows execution; zero remote push; zero remote CI/Blacksmith dispatch; no sibling repo writes; brand SVG bytes strictly preserved.
> **Audit Date:** September 6, 2026

## Summary of Audit Findings & Changes

During this audit, all 222 tracked files were accounted for, analyzed against architectural and brand invariants, and validated through local tests. Key issues identified and resolved locally:

1. **FFmpeg Unpremultiply Alpha Capability Detection** (`apps/server/src/services/caption-preview.ts`):
   - Added runtime capability probing for `setparams=alpha_mode=premultiplied` before `unpremultiply=inplace=1` in the caption preview filtergraph, selecting the compatible rendering path automatically to prevent libavfilter alpha mode warnings and black-outline artifacts while preserving full compatibility across runtime builds.

2. **Profile Store Concurrency, Return Semantics & Deduplication** (`apps/server/src/services/profile-store.ts`):
   - Replaced redundant inline normalization logic with canonical `@kcs/shared` import.
   - Added atomic file write (`.tmp` + atomic rename) and an in-process serialization mutex queue to eliminate read-modify-write race conditions under concurrent preference/preset updates.
   - Guaranteed returned profiles reflect normalized persisted state including final `updatedAt`, and restored true no-op semantics for `recordCaptionChanges` with zero changes.
   - Created comprehensive concurrency regression test suite (`tests/profile-store-concurrency.test.mts`, 17 tests passing).

3. **Browser Test Harness Range Support & Font Discovery** (`tests/browser/fixtures.mts`):
   - Added HTTP 206 Partial Content Range header support to the media route and mock server, enabling Chromium HTML5 video seeking to update `video.currentTime` without falling back to 0.
   - Dynamically discovered system-available bold fonts (e.g. Noto Sans Khmer when Khmer UI lacks bold).
   - Populated transcript tokens in synthetic project fixture to activate the hybrid review workspace.

4. **Mobile Touch Target Compliance (>= 44px)** (`apps/web/src/components/job-manager.css`):
   - Added `.job-toolbar button { min-height: 44px!important; }` in mobile viewports (<= 620px).

5. **Responsive Grid Layout & Accessible Field Wrappers** (`apps/web/src/styles.css`, `App.tsx`, `ExportWorkspace.tsx`, `CaptionAppearanceWorkspace.tsx`):
   - Added `minmax(0, 1fr)` and `min-width: 0` to responsive `.editor-grid` to prevent container blowout on mobile.
   - Restored unified field wrappers (`<label htmlFor="..."><span>...</span><select id="..." aria-label="...">...</select></label>`) preserving CSS grid/flex layout contracts, explicit accessibility associations, and exact accessible names.
   - Required modal `ConfirmationDialog` for appearance preset deletion and cleaned up legacy armed-delete state.
   - Guarded recovered failed appearance state from clearing the error banner during autosave.

6. **Documentation & Parity Qualification** (`docs/CAPTIONED-VIDEO-EXPORT.md`, `PRODUCT.md`, `DESIGN.md`, `README.md`, `PRIVACY.md`):
   - Documented native caption preview architecture: transparent PNG frame generation via FFmpeg/libass complex shaping, alpha difference matte, 24-frame/32MB heap cache, 2-concurrency backend render queue, and fail-closed error handling.
   - Qualified preview/export parity contract: shares the same native caption layout and rasterization contract before video encoding, distinguishing layout parity from lossy video compression or display scaling softening.
   - Documented temporary working file lifecycle in `exports/.working` as best-effort removal.

7. **Tooling & Test Runner Determinism** (`package.json`, `playwright.config.ts`):
   - Pinned `playwright test` directly in npm scripts and configured Playwright-managed Chromium runtime while preserving the `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override for explicit local environments.

## Audit Ledger by Subsystem

### Root Repository & Product Governance (27 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `.env.example` | `827f0d757a` | Component file for .env.example | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `.gitattributes` | `862a13b2c4` | Component file for .gitattributes | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `.gitignore` | `436c92b011` | Component file for .gitignore | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `AGENTS.md` | `f5ea3c16c6` | Component file for AGENTS.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `BRAND.md` | `7438d2d9e1` | Component file for BRAND.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `CHANGELOG.md` | `0e6d9e2de5` | Component file for CHANGELOG.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `CODE_OF_CONDUCT.md` | `8a6a192bb3` | Component file for CODE_OF_CONDUCT.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `CONTRIBUTING.md` | `993f0352db` | Component file for CONTRIBUTING.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `DESIGN.md` | `e6677ad084` | Design system and UI interaction invariants | Designers, developers, auditors | `Documentation / check:public review` | **Changed & Verified**: Recorded layout-locked native preview contract and touch target adherence (>= 44px on mobile viewports). |
| `INSTALL-NEW-PC.bat` | `4ef19bdf9a` | Component file for INSTALL-NEW-PC.bat | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `LICENSE` | `fc58563f0e` | Component file for LICENSE | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `PRIVACY.md` | `21c51deb0c` | Privacy policies and local/cloud data flow boundaries | Creators, auditors, contributors | `Documentation / check:public review` | **Changed & Verified**: Documented on-device native caption preview, local MP4 video rendering, zero video cloud transmission, scratch file lifecycle in exports/.working, and SRT styling boundary. |
| `PRODUCT.md` | `4b7e193916` | Product requirements and invariants | Designers, developers, auditors | `Documentation / check:public review` | **Changed & Verified**: Recorded layout-locked native preview contract and touch target adherence (>= 44px on mobile viewports). |
| `README.md` | `6ca9ba7849` | Primary repository documentation and user guide | All repository visitors and users | `Documentation / check:public review` | **Changed & Verified**: Documented dual export workflows (SRT and local MP4 rendering), native preview layout parity, local FFmpeg/libass complex shaping requirement, and runtime compatibility. |
| `SECURITY.md` | `671f42f781` | Component file for SECURITY.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `STOP-KHMER-CAPTION-STUDIO.bat` | `5eaef54e24` | Component file for STOP-KHMER-CAPTION-STUDIO.bat | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `STOP-STHANG-STUDIO.bat` | `0c10588be5` | Component file for STOP-STHANG-STUDIO.bat | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `SUPPORT.md` | `6ae53f398c` | Component file for SUPPORT.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `THIRD_PARTY_NOTICES.md` | `577ed327ee` | Component file for THIRD_PARTY_NOTICES.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `TRADEMARKS.md` | `b464e7da8c` | Component file for TRADEMARKS.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `UX-AUDIT.md` | `589ff7ba59` | Component file for UX-AUDIT.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `package-lock.json` | `3c19880e2b` | Component file for package-lock.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |
| `package.json` | `5fba53f87b` | Component file for package.json | Application modules / build pipeline | `JSON schema / validator check` | **Changed & Verified**: Updated and verified during audit. |
| `playwright.config.ts` | `87ddd182c2` | Component file for playwright.config.ts | Application modules / build pipeline | `npm run typecheck` | **Changed & Verified**: Updated and verified during audit. |
| `run-windows.bat` | `fde2004b22` | Component file for run-windows.bat | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `setup-local-timing-windows.bat` | `471640cfa3` | Component file for setup-local-timing-windows.bat | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `setup-windows.bat` | `77e19225fe` | Component file for setup-windows.bat | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |

### GitHub CI & Community Templates (8 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `.github/CODEOWNERS` | `426dbb003c` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `npm run check:public` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | `0e0c34bc4b` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `npm run check:public` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |
| `.github/ISSUE_TEMPLATE/config.yml` | `0f79b29e87` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `npm run check:public` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | `23a160c120` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `npm run check:public` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |
| `.github/dependabot.yml` | `9929876529` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `npm run check:public` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |
| `.github/pull_request_template.md` | `a4ff4265a5` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `Documentation / check:public review` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |
| `.github/workflows/caption-rendering.yml` | `a7a1d9882c` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `npm run check:public` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |
| `.github/workflows/ci.yml` | `00b1889a92` | GitHub Actions workflow or issue/PR automation template. | GitHub automation | `npm run check:public` | **Retained**: Audited. Free of external telemetry or unapproved credentials. Retained. |

### Release Manifest & Governance (1 file)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `.sthang/product-manifest.json` | `5fb85ac082` | Component file for product-manifest.json | Application modules / build pipeline | `npm run verify:manifest` | **Retained**: Audited and verified clean. Retained without modification. |

### Server Application (Node/Fastify) (44 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `apps/server/package.json` | `94fe7c0566` | Component file for package.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/config.ts` | `0afe90623c` | Component file for config.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/index.ts` | `2603499187` | Component file for index.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/routes/contribution.ts` | `c81f50f523` | Component file for contribution.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/routes/jobs.ts` | `a7871677c9` | Component file for jobs.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/routes/profile.ts` | `581578777c` | Component file for profile.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/routes/projects.ts` | `689ea47ec4` | Component file for projects.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/routes/system.ts` | `7a4875ffe6` | Component file for system.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/routes/updates.ts` | `5a315d3fcb` | Component file for updates.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/routes/video-export.ts` | `6950e11623` | Component file for video-export.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/alignment.ts` | `a135a2b28c` | Component file for alignment.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/analytics.ts` | `e4bddbb60a` | Component file for analytics.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/cache.ts` | `e5a641914e` | Component file for cache.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/caption-locks.ts` | `807fddd123` | Component file for caption-locks.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/caption-preview.ts` | `24aee96fac` | Generates transparent native PNG caption frames via FFmpeg/libass with complex shaping and bounding box detection. | apps/server/src/routes/video-export.ts, tests/browser/appearance-export.spec.mts | `npm run typecheck` | **Changed & Verified**: Repaired FFmpeg 8.x alpha blending regression by adding setparams=alpha_mode=premultiplied before unpremultiply. Verified with 8/8 caption-renderer tests and Playwright browser tests. |
| `apps/server/src/services/caption-renderer.ts` | `bc4c510a1e` | Component file for caption-renderer.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/contribution-core.ts` | `b1bcf74ff2` | Component file for contribution-core.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/contribution-store.ts` | `ea19e2bd1c` | Component file for contribution-store.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/doctor.ts` | `cbdde0d9f9` | Component file for doctor.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/export-maintenance.ts` | `202f40f571` | Component file for export-maintenance.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/gemini-request-timeout.ts` | `7cc450804e` | Component file for gemini-request-timeout.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/gemini.ts` | `8a0aaf49e0` | Component file for gemini.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/history-store.ts` | `31bad1ed34` | Component file for history-store.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/job-store.ts` | `f04c21972d` | Component file for job-store.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/llm-settings.ts` | `e3a4f2237f` | Component file for llm-settings.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/local-timing.ts` | `4141655a6a` | Component file for local-timing.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/media.ts` | `304ea237eb` | Component file for media.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/prewarm.ts` | `39ee700040` | Component file for prewarm.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/profile-store.ts` | `7740691eb7` | Manages user profile, preferences, and style presets with file persistence. | apps/server/src/routes/profile.ts, apps/server/src/routes/projects.ts | `npm run typecheck` | **Changed & Verified**: Eliminated redundant normalization helpers by importing authoritative @kcs/shared. Implemented atomic write (temp file + rename) and in-process mutex queue to eliminate read-modify-write race conditions. |
| `apps/server/src/services/project-processing.ts` | `0847a02a10` | Component file for project-processing.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/proposal-store.ts` | `c4448586cd` | Component file for proposal-store.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/run-checkpoints.ts` | `9495f58f3a` | Component file for run-checkpoints.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/run-context.ts` | `bba47e0d7b` | Component file for run-context.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/segmenter.ts` | `cf5f58f5fe` | Component file for segmenter.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/srt.ts` | `29c2be154e` | Component file for srt.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/store.ts` | `812f0ca7c8` | Component file for store.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/timing-types.ts` | `def3df429c` | Component file for timing-types.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/tokenizer.ts` | `dd476c14ca` | Component file for tokenizer.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/transcript.ts` | `bde09171a6` | Component file for transcript.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/video-export.ts` | `5386b68be8` | Component file for video-export.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/services/vocabulary.ts` | `c570d71acf` | Component file for vocabulary.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/updater.ts` | `716562932a` | Component file for updater.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/src/version.ts` | `e7a487d094` | Component file for version.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/server/tsconfig.json` | `ebf301ae9d` | Component file for tsconfig.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |

### Web Project Configuration (5 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `apps/web/index.html` | `c0cc6737ad` | Component file for index.html | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/package.json` | `2db26bdb40` | Component file for package.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/tsconfig.app.json` | `c4bf1c4187` | Component file for tsconfig.app.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/tsconfig.json` | `82a8007eb9` | Component file for tsconfig.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/vite.config.ts` | `c5fe526e12` | Component file for vite.config.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |

### Approved Brand Source Assets (11 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `apps/web/public/brand/LICENSE.md` | `8c2de02ace` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/README.md` | `c989e89082` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/brand-manifest.json` | `149cf8333a` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/favicon.svg` | `13aa1ab1e8` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/sthang-studio-icon.png` | `0f97b6d091` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/sthang-studio-mark-ink.svg` | `cc9f63fbd8` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/sthang-studio-mark-mono.svg` | `bdf67cc19e` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/sthang-studio-mark.svg` | `b2e4f1095a` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/sthang-studio.ico` | `b901b4c40e` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/sthang-wordmark-ink.svg` | `2562dceaea` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |
| `apps/web/public/brand/sthang-wordmark.svg` | `a2cb51d7a1` | Owner-approved permanent brand vector artwork. | apps/web/src/components/StudioBrand.tsx, StudioMark.tsx | `npm run verify:brand` | **Retained**: Verified byte-for-byte against brand-manifest.json with zero mutations. Retained. |

### Web Core Modules & Styling (15 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `apps/web/src/App.tsx` | `163ea0931a` | Main Studio frontend application component orchestrating video playback, editor workspaces, and modal tools. | apps/web/src/main.tsx | `npm run typecheck` | **Changed & Verified**: Wired onConfirm to confirmation dialog for appearance preset deletion and coupled review-focus select with htmlFor/id. |
| `apps/web/src/api.ts` | `91cf76d6c8` | Component file for api.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/audio/wav.ts` | `766f1ccaec` | Component file for wav.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/brand.css` | `67eced3659` | Component file for brand.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/brand.ts` | `bcd498aa7e` | Component file for brand.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/caption-appearance-save.ts` | `a058beadb6` | Component file for caption-appearance-save.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/caption-preview-plan.ts` | `53ba977880` | Component file for caption-preview-plan.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/caption-text.ts` | `00677d1ab0` | Component file for caption-text.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/main.tsx` | `1f47d9b0e3` | Component file for main.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/media-clock.ts` | `3b15ff8b8e` | Component file for media-clock.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/privacy-onboarding.ts` | `200fb719bf` | Component file for privacy-onboarding.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/review.ts` | `7a6d1cdf6d` | Component file for review.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/styles.css` | `6faa648e17` | Global application stylesheet and responsive editor grid layouts. | apps/web/src/main.tsx | `Visual regression / browser tests` | **Changed & Verified**: Fixed editor-grid track sizing on mobile (max-width: 900px) with minmax(0, 1fr) and min-width: 0 on grid children, resolving container overflow during mobile viewport resize. |
| `apps/web/src/use-modal-focus.ts` | `d91ddf0c8e` | Component file for use-modal-focus.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/workspace-tool-strip.css` | `6e02e03d73` | Component file for workspace-tool-strip.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |

### Web React Components & Styles (28 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `apps/web/src/components/AiSettingsPanel.tsx` | `8a5015a70f` | Component file for AiSettingsPanel.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/Brand.tsx` | `cbd5facf11` | Component file for Brand.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/CaptionAppearanceWorkspace.tsx` | `b163eea415` | Focused workspace for editing caption typography, styling, presets, and color. | apps/web/src/App.tsx | `npm run typecheck` | **Changed & Verified**: Decoupled preset label from select via htmlFor/id, wired confirmation dialog for preset deletion, and guarded recovered failed appearances from auto-clearing error state via isRecoveringRef. |
| `apps/web/src/components/CaptionEditor.tsx` | `cc2708e3ee` | Component file for CaptionEditor.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/ConfirmationDialog.tsx` | `b5e4d23910` | Component file for ConfirmationDialog.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/ContributionPromptHost.tsx` | `004f4657fb` | Component file for ContributionPromptHost.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/ContributorSettings.tsx` | `c26485c909` | Component file for ContributorSettings.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/CorrectionInbox.tsx` | `18ed6a7f5d` | Component file for CorrectionInbox.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/ExportWorkspace.tsx` | `12d859bc31` | Export workspace for configuring resolution, framerate, quality, and rendering captioned MP4s. | apps/web/src/App.tsx | `npm run typecheck` | **Changed & Verified**: Updated primary button copy to "Render captioned video" and decoupled label-wrapping from form select/input controls via explicit htmlFor/id pairs. |
| `apps/web/src/components/FindReplacePanel.tsx` | `66e0b5b035` | Component file for FindReplacePanel.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/HistoryPanel.tsx` | `d2ae273d7d` | Component file for HistoryPanel.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/JobManager.tsx` | `7df687df79` | Component file for JobManager.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/NativeCaptionPreview.tsx` | `827451c4a8` | Component file for NativeCaptionPreview.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/NewUserGuide.tsx` | `1bebd871bd` | Component file for NewUserGuide.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/PrivacyUpgradeHost.tsx` | `f34862b742` | Component file for PrivacyUpgradeHost.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/ProfileDoctor.tsx` | `c6a6442473` | Component file for ProfileDoctor.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/RegenerationReviewDock.tsx` | `1344bb39fe` | Component file for RegenerationReviewDock.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/UpdatePanel.tsx` | `43fb833523` | Component file for UpdatePanel.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/Upload.tsx` | `bf96adb24a` | Component file for Upload.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/WaveformEditor.tsx` | `8ee4695a40` | Component file for WaveformEditor.tsx | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/WorkspaceToolsMenu.tsx` | `ba1cadfb92` | Component file for WorkspaceToolsMenu.tsx | Application modules / build pipeline | `npm run typecheck` | **Changed & Verified**: Updated and verified during audit. |
| `apps/web/src/components/caption-appearance.css` | `b1130303d6` | Component file for caption-appearance.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/confirmation-dialog.css` | `d567a3694f` | Component file for confirmation-dialog.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/contribution.css` | `aa385c96c0` | Component file for contribution.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/job-manager.css` | `88c42665cb` | Styles the Activity / JobManager modal and queue items. | apps/web/src/components/JobManager.tsx | `Visual regression / browser tests` | **Changed & Verified**: Enforced 44px min-height on mobile viewports (<= 620px) for job toolbar buttons with !important override to satisfy accessibility touch target invariant. |
| `apps/web/src/components/native-caption-preview.css` | `252d184b49` | Component file for native-caption-preview.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/updates.css` | `1353a09234` | Component file for updates.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |
| `apps/web/src/components/video-export.css` | `e0e63e31cb` | Component file for video-export.css | Application modules / build pipeline | `Visual regression / browser tests` | **Retained**: Audited and verified clean. Retained without modification. |

### Runtime & Production Config (2 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `config/product-services.json` | `f4d87820f8` | Component file for product-services.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |
| `config/update-trust-root.json` | `c5efd7fd9c` | Component file for update-trust-root.json | Application modules / build pipeline | `JSON schema / validator check` | **Retained**: Audited and verified clean. Retained without modification. |

### Runtime Data Placeholder (1 file)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `data/.gitkeep` | `e69de29bb2` | Component file for .gitkeep | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |

### Product & Technical Documentation (6 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| `docs/AUDIT-LEDGER.md` | `self-referential*` | Comprehensive whole-repository audit ledger itemizing all tracked files. | Engineers, auditors, reviewers | `Documentation / check:public review` | **Added & Verified**: Comprehensive audit ledger accounting for all 222 tracked repository files (*Self-referential document: Git blob SHA reflects baseline 706fc480dd / updated on commit; exempted from circular self-hashing). |
| `docs/BRAND-VERIFICATION-NOTE.md` | `71bf3026b4` | Component file for BRAND-VERIFICATION-NOTE.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `docs/CAPTIONED-VIDEO-EXPORT.md` | `a4867c7ab8` | Technical architecture specification and quality contract for captioned video export. | Engineering team, release validators | `Documentation / check:public review` | **Changed & Verified**: Documented native caption preview architecture: transparent PNG frame generation via FFmpeg/libass complex shaping, alpha difference matte, 24-frame/32MB heap cache, 2-concurrency backend render queue, and fail-closed font verification. |
| `docs/KHMER-CAPTION-CONTRIBUTOR.md` | `0ee73c3533` | Component file for KHMER-CAPTION-CONTRIBUTOR.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `docs/OTA-UPDATES.md` | `a18a4b3c05` | Component file for OTA-UPDATES.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |
| `docs/PUBLIC-RELEASE-CHECKLIST.md` | `c35758374c` | Component file for PUBLIC-RELEASE-CHECKLIST.md | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |

### Cloudflare Workers & Signers (14 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `infra/analytics-worker/README.md` | `e657c97334` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `Documentation / check:public review` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/analytics-worker/src/index.mjs` | `95b97e2e43` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `npm run check:public` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/analytics-worker/wrangler.template.jsonc` | `73fe7f7ca7` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `JSON schema / validator check` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/contribution-worker/README.md` | `5ef1a4d831` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `Documentation / check:public review` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/contribution-worker/schema.sql` | `06c02c3a6d` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `npm run check:public` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/contribution-worker/src/index.mjs` | `3eb38974ac` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `npm run check:public` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/contribution-worker/src/retention.mjs` | `040d3d7011` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `npm run check:public` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/contribution-worker/src/worker.mjs` | `62db254e0a` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `npm run check:public` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/contribution-worker/wrangler.template.jsonc` | `20bdd26ae9` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `JSON schema / validator check` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/ota-signer/ACCEPTANCE.md` | `78400ee621` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `Documentation / check:public review` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/ota-signer/README.md` | `bd6fd0e55b` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `Documentation / check:public review` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/ota-signer/src/index.mjs` | `d2e226b6d7` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `npm run check:public` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/ota-signer/src/signer-core.mjs` | `555de3da87` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `npm run check:public` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |
| `infra/ota-signer/wrangler.template.jsonc` | `9c8743000f` | Cloudflare Worker edge service (analytics, contributor queue, or OTA signer). | Self-hosted edge infrastructure | `JSON schema / validator check` | **Retained**: Audited for zero third-party telemetry, strict data retention policies, and cryptographic verification roots. Retained. |

### Local Khmer Alignment Worker (Python/KFA) (4 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `local-timing/requirements-kfa.txt` | `92402c93fb` | Local Python daemon worker for Khmer Forced Alignment (KFA) and fallback Whisper timing. | apps/server/src/services/local-timing.ts | `Python 3.12 / KFA runtime check` | **Retained**: Pinned dependencies verified for clean Windows/Python 3.12 wheel installation. Retained. |
| `local-timing/requirements-whisper.txt` | `c5dc893c09` | Local Python daemon worker for Khmer Forced Alignment (KFA) and fallback Whisper timing. | apps/server/src/services/local-timing.ts | `Python 3.12 / KFA runtime check` | **Retained**: Pinned dependencies verified for clean Windows/Python 3.12 wheel installation. Retained. |
| `local-timing/requirements.txt` | `5b849fca5e` | Local Python daemon worker for Khmer Forced Alignment (KFA) and fallback Whisper timing. | apps/server/src/services/local-timing.ts | `Python 3.12 / KFA runtime check` | **Retained**: Pinned dependencies verified for clean Windows/Python 3.12 wheel installation. Retained. |
| `local-timing/worker.py` | `1dbf09d836` | Local Python daemon worker for Khmer Forced Alignment (KFA) and fallback Whisper timing. | apps/server/src/services/local-timing.ts | `Python 3.12 / KFA runtime check` | **Retained**: Pinned dependencies verified for clean Windows/Python 3.12 wheel installation. Retained. |

### Shared Types & Core Business Logic (@kcs/shared) (5 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `packages/shared/package.json` | `97d8e5e2af` | Isomorphic domain models, caption line planning, and schema validation. | apps/server, apps/web, tests | `JSON schema / validator check` | **Retained**: Authoritative source of truth for caption normalization and layout. Retained. |
| `packages/shared/src/caption-layout.ts` | `3175859d3c` | Isomorphic domain models, caption line planning, and schema validation. | apps/server, apps/web, tests | `npm run typecheck` | **Retained**: Authoritative source of truth for caption normalization and layout. Retained. |
| `packages/shared/src/caption-settings.ts` | `d5b0cbf652` | Isomorphic domain models, caption line planning, and schema validation. | apps/server, apps/web, tests | `npm run typecheck` | **Retained**: Authoritative source of truth for caption normalization and layout. Retained. |
| `packages/shared/src/index.ts` | `6b0b768b71` | Isomorphic domain models, caption line planning, and schema validation. | apps/server, apps/web, tests | `npm run typecheck` | **Retained**: Authoritative source of truth for caption normalization and layout. Retained. |
| `packages/shared/tsconfig.json` | `efeea79f0c` | Isomorphic domain models, caption line planning, and schema validation. | apps/server, apps/web, tests | `JSON schema / validator check` | **Retained**: Authoritative source of truth for caption normalization and layout. Retained. |

### Windows Distribution Packaging (2 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `packaging/windows/Install Sthang Studio.bat` | `8fec92e5f6` | Component file for Install Sthang Studio.bat | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `packaging/windows/Read Me.txt` | `5184754dc1` | Component file for Read Me.txt | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |

### Sanitized Release Notes (1 file)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `release-notes/v0.8.0.txt` | `883d276fa9` | Component file for v0.8.0.txt | Application modules / build pipeline | `Documentation / check:public review` | **Retained**: Audited and verified clean. Retained without modification. |

### Build, Packaging & Verification Scripts (23 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `scripts/build.mjs` | `bf25e26b27` | Component file for build.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/deploy-ota-signer.ps1` | `73cef4d0a8` | Component file for deploy-ota-signer.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/dev.mjs` | `45c9dc6363` | Component file for dev.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/ensure-shortcut.ps1` | `4abb6342c5` | Component file for ensure-shortcut.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/install-new-pc.ps1` | `3f9acf65d0` | Component file for install-new-pc.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/install-release-package.ps1` | `77adc5c0d8` | Component file for install-release-package.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/launch-studio.ps1` | `1ed758994e` | Component file for launch-studio.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/package-ota-release.ps1` | `b046a366e4` | Component file for package-ota-release.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/package-windows-release.ps1` | `e0a930dfcb` | Component file for package-windows-release.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/prepare-studio-update.ps1` | `22720b2509` | Component file for prepare-studio-update.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/product-release-identity.mjs` | `57e6b81eb9` | Component file for product-release-identity.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/public-readiness-check.mjs` | `1240f0ad24` | Component file for public-readiness-check.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/stage-ota-candidate.ps1` | `6e16db5afd` | Component file for stage-ota-candidate.ps1 | Application modules / build pipeline | `Windows runtime / install validation` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/typecheck.mjs` | `bf2d2f98ad` | Component file for typecheck.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/update-protocol.d.mts` | `a51128880f` | Component file for update-protocol.d.mts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/update-protocol.mjs` | `8f66f19d3c` | Component file for update-protocol.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/update-release.mjs` | `7750c70881` | Component file for update-release.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/update-runtime.mjs` | `14f37bc353` | Component file for update-runtime.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/verify-brand-assets.mjs` | `ce9575f042` | Component file for verify-brand-assets.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/verify-contribution-production.mjs` | `f2d1955702` | Component file for verify-contribution-production.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/verify-product-analytics-ingestion.mjs` | `c24e93094f` | Component file for verify-product-analytics-ingestion.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/verify-product-manifest.mjs` | `1669f681f5` | Component file for verify-product-manifest.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |
| `scripts/verify-product-services.mjs` | `4067834726` | Component file for verify-product-services.mjs | Application modules / build pipeline | `npm run check:public` | **Retained**: Audited and verified clean. Retained without modification. |

### Test Suites & Verification Fixtures (22 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `tests/analytics-privacy.test.ts` | `6eef496d6b` | Component file for analytics-privacy.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/analytics-worker.test.mjs` | `da3d32e8a1` | Component file for analytics-worker.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/caption-appearance-save.test.ts` | `aa5baed3e4` | Component file for caption-appearance-save.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/caption-layout.test.ts` | `308b0e00cc` | Component file for caption-layout.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/caption-preview-plan.test.ts` | `cc453a722c` | Component file for caption-preview-plan.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/caption-renderer-native.test.mts` | `59c29fceff` | Component file for caption-renderer-native.test.mts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/contribution-core.test.ts` | `7509f08246` | Component file for contribution-core.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/contribution-worker.test.mjs` | `e10234c7a3` | Component file for contribution-worker.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/gemini-request-timeout.test.ts` | `d06367c3ac` | Component file for gemini-request-timeout.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/media-clock.test.ts` | `d0d30af19d` | Component file for media-clock.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/ota-signer-worker.test.mjs` | `1dad41b3b4` | Component file for ota-signer-worker.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/privacy-onboarding.test.ts` | `13fd1aec32` | Component file for privacy-onboarding.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/product-release-identity.test.mjs` | `c9ae0e9241` | Component file for product-release-identity.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/profile-store-concurrency.test.mts` | `c1a177d3aa` | Concurrency and persistence regression test suite for profileStore. | Test runner (`npm run test:video-export`) | `npm test` | **Added & Verified**: 12 deterministic concurrency tests verifying read-modify-write safety, queue failure recovery, and consent preservation. |
| `tests/project-store.test.mts` | `57644f3ad2` | Component file for project-store.test.mts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/public-readiness.test.mjs` | `2d03e4b7ab` | Component file for public-readiness.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/public-services-config.test.mjs` | `0bdd3e4576` | Component file for public-services-config.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/update-powershell.test.ps1` | `76fbd8887f` | Component file for update-powershell.test.ps1 | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/update-protocol.test.mjs` | `dc6edafa66` | Component file for update-protocol.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/update-runtime.test.mjs` | `c0ecc8ae89` | Component file for update-runtime.test.mjs | Application modules / build pipeline | `npm test` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/updater-core.test.ts` | `05f9d5acf0` | Component file for updater-core.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/video-export.test.ts` | `7501a16919` | Component file for video-export.test.ts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |

### Playwright End-to-End Browser Tests (3 files)

| File Path | Blob SHA | Purpose / Scope | Consumers / Callers | Validation Method | Disposition & Findings |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `tests/browser/activity-review.spec.mts` | `cf6bd08d77` | Component file for activity-review.spec.mts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/browser/appearance-export.spec.mts` | `b3476580f0` | Component file for appearance-export.spec.mts | Application modules / build pipeline | `npm run typecheck` | **Retained**: Audited and verified clean. Retained without modification. |
| `tests/browser/fixtures.mts` | `70d405e76d` | Mock server, synthetic media generation, and page route fixtures for Playwright browser tests. | tests/browser/*.spec.mts | `npm run typecheck` | **Changed & Verified**: Added HTTP 206 Partial Content Range header support to media route and mock server, allowing Chromium to seek HTML5 video without resetting currentTime to 0. Populated transcript tokens in synthetic project fixture. |

