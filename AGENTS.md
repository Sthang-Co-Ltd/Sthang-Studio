# Sthang Studio development invariants

## Approved logo assets

The following owner-supplied SVGs are permanent source-of-truth assets:

- `apps/web/public/brand/sthang-studio-mark.svg` — dark surfaces;
- `apps/web/public/brand/sthang-studio-mark-ink.svg` — light surfaces;
- `apps/web/public/brand/sthang-studio-mark-mono.svg` — monochrome use.

Never redraw, trace, approximate, simplify, recolour, or replace these marks with generated artwork. Do not use image generation to recreate them. Use the existing `StudioMark` component and select the correct surface variant.

Before delivering a build, run:

```text
npm run verify:brand
```

A newly supplied owner-approved logo set may replace them only when `brand-manifest.json`, derived icon assets, and this guidance are updated together.

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
