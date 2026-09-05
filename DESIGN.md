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
Review · Tools · Save · Export
```

**Export** opens one focused output workspace. It does not immediately download a
file because Studio now has two legitimate output paths: editable SRT and finished
captioned video. Less-used actions live in the labeled **Tools** menu. Never
collapse them into unexplained icon-only buttons at narrower widths.

### Editor

The video and caption list are the persistent core. Advanced workspaces appear one at a time:

```text
Review · Fine timing · Accuracy · Caption grouping · Appearance · Details
```

Do not stack all advanced panels beneath the video. Do not use a blocking modal for any task that requires watching or replaying the video.

When no advanced workspace is selected, do not reserve a blank tool canvas beneath the media. Let the media surface use the available left-column height; only allocate extra vertical space when a workspace actually has content to show.

### Caption appearance workspace

Caption appearance is **project editing state**, not an export setting. Creators
should be able to decide how their captions look while watching the actual video,
before they reach Export.

- Show **Appearance** as a labeled editor workspace once a video project has
  captions to judge.
- Keep the real video evidence visible. The editor caption overlay should reflect
  the current project appearance while the creator works across Review, Fine
  timing, Accuracy, Caption grouping, Appearance, and Details. Appearance is the
  focused place for changing the look, not a temporary styling mode.
- While Appearance is open, show the **Layout-locked appearance preview** badge.
  The preview and export share the same deterministic Khmer-grapheme line plan,
  and preview geometry is scaled from the actual displayed video rectangle. A
  one-line preview must remain one line after export; relative font size,
  alignment, maximum-width region and bottom position must remain stable too.
- Account for letterboxing/pillarboxing when mapping preview geometry. Do not
  position captions relative to browser chrome or the outer black media-stage box
  when that differs from the displayed video frame.
- Browser CSS and libass remain different rasterizers, so minor antialiasing and
  glyph-metric differences are acceptable. Those differences must not be used to
  excuse changed line count or meaningful size/position drift.
- Keep the common path small: **Preset, Khmer font, text color, size, position**.
  Put weight, outline, shadow, max width, alignment and background-box controls
  behind **More appearance**.
- Project appearance saves automatically and must surface saving/failure state.
  Leaving the workspace must not silently discard the creator's latest change.
- Reusable appearance presets are local creator-profile conveniences. Preset
  creation/deletion stays secondary under **Manage presets** and deletion requires
  a deliberate confirmation step.
- Never silently replace an unavailable saved font. Preserve the project choice,
  explain the local limitation, and require an available font before a finished
  video render when an exact font match cannot be honored.
- Appearance remains Khmer-safe and project-scoped. It never mutates SRT,
  correction eligibility, caption text/timing, locks, Review focus, correction
  memory, history semantics, or source media.

### Export workspace

Export is an output decision, not another always-visible editing panel. Opening the
header action temporarily uses the same focused workspace region and keeps the
video/caption evidence visible.

Present two clearly different paths:

```text
Captions file (SRT)        Captioned video (MP4)
text + timing              finished appearance baked into picture
editable elsewhere        not separately editable inside the MP4
```

- Keep SRT first-class and editor-neutral. Never imply that font, color, size,
  position, outline, background, or animation transfers through SRT.
- Export **consumes the saved project appearance**. Do not duplicate appearance
  editing controls inside Export. Show a compact appearance summary and an
  **Edit appearance** action that returns to the Appearance workspace.
- Default video quality should be **Match source** + **Recommended**. Expose
  HD/FHD/QHD/4K and fixed frame rates without implying that upscaling recovers
  source detail.
- Mark any larger-than-source result **Upscaled**.
- Keep advanced codec/bitrate/encoder controls progressively disclosed.
- Show source dimensions/frame rate/color state, estimated output size, and free
  disk space before a long render where available.
- Before starting a render, re-read the saved project appearance and snapshot it
  together with captions, media identity and output settings. This avoids stale
  styling if the creator edited Appearance immediately before Export.
- Khmer captioned-video export must use the native ASS/libass path with explicit
  **complex shaping**. If the installed FFmpeg cannot expose that capability,
  block finished-video export with recovery guidance instead of producing broken
  glyphs.
- If the selected project font is not available to the local renderer, block the
  finished-video action with a clear path back to Appearance rather than silently
  substituting typography.
- If HDR cannot be preserved correctly, block the finished-video path with a
  specific explanation while keeping SRT available. Never hide color loss behind
  a normal success state.
- While a video render is active, show a horizontal progress bar plus elapsed
  time without covering the editor. The user may keep editing because the render
  uses an immutable snapshot.
- Long video renders belong in Activity with progress/cancel/resume/download.
  Completed exports retain the actual time taken and expose obvious **Download
  video** and Windows **Open folder** actions.

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

## Privacy and contribution UX

Privacy choices belong in a labeled **Privacy** settings surface rather than being
hidden inside AI configuration or generic profile controls.

- Keep **Khmer Caption Contributor** and **product analytics** visually and
  conceptually separate. One choice never implies consent to the other.
- Both begin off/unset. Do not preselect, silently migrate, or infer consent from
  profile import, ordinary editing, update checks, or Gemini use.
- For a fresh installation, Contributor onboarding appears only after Studio has
  already delivered value, such as after a successful export, and only when
  contribution hosting is actually configured. It must never block export or
  first use.
- A pre-v0.8 installation with durable evidence of prior Studio use may receive a
  one-time, dismissible startup explanation when the Contributor choice is still
  unset. This is a migration notice for an existing creator, not first-use
  onboarding. Closing it or choosing to review the settings is not consent.
  Analytics remains a separate off/unset choice. Record the handled notice only
  on that installation and suppress the post-export invitation for the same
  session so Studio never asks twice at once.
- Dismissing a normal post-export Contributor invitation is not consent and should
  only suppress that invitation for the current session. A deliberate **Keep my
  work private** choice may persist as declined.
- Mission-oriented copy may celebrate improving Khmer caption technology, but it
  must remain factual and non-coercive. Do not imply that refusing contribution is
  disloyal, selfish, or harmful to Khmer people/creators.
- Make the material data boundary visible near the decision: bounded matching
  audio + generated/corrected text/timing evidence can be contributed; the full
  video/project and unrelated caption data are not part of the corpus protocol.
- Keep **Request deletion** discoverable once remote contribution evidence exists.
  Pending deletion must be described honestly instead of showing a false success.
- Contributor recognition may show private progress such as verified correction
  count and verified Khmer speech duration. Do not add public leaderboards or
  quantity-first competition that encourages fabricated/noisy corrections.
- Use the word **verified** only for samples whose remote corpus status is verified;
  a queued or successfully uploaded sample is not verified.
- Analytics copy must say that a random installation identifier is used; do not
  describe pseudonymous analytics as anonymous if that would be technically
  inaccurate.

Privacy cards share one visual grammar: 14px card radii, the same title/status/
disclosure/action order, and the same decision-control anatomy. Desktop decision
buttons target 48px height with readable labels, visible `:focus-visible`, and
`aria-pressed` when they represent the persisted choice. The secondary/private
choice must remain visibly actionable rather than looking disabled. State chips
use copy plus a marker, never color alone. Contributor may use Studio lime as its
contextual accent; analytics may use a restrained blue technical accent, but both
must preserve identical spacing, radii, typography, hover/focus behavior, and
information hierarchy. Contextual color must never suggest that analytics is
required or equivalent to Contributor.

Inside each Privacy card, keep this predictable order:

```text
icon → title/status → value line → explanation → data boundary → progress (if any) → decisions → helper/deletion state
```

The post-export Contributor invitation remains a small non-blocking card/toast-like
surface. It must not obscure the video/caption editor, overlap the shared toast
stack, or repeatedly reopen during the same session. The persistent Privacy
settings surface remains the authoritative place to change choices later.

The migration-only existing-user introduction is allowed to be a centered modal
because it is a one-time explanation of a newly introduced data choice to someone
who has already used Studio. It must have an obvious **Not now**/close path, must
state that closing keeps both choices off, and must never auto-enable analytics.
The review action may show the same authoritative Privacy cards inside the modal;
it must not invent a second consent contract.

## Accessibility floor

- Body text target: 13–15px; helper text target: 10–12px. Avoid 7–9px operational copy.
- Frequent controls: at least 36px tall on desktop; target 44px on touch layouts.
- Every interactive control needs a visible `:focus-visible` state.
- Never communicate state through color alone; pair color with copy, icon, or `aria-pressed`.
- Respect `prefers-reduced-motion` while preserving state feedback.
- Text contrast should meet WCAG AA wherever practical.

## Overlays and messages

- Settings, history, jobs, and correction inbox use predictable side sheets.
- Update availability and release notes use the same restrained side-sheet
  language. The updater may surface a calm notice, but must never open itself or
  cover active caption work automatically.
- Keep **Check for updates** in secondary Home/Tools surfaces. Download and
  install remain distinct labeled actions, and unsafe active work must be
  explained before those actions can proceed.
- Regeneration review stays docked beneath the video.
- Activity is the durable progress surface for generation, regeneration and video
  export. Every running job shows a horizontal progress bar and elapsed time;
  completed jobs retain **Took …** duration. Video-export completion shows
  **Download video** and **Open folder** without auto-opening or overwriting media.
- Toasts use one non-overlapping stack and provide dismissal for errors/notices.
- Error copy states: what happened, what remains safe, and how to recover.
- Optional analytics/contribution outages should not create alarming editor
  errors. Keep local work safe and surface sync state only in the relevant privacy
  surface when action is needed.

## Copy

Prefer:

- “System check” over “System Doctor”.
- “Caption grouping” over “caption rhythm” for controls that change how much text appears at once.
- “Appearance” for project caption styling; do not call it an export setting.
- “Review suggested” over multiple alarming chips on every row.
- “Generate captions” over infrastructure-heavy descriptions in the primary path.
- Editor-neutral SRT export guidance: SRT carries caption text and timing; visual styling is set in the destination editing app.
- “Captioned video” for the finished MP4 path.
- “Layout-locked appearance preview” for the editor state where line plan and
  geometry are intended to match export while rasterization remains renderer-specific.
- “Match source” as the default quality choice; “Upscaled” when output dimensions exceed source dimensions.
- “Help make Khmer captions world-class” as mission-oriented Contributor framing,
  followed by precise data disclosure.
- “Verified corrections” only after corpus verification, not after upload.

Technical details remain available in **Details**, diagnostics, export Advanced,
and privacy explanations where the provider/storage distinction is material to a
user's choice.

Tooltips should be brief, concrete, and action-oriented. Do not name KFA, Gemini, Whisper, model IDs, backend/runtime components, or fallback architecture in ordinary hover help or the primary workflow. Provider/model names are allowed where users genuinely need them to configure or diagnose the system, and hosted-service names may appear in Privacy when they are needed for informed data-flow disclosure. FFmpeg/libass names may appear in advanced export diagnostics or the clearly labeled render-preview boundary where they explain a local capability limitation; do not make creators learn them to perform a normal export.

## Browser surfaces

Theme scrollbars, selection, focus rings, caret, disabled states, loading states, empty states, and responsive overflow. These are part of the shipped design system.

## Home launcher copy rule

The home screen is an operational launcher, not a marketing landing page. Keep one concise value line, one concise action-oriented supporting sentence, and the upload surface. Once setup is healthy, collapse onboarding status to a compact readiness indicator; do not keep a completed checklist or repeated workflow explanation in prime space.

### Video-centric review focus

- In Review mode, the selected caption is the user's current decision target. When playback actually enters that caption's timestamp, identify it directly over the video with restrained Studio-lime corner brackets.
- Do not recolor, resize, reposition, or restyle the caption text itself to indicate review state; the creator must judge the caption in its real project appearance.
- Pre-roll remains clean: the review marker must not appear on the preceding caption before the target timestamp begins.
- Default review focus is **Brackets + label**; users may choose **Brackets only** or **Off**.
- The same review-focus language may remain present during Current/Proposed regeneration comparison.
- Review-focus graphics are editor chrome and must never affect SRT export, captioned-video appearance, or source media.
