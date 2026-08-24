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

The approved source SVGs are intentionally marked `-text` in `.gitattributes`. Preserve that rule so Git/Windows line-ending conversion cannot rewrite their bytes and create false brand-verification failures.

Before delivering a build, run:

```text
npm run verify:brand
```

A newly owner-approved identity set may replace these files only when `brand-manifest.json`, derived icon assets, `BRAND.md`, and this guidance are updated together.

## Public repository and release invariants

Sthang Studio source code and documentation are published under the repository's software license, while Sthang names and brand assets remain governed separately by `TRADEMARKS.md`.

Preserve these public-release rules:

- Never commit API keys, credentials, private source media, local projects, history, caches, proposals, jobs, exports, downloaded model weights, or local virtual environments.
- Run `npm run check:public` before a public-release PR or visibility change. The check scans tracked files and Git history for common secret patterns and forbidden runtime paths.
- Run `npm run typecheck` and `npm run build`; both preserve the existing byte-for-byte brand verification.
- Keep `README.md`, `PRIVACY.md`, `SECURITY.md`, and `THIRD_PARTY_NOTICES.md` accurate when data flow, hosted services, direct dependencies, downloaded models, or redistributed binaries change.
- Do not add telemetry, analytics, a new hosted service, or a new category of cloud data transfer without an explicit product decision and corresponding privacy documentation.
- Do not vendor third-party model weights, FFmpeg binaries, or other large/runtime-downloaded artifacts without a separate license and distribution review.
- Public user downloads should come from deliberate GitHub Release assets (and the Sthang website), not from an arbitrary development branch or a locally generated ZIP.
- Treat `main` as the accepted baseline; normal work belongs on short-lived branches and pull requests.

## UX and interaction invariants

Sthang Studio is an **Operate** interface for a mixed beginner/power-user audience. Read `PRODUCT.md`, `DESIGN.md`, and `UX-AUDIT.md` before changing the frontend.

Preserve these rules:

- The persistent core is video/audio evidence plus the caption list.
- Show one advanced workspace at a time; do not stack waveform, review, context, timing details, and style controls together.
- When no advanced workspace is open, never reserve an empty fixed-height tool region; the media canvas should reclaim that space on desktop.
- Keep the project header limited to frequent actions. Less-used actions belong in the labeled Tools menu.
- Never replace labels with unexplained icon-only controls at responsive breakpoints.
- Never use a blocking modal for a task that requires watching or replaying the video.
- Keep Approve visible per caption; specialist and destructive row actions belong in the explicit row menu.
- In the Review workspace, keep **Approve & next** as the stable far-right primary decision; approving advances to the next unapproved flagged caption, while **Skip** advances without approval and **Improve…** stays on the problem path.
- Review auto-advance and optional auto-play must never leak into normal timeline editing.
- A newly entered Review item may play with the configured surrounding context once; repeated loops, Replay, and post-edit verification must use the tight focus pass around the selected caption. Keep a deliberate **Play with context** escape hatch.
- Normal tooltips and primary workflow copy must describe user actions/outcomes, not internal providers, models, aligners, runtimes, or fallback architecture. Technical names belong only in setup/Details/diagnostics when they are necessary.
- Errors and notices use the shared non-overlapping toast stack.
- Do not introduce operational copy below 10px; target 13–15px for editable/body text.
- Preserve visible keyboard focus, Khmer-aware typography, caption-list viewport stability, and explicit playback-follow controls.
- New features must be progressively disclosed and must not make the upload → generate → review → export path harder to find.

## Home launcher copy rule

The home screen is an operational launcher, not a marketing landing page. Keep one concise value line, one concise action-oriented supporting sentence, and the upload surface. Once setup is healthy, collapse onboarding status to a compact readiness indicator; do not keep a completed checklist or repeated workflow explanation in prime space.

## Review-focus invariant

When sequential Review mode is active, make the current decision target identifiable on the video itself once playback enters that caption. Use the approved non-destructive review-focus treatment (Studio-lime corner brackets, optional small label). Never signal review state by changing the caption's real text color, typography, position, timing, or export representation. Pre-roll before the selected caption stays unmarked. Preserve the user's `reviewFocusMode` preference.
