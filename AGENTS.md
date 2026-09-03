# Sthang Studio development invariants

## Approved logo assets

The following owner-approved assets are permanent source-of-truth artwork:

- `apps/web/public/brand/sthang-studio-mark.svg` — white/lime ribbon-S mark for dark surfaces;
- `apps/web/public/brand/sthang-studio-mark-ink.svg` — dark/lime ribbon-S mark for light surfaces;
- `apps/web/public/brand/sthang-studio-mark-mono.svg` — monochrome mark;
- `apps/web/public/brand/sthang-wordmark.svg` — approved white in-house STHANG wordmark;
- `apps/web/public/brand/sthang-wordmark-ink.svg` — approved dark in-house STHANG wordmark.

All source logo/wordmark assets have transparent backgrounds. Never redraw, trace, approximate, simplify, recolour, regenerate, or re-typeset them. Never replace the in-house STHANG wordmark with ordinary text or a substitute font. Use the existing `StudioMark`/`StudioBrand` components and select the correct surface variant.

The preferred product lockup is the ribbon-S mark followed by the in-house STHANG wordmark, a forward-slanted Studio-lime divider, and a restrained widely-tracked `STUDIO` descriptor. `STUDIO` must accompany rather than visually compete with STHANG.

The approved source SVGs are intentionally marked `-text` in `.gitattributes`. Preserve that rule so Git/Windows line-ending conversion does not rewrite their repository bytes. The verifier additionally canonicalizes CRLF to LF for SVG hashing so an older Windows checkout cannot create a false failure; all other content changes must still fail verification.

Before delivering a build, run:

```text
npm run verify:brand
```

A newly owner-approved identity set may replace these files only when `brand-manifest.json`, derived icon assets, `BRAND.md`, and this guidance are updated together.

## Public repository and release invariants

Sthang Studio source code and documentation are published under the repository's software license, while Sthang names and brand assets remain governed separately by `TRADEMARKS.md`.

Preserve these public-release rules:

- Never commit API keys, credentials, private source media, local projects, history, caches, proposals, jobs, exports, downloaded model weights, or local virtual environments.
- Keep `package-lock.json` committed and synchronized with the workspace manifests. CI and the Windows public setup must use `npm ci` so release validation and user installs use the reviewed dependency graph instead of resolving a new one.
- Keep the Windows local-timing setup wheel-first and clean-PC friendly. The supported KFA tokenizer stack is intentionally pinned to `khmercut==0.0.2`, `python-crfsuite==0.9.9`, and `tqdm==4.65.0`; do not move the public installer to a source-only or differently constrained tokenizer stack without a successful clean Windows/Python 3.12 installation test.
- KFA 0.2.0's published wheel metadata still declares `sosap==0.0.1`, but that legacy release has no Windows/Python 3.12 wheel. The public installer intentionally uses the compatible `sosap==0.4.3` Windows wheel. Dependency validation may ignore only this exact metadata mismatch, and only while the functional KFA/sosap import and model preload checks pass; every other `pip check` error remains fatal.
- Run `npm run check:public` before a public-release PR or visibility change from a complete clone with relevant refs fetched. The check rejects forbidden paths in the current tree and locally available Git history, including deleted files and binary media paths, and scans textual content for common secret patterns. Shallow clones fail. It does not fetch remote refs or inspect GitHub comments, Actions logs, release assets, or arbitrary binary contents. Run `npm run test:public` when changing the guard; its fixtures use disposable repositories, not real private data.
- Run `npm run typecheck` and `npm run build`; both preserve protected brand-source verification, allowing only CRLF/LF normalization for SVG hashing.
- Keep `README.md`, `PRIVACY.md`, `SECURITY.md`, and `THIRD_PARTY_NOTICES.md` accurate when data flow, hosted services, direct dependencies, downloaded models, or redistributed binaries change.
- Do not add telemetry, analytics, a new hosted service, or a new category of cloud data transfer without an explicit product decision and corresponding privacy documentation.
- Do not vendor third-party model weights, FFmpeg binaries, or other large/runtime-downloaded artifacts without a separate license and distribution review.
- Public user downloads should come from deliberate GitHub Release assets (and the Sthang website), not from an arbitrary development branch or a locally generated ZIP.
- Build the ordinary-user Windows asset with `npm run package:windows`. Keep its extracted top level intentionally simple: `Install Sthang Studio.bat`, `Read Me.txt`, and one `Sthang Studio Files` folder. Do not expose the repository's development/docs clutter as the primary user download.
- The packaged Windows installer copies the app into `%LOCALAPPDATA%\Sthang Studio\app` before running normal setup so the downloaded release folder is disposable. Future package upgrades must preserve user-owned runtime state, including project/media/history/export data and any existing `apps/server/.env`, rather than replacing the installed directory destructively.
- Treat `main` as the accepted baseline; normal work belongs on short-lived branches and pull requests.
- The Windows desktop shortcut/launcher must wait until both local services are healthy before opening Studio. Respect the user's registered default browser and never assume Chrome is installed. If Windows has no usable web-link association, do not show a broken protocol dialog; print the local Studio URL clearly so the user can open it manually. Windows Sandbox auto-opening is not a release requirement because Sandbox can omit normal browser associations even when Edge is present.

## Processing performance and cache invariants

Studio may aggressively reuse **deterministic prerequisite work**, but never turn a request for fresh AI evidence into a stale cached answer.

Preserve these rules:

- Normalized project audio, selected-range PCM WAVs, transcript-independent KFA acoustic emissions, exact transcript+timing results, decoded waveform/spectrum data, and completed stages of the **same persisted processing job** may be cached and reused when their media/configuration signatures still match.
- A user-requested **Alternative take**, fresh Deep Verify, or other new AI listen must remain a new model request. Only resuming the same persisted job ID may reuse that job's completed Gemini candidate checkpoint.
- Project/range/timing caches must be bounded, project-scoped where they contain project-derived data, and removed through the existing project/media invalidation path. Do not create orphaned global copies of source-derived audio or timing evidence.
- The persistent local timing worker is an optimization, not a new single point of failure. Preserve the one-shot Python worker/CLI recovery path for setup, diagnostics, and daemon-transport failure.
- Keep KFA as the local Khmer timing authority. Cached KFA emissions must be produced by the same acoustic computation as the pinned KFA path; cache reuse may change **when** inference runs, never the scoring/alignment math.
- Keep faster-whisper lazy: load/reuse it only after KFA genuinely needs the fallback. Do not preload the large fallback model merely for perceived responsiveness.
- Local prewarming after media upload/replacement may normalize audio and warm the local timing runtime, but must not upload audio to Gemini before the user explicitly requests generation/regeneration.
- Reuse one Gemini Files API upload for repeated listens over the same immutable audio/key when practical; never let upload reuse pin stale model/settings. Current model/context/guidance still participate in the actual request/checkpoint signature.
- Keep cache writes atomic and fail-open. An optional cache/checkpoint write or cleanup failure must not make caption generation fail.
- Preserve safe media replacement/deletion: in-flight normalization must be serialized per project so old media can never overwrite a replacement cache after invalidation.
- Keep project and history persistence non-destructive. Per-project storage/history migration must preserve legacy data until the new representation is known-good; do not silently discard old `projects.json` or history files during migration.
- Measure before claiming speedups. Job stage timings are diagnostic evidence; never state percentage improvements without a real benchmark on representative Windows/Khmer media.

## Default public-impact assessment

- For every task that changes product code, configuration, dependencies, documentation, or identity, assess public impact during planning and confirm it against the final diff before closeout. Do this without a separate website-update request. Read-only tasks remain read-only.
- Check advertised features and limitations, user workflows, installation and compatibility, release/download/access claims, branding, and data-processing/privacy/security disclosures. A refactor or bug fix is not automatically free of public impact.
- Include `Public impact: none`, `Public impact: required`, or `Public impact: uncertain` in the final handoff, with a brief reason and supporting files. For `required` or `uncertain`, name the known affected product evidence, HQ fields, website/docs routes or files, and the next approval or missing evidence. When required evidence or checkouts are unavailable, report `uncertain` rather than assume no impact.
- Compare the change with [.sthang/product-manifest.json](.sthang/product-manifest.json) and its declared evidence, including `README.md`, `PRIVACY.md`, installation guidance, and identity assets where relevant. Prepare proposed follow-up without another reminder; update product-owned documentation, manifest, and evidence only where required and within the task's write scope. Use a new change ID for a new intake proposal. A `none` assessment alone does not require a manifest rewrite, intake plan, or release. Do not advertise unreleased work as available or treat a local build as a verified public release.

### Maintainer-only portfolio coordination

External contributors report public impact in their pull request. Access to the
private HQ and Distribution repositories is not a contribution requirement;
authorized maintainers handle the following handoff.

- In authorized local checkouts, use the Phase 3 intake workflow in Sthang-HQ's `README.md`, then the Phase 2 synchronization workflow in Sthang-Distribution's `README.md`. HQ owns approved public representation; Distribution owns the `/studio/` website and documentation. If those checkouts or evidence are unavailable, report the missing input and proposed fields/files instead of guessing or silently dropping the follow-up.
- Preparation does not authorize cross-repository writes. HQ intake and Distribution synchronization require their own exact plan-digest and approval-class decisions; commit/push, builds, releases, visibility/settings changes, and deployments require their applicable approval. Do not reuse old approvals, weaken validators, or change blocked policies merely to pass a proposal. Protected-artwork and privacy-decision rules above still apply.

This is an agent closeout requirement, not a background watcher or an automatic publisher. Passing `verify:manifest` or `check:public` does not establish that semantic public impact was assessed.

## Signed Studio updater invariants

The updater is Studio-native infrastructure around the existing Windows
installation. Preserve all of these rules:

- Keep `%LOCALAPPDATA%\\Sthang Studio\\app` as the stable installation and state
  root. Do not migrate Studio to Tauri/Electron merely to gain an updater.
- Studio updates are public and anonymous. Never add ACO licensing, D1
  enrollment, device update credentials, per-user download tokens, or a Tauri
  updater dependency.
- Trust only Studio's own committed Ed25519 public verification key. Production
  private signing material must remain outside the repository and requires
  separate custody approval.
- Versioned manifests and package objects are immutable. A mutable latest pointer
  may advance only from an exact verification receipt after signature, manifest,
  package size, and package hash checks pass.
- Check no more than once per browser session/startup, plus an explicit manual
  action. Never continuously poll, auto-download, or auto-install.
- Re-fetch and verify the offered pointer and manifest immediately before install.
  If either changed, stop and require the user to review the new offer.
- Stage and fully verify before changing the active version. The legacy
  delete-then-copy installer is a manual installation/recovery path, never the
  OTA atomicity model.
- Prepare reviewed Node and Python/local-timing dependencies in the new immutable
  version before activation. Setup, build, or health failure must leave or restore
  the previous active version.
- Preserve projects, source media, captions, locks, history, correction memory,
  jobs/checkpoints, proposals, exports, compatible caches, protected Gemini key
  storage, and the `.env` fallback. OTA packages must not contain or replace
  user/runtime state.
- Keep the stable desktop shortcut and registered-default-browser behavior.
  Validate the exact new API version and web service before discarding any
  transaction marker; retain rollback and GitHub Release recovery material.
- Release notes are bounded sanitized plain text. Browser-visible failures must
  not expose raw hosting URLs, provider responses, secrets, or local paths.
- Source implementation is not public-release evidence. Provisioning signing
  custody, deploying `updates.sthang.app`/R2, promoting latest, publishing a
  release, and HQ/Distribution synchronization remain separately approval-gated.

## UX and interaction invariants

Sthang Studio is an **Operate** interface for a mixed beginner/power-user audience. Read `PRODUCT.md` and `DESIGN.md` before changing the frontend. Consult `UX-AUDIT.md` for historical findings; its scores and validation targets do not describe the current release.

Preserve these rules:

- The persistent core is video/audio evidence plus the caption list.
- Show one advanced workspace at a time; do not stack waveform, review, context, timing details, and grouping controls together.
- When no advanced workspace is open, never reserve an empty fixed-height tool region; the media canvas should reclaim that space on desktop.
- Keep the project header limited to frequent actions. Less-used actions belong in the labeled Tools menu.
- Never replace labels with unexplained icon-only controls at responsive breakpoints.
- Never use a blocking modal for a task that requires watching or replaying the video.
- Keep Approve visible per caption; specialist and destructive row actions belong in the explicit row menu.
- In the Review workspace, keep **Approve & next** as the stable far-right primary decision; approving advances to the next unapproved flagged caption, while **Skip** advances without approval and **Improve…** stays on the problem path.
- Review auto-advance and optional auto-play must never leak into normal timeline editing.
- A newly entered Review item may play with the configured surrounding context once; repeated loops, Replay, and post-edit verification must use the tight focus pass around the selected caption. Keep a deliberate **Play with context** escape hatch.
- Normal tooltips and primary workflow copy must describe user actions/outcomes, not internal providers, models, aligners, runtimes, or fallback architecture. Technical names belong only in setup/Details/diagnostics when they are necessary.
- Treat the grouping workspace as caption structure, not visual formatting. SRT export guidance must stay editor-neutral and state that SRT carries caption text and timing while visual styling is set in the destination editing app.
- Errors and notices use the shared non-overlapping toast stack.
- Do not introduce operational copy below 10px; target 13–15px for editable/body text.
- Preserve visible keyboard focus, Khmer-aware typography, caption-list viewport stability, and explicit playback-follow controls.
- New features must be progressively disclosed and must not make the upload → generate → review → export path harder to find.

## Home launcher copy rule

The home screen is an operational launcher, not a marketing landing page. Keep one concise value line, one concise action-oriented supporting sentence, and the upload surface. Once setup is healthy, collapse onboarding status to a compact readiness indicator; do not keep a completed checklist or repeated workflow explanation in prime space.

## Review-focus invariant

When sequential Review mode is active, make the current decision target identifiable on the video itself once playback enters that caption. Use the approved non-destructive review-focus treatment (Studio-lime corner brackets, optional small label). Never signal review state by changing the caption's real text color, typography, position, timing, or export representation. Pre-roll before the selected caption stays unmarked. Preserve the user's `reviewFocusMode` preference.
