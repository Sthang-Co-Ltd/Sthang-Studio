# Sthang Studio interface system

## Surface mode

**Operate.** This is a working editor, not a marketing page. Scanability, predictable controls, evidence visibility, and task completion outrank decorative expression.

## Visual world

- Dark, precise, restrained.
- Studio lime `#D7FF4F` is the active/product accent.
- Sthang orange is reserved for parent-brand references.
- Approved Studio logos and in-house STHANG wordmarks are immutable and governed by `BRAND.md`, `AGENTS.md`, and `brand-manifest.json`.
- The approved ribbon-S mark and STHANG wordmark source assets have transparent backgrounds; use the correct dark/light surface variant rather than adding a baked background or CSS filter.
- In product lockups, the in-house STHANG wordmark is dominant. Pair it with a forward-slanted lime divider and a smaller, lighter, widely tracked `STUDIO` descriptor; never re-typeset STHANG with a substitute font.
- Angular geometry may appear in branding; operational UI uses calm, readable rectangles with 9–14px radii.

## Hierarchy

### Project header

Only frequent actions remain visible:

```text
Review · Tools · Save · Export SRT
```

Less-used actions live in the labeled **Tools** menu. Never collapse them into unexplained icon-only buttons at narrower widths.

### Editor

The video and caption list are the persistent core. Advanced workspaces appear one at a time:

```text
Review · Fine timing · Accuracy · Caption style · Details
```

Do not stack all advanced panels beneath the video. Do not use a blocking modal for any task that requires watching or replaying the video.

When no advanced workspace is selected, do not reserve a blank tool canvas beneath the media. Let the media surface use the available left-column height; only allocate extra vertical space when a workspace actually has content to show.

### Review decisions

Review is a sequential queue, not a freeform editing surface. Keep navigation and decisions visually distinct:

```text
Previous · Replay · Skip · Auto-play next        Improve… · Approve & next
```

- **Approve & next** is the stable far-right primary action and uses the Studio lime accent.
- Approval immediately selects the next unapproved flagged caption; optional auto-play starts it with review pre-roll.
- **Skip** moves forward without changing approval state.
- **Improve…** stays adjacent to approval as the problem path and opens regeneration without advancing.
- Provide a short-lived Undo action for accidental approval.
- Auto-advance is scoped to Review mode only. Normal timeline editing must never jump after an approval/edit.
- Treat surrounding audio as **context**, not as part of every loop. The first pass on a newly entered review item may use the configured pre/post-roll; subsequent loops and Replay use a tight focus window around the selected caption.
- After a text or timing edit is committed in Review, replay the selected caption with the tight focus pass so the user can verify the change immediately.
- Keep **Play with context** available under advanced Review controls for deliberate re-checking of neighboring speech.

### Caption rows

- Text and timing remain immediately editable.
- Approval stays visible.
- Destructive and specialist actions live in an explicit per-row menu.
- Risk indicators are calm summaries until the row is selected; selected rows reveal the detailed reasons.

## Accessibility floor

- Body text target: 13–15px; helper text target: 10–12px. Avoid 7–9px operational copy.
- Frequent controls: at least 36px tall on desktop; target 44px on touch layouts.
- Every interactive control needs a visible `:focus-visible` state.
- Never communicate state through color alone; pair color with copy, icon, or `aria-pressed`.
- Respect `prefers-reduced-motion` while preserving state feedback.
- Text contrast should meet WCAG AA wherever practical.

## Overlays and messages

- Settings, history, jobs, and correction inbox use predictable side sheets.
- Regeneration review stays docked beneath the video.
- Toasts use one non-overlapping stack and provide dismissal for errors/notices.
- Error copy states: what happened, what remains safe, and how to recover.

## Copy

Prefer:

- “System check” over “System Doctor”.
- “Caption style” over “caption rhythm” for first exposure.
- “Review suggested” over multiple alarming chips on every row.
- “Generate captions” over infrastructure-heavy descriptions in the primary path.

Technical details remain available in **Details** and diagnostics.

Tooltips should be brief, concrete, and action-oriented. Do not name KFA, Gemini, Whisper, model IDs, backend/runtime components, or fallback architecture in ordinary hover help or the primary workflow. Provider/model names are allowed where users genuinely need them to configure or diagnose the system.

## Browser surfaces

Theme scrollbars, selection, focus rings, caret, disabled states, loading states, empty states, and responsive overflow. These are part of the shipped design system.

## Home launcher copy rule

The home screen is an operational launcher, not a marketing landing page. Keep one concise value line, one concise action-oriented supporting sentence, and the upload surface. Once setup is healthy, collapse onboarding status to a compact readiness indicator; do not keep a completed checklist or repeated workflow explanation in prime space.

### Video-centric review focus

- In Review mode, the selected caption is the user's current decision target. When playback actually enters that caption's timestamp, identify it directly over the video with restrained Studio-lime corner brackets.
- Do not recolor, resize, reposition, or restyle the caption text itself to indicate review state; the creator must judge the caption in its real visual form.
- Pre-roll remains clean: the review marker must not appear on the preceding caption before the target timestamp begins.
- Default review focus is **Brackets + label**; users may choose **Brackets only** or **Off**.
- The same review-focus language may remain present during Current/Proposed regeneration comparison.
- Review-focus graphics are editor chrome and must never affect SRT export or source media.
