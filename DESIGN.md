# Sthang Studio interface system

## Surface mode

**Operate.** This is a working editor, not a marketing page. Scanability, predictable controls, evidence visibility, and task completion outrank decorative expression.

## Visual world

- Dark, precise, restrained.
- Studio lime `#D7FF4F` is the active/product accent.
- Appearance groups use neutral graphite surfaces with subtle gradients and
  white/gray text. Reserve lime for active controls, primary actions and focus;
  do not tint whole groups green.
- Sthang orange is reserved for parent-brand references.
- Approved Studio logos and in-house STHANG wordmarks are immutable and governed by `BRAND.md`, `AGENTS.md`, and `brand-manifest.json`.
- The approved ribbon-S mark and STHANG wordmark source assets have transparent backgrounds; use the correct dark/light surface variant rather than adding a baked background or CSS filter.
- In product lockups, the in-house STHANG wordmark is dominant. Pair it with a forward-slanted lime divider and a smaller, lighter, widely tracked `STUDIO` descriptor; never re-typeset STHANG with a substitute font.
- Angular geometry may appear in branding; operational UI uses calm, readable rectangles with 9–14px radii.

## Typography

English interface text uses **Plus Jakarta Sans**, with Noto Sans Khmer and system
sans-serif fallbacks. Form controls, including selects, inherit that interface
family. Caption-content fields keep **Noto Sans Khmer first**; timing values keep
their monospace stacks. The waveform caption-label fallback follows the same
Khmer-first order. These UI choices never change the saved caption appearance,
native preview/export font, or approved brand artwork.

Use a restrained operational scale: 13px controls/body text, 12px helper text,
11px compact metadata, 10px badges, and 14px section titles. Preserve larger
existing primary headings and Khmer-friendly caption leading; do not scale native
video-caption text with the interface. Responsive controls retain their labeled
44px touch targets.

The existing Google Fonts stylesheet supplies the interface fonts with
`display=swap`; system fallbacks remain usable when it is unavailable. See
`PRIVACY.md` and `THIRD_PARTY_NOTICES.md` for the hosted-font boundary and licenses.

## Hierarchy

### Operational icons

Use the installed Lucide outline family for interface controls, retaining its
24-unit grid and default stroke weight. Keep icons from shrinking in flex rows;
use 16px in navigation, 14–18px in actions, and 12px in compact status markers.
Labels remain visible and icon-only actions need accessible names.

Choose symbols by action: FileUp for local media import, Captions for generation,
ListChecks for Review, AudioLines for Fine timing, BookOpenText for Accuracy,
Group for caption structure, and FileOutput for the Export workspace. Download
means an actual file download. Reserve shields for privacy/security; HandHeart
identifies contribution and ScanText identifies Deep Verify. Timing status uses
SVG marks with descriptive accessible labels, never font-dependent glyphs.

These choices were compared through [Supericons](https://supericons.dev/) and use
the existing `lucide-react` assets covered in `THIRD_PARTY_NOTICES.md`. No remote
icon requests or additional icon package are needed. Approved brand artwork is
separate from this operational icon system.

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

Use the refined A desktop layout at widths of 1200px and above: default preview
left, complete caption-list pane in the middle, and one optional inspector right.
**Arrange panels** beside Reset layout offers preview-position presets and a
compact drag/keyboard custom order. Within that popover, keep a clear lifted
proxy, drop target and actual-panel outline; commit positions on drop. Left/Right buttons
and arrow-key handles provide the same result, with spoken order feedback.
The actual panel headers expose a grip and draggable title at supported desktop
widths. Keep Close tool, Current, Following and Add caption as independent actions.
Start dragging after a small movement threshold. The actual panel follows the
pointer above its neighbours; they slide into a provisional insertion order when
the pointer crosses a neighbour's midpoint. Use a vacant-slot outline, stable
midpoint hysteresis, and a short settling motion. Preserve real pane ancestry,
widths and video ownership; do not clone/reparent content or persist hover drafts.
Regrabbing a settling panel retains the grabbed point, including an inspector
changing height. A click that stays below the drag threshold must not reorder;
tool transitions must also clear any held presentation offset.
Use the original panel bounds to exclude waveform, divider and outside drops.
Reduce Motion retains direct tracking and insertion feedback without animated
neighbours or settling. Header
Left/Right and Home/End retain focus and follow the visible order. Include the
displayed panel title in its accessible name. Share one gesture owner across
headers, arrangement controls and dividers; closing a tool preserves its saved slot.
Escape, pointer cancellation, lost capture, outside release, a second conflicting
gesture, tool changes, and viewport changes must never commit a speculative move.
The selector is a compact row above the panes. Remove repeated workspace
introductions and flatten caption rows into a readable list, preserving selection,
approval, timing, locks, editing and row menus. Keep all tool labels discoverable.

Opening or switching tools must preserve the media element, preview allocation
and caption-list instance. Dividers support dragging, Left/Right, Shift for larger
steps, Home/End and double-click reset. **Reset layout** restores default
proportions and pane order. Measure the editor synchronously on mount and on
window resize; delayed ResizeObserver delivery must not leave a desktop divider
using a narrow-screen size or a false zero-width resize range. Store only bounded
numeric proportions and an exact
permutation of Preview/Captions/Tool in local browser storage;
denied or corrupt storage cannot block editing. **Close tool** restores focus to
the tool entry and removes the empty inspector column.

Fixed pane ancestry preserves playback, caption selection and scroll. CSS grid
positions and native reading-flow keep visual and sequential keyboard order in
agreement; browsers without that capability keep the default order. Filter out
the closed tool without discarding its remembered position. Each divider changes
its two visible neighbors, including a Preview–Tool boundary. Layout controls
must not trigger caption editing, timing shortcuts, or workspace-close Escape.

Fine timing's 184px waveform occupies a dock under the two non-preview panes
when adjacent; with Preview in the middle it uses the caption column only and
the inspector retains full height. Timing controls stay in the inspector. Layout
geometry changes cancel any pending timing drag before moving its canvas.
A narrower window keeps the canonical preview-first order and uses a vertically
scrollable arrangement with a consistent preview height across tools. Keep media
visible while reaching lower controls. Do not use a blocking modal for a task
that requires watching or replaying the video.

When no advanced workspace is selected, do not reserve a blank tool canvas beneath the media. Let the media surface use the available left-column height; only allocate extra vertical space when a workspace actually has content to show.

### Generate caption AI options (published in 0.89)

Keep **AI options** in the Generate captions card, immediately before its primary
action. Its collapsed summary shows the current choice. A labeled native
**Caption model** selector offers **Automatic**, **Gemini 3.8 Flash**, and
**Gemini 3.6 Flash**, with a short explanation that the choice applies only to
this project and leaves global settings unchanged. Existing projects start with
Automatic. Model names are appropriate in this explicit configuration disclosure.

For projects with captions, expose the same options in Accuracy beside full
regeneration. Expand options after a model-related generation failure. Keep the
selector disabled while its save or generation admission is pending, show saving
state, and retain the previous saved choice with a shared error toast on failure.
Use a full-width bordered disclosure row with the current choice, a right-hand
chevron, and clear hover and keyboard-focus states so AI options reads as a control.
Preserve labeled keyboard focus and 44px mobile controls. Details continues to
show the model that actually generated the saved wording.

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
- Treat only a decoded frame for the current settings as layout-locked.
  The preview is rendered as native transparent RGBA PNG frames by the exact same
  FFmpeg and libass (`shaping=complex`) engine used for MP4 export, eliminating
  browser CSS font-metric and shaping divergence. A one-line preview remains one
  line after export; preview and export share the same native caption layout and
  rasterization contract before video encoding; lossy encoding and display scaling
  may soften pixel edges without changing the intended typography, line layout,
  alignment, position, or effects.
- Account for letterboxing and pillarboxing when mapping preview geometry.
  `containedVideoFrame` projects caption frames directly to the active video
  rectangle, never the outer black container or browser chrome.
- Preserve accessible touch targets: all interactive controls, toolbar buttons,
  and modal actions enforce >= 44px touch targets on mobile viewports (<= 620px).
- Keep the common path small: **Preset, Khmer font, text color, size, position**.
  Put weight, outline, shadow, max width, alignment and background-box controls
  behind **More appearance**.
- In the inspector, show Looks and the font/color/size/position controls first.
  Keep Motion, word highlighting and saved-preset management in labeled
  disclosures, with their current state visible in the summary. Existing active
  word-highlight preparation must remain reachable when highlighting is turned
  off. Keep Replay and its target available outside the Motion disclosure.
- Keep **Add font…** adjacent to the Khmer-font control. It opens the normal local
  file picker for `.ttf`/`.otf`, validates Khmer compatibility, selects a
  successfully added family immediately, and explains partial/rejected files in
  plain language. When the installed Khmer list is large, typing in font search
  reveals clickable matches immediately while the normal selector remains available
  for browsing. Do not require a second selector click just to reveal search results.
- If the chosen family has no Bold face, switch Weight to Regular automatically,
  explain the small fallback, preserve all other appearance settings, and disable
  the unavailable Bold choice rather than blocking preview/render.
- Continuous Appearance input must keep the last valid native caption frame visible
  while the newest native frame renders. Size, position, color, outline, shadow,
  width, alignment, background, weight and font changes must not blink the caption
  away between slider/input events. Retained pixels may bridge the same caption's
  appearance renders only; a different caption/text state still requires fresh pixels.
- Size/position may transform matching native pixels immediately around the ASS
  alignment anchor, projected into the contained video's displayed size. Mark this
  **Interactive preview · refining layout…**, not layout-locked. Width/font/effect
  changes and clipped source/target images retain untransformed pixels until native
  rendering completes. No browser text-layout fallback is permitted.
- Coalesce input by animation frame; allow one native request at a time and never
  build a queue of intermediate slider values. Defer lookahead during editing.
  Flush on pointer release/cancel, keyboard release and blur, including switching
  workspaces. Keep the temporary transform until the exact replacement is decoded.
- Keep **Manage added fonts** secondary and show only font files the creator added
  to Studio. Removing one requires confirmation, never changes operating-system
  fonts, and never silently substitutes a different family for a saved project.
- With untouched appearance defaults, keep a caption on one line whenever its
  measured glyphs fit the available caption region. Do not pre-split ordinary
  mixed Khmer/Latin words with approximate character counts. Explicit line
  breaks and creator changes such as a narrower **Max width** may produce a
  multi-line layout.
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

### Original Looks and Motion

Motion, Word highlighting, More appearance and Saved presets share one disclosure
style: a rounded enclosing surface, a defined header and padded content. Keep
secondary preparation and preset management flat within their parent group.
Replay remains available outside Motion, including when Motion is closed.

Keep three distinct choices: **Look**, **Motion**, and **Word emphasis**. Present
six static labeled Look samples, a selected/Custom state, and **Reset look**.
Applying a Look changes decoration only. Retain full user presets separately and
label the scope as all project captions. Samples are illustrative; the native
video remains the final layout reference. Never animate the entire gallery.

Motion offers **None / Fade / Rise / Soft Pop**, a bounded duration and explicit
**Replay effect**. Keep all four choices labeled in a two-column layout on narrow
screens. Explain the selected effect and that opening frames are prepared first; do not
promise full pre-rendering of all word/overlap states. Keep **Turn motion off**
separate from Look reset. New changes cancel pending replay. Effects expose one
appearance Undo/Redo step, with continuous slider input grouped into one gesture.

Rise moves the entire caption into its saved position; Soft Pop scales the complete
caption into place. Both fade out after settling. When these presets are selected
and captions overlap, explain that simultaneous captions stay still and fade to
preserve their readable layout. No new per-word movement or hidden timeline edit
is implied. Use **Fade duration** for Fade and **Motion duration** for the new
presets, retaining the existing bounded range and short-caption handling.

Replay is also available with Motion=None. Show the selected target, provide
Cancel preparation while waiting and Stop replay while playing, and preserve
manual source-player seeks. Explain a missing or unchecked font before replay
instead of offering an action that cannot render. Saving a preset while the user
keeps editing must preserve both the clicked snapshot and the newer Custom state.

Keep source playback visible during desktop editing and bounded on narrow
screens. Touch targets and descriptive labels survive responsive layouts. Word
emphasis retains readiness and its direct timing-repair path; an unresolved word
track does not remove the caption's base Look or caption-level Fade.

### Export workspace

The local source uses Appearance's neutral graphite gradients, borders and text
hierarchy for Export checks, Video settings and the final render area. Keep
secondary content flat inside these groups. The inspector header supplies the
Export title; the workspace starts with its output choice and a short instruction.
Recheck support is a compact action beside the checks heading, distinct from the
whole-project layout check. Both checks retain their existing scope and authority.

Export layout follows its actual panel width. At 540px of workspace content,
Resolution and Frame rate share a row; Quality remains full-width. Narrow panels
stack the fields even on a wide monitor. Advanced settings, preset management and
caption-file controls follow the same width boundary. Keep the output dimensions,
size estimate and free disk space together beside the final render action.
Successful word-timing information uses neutral text; unresolved timing and real
export warnings retain their warning treatment. Appearance remains a summary and
navigation action. This facelift does not change defaults, saved choices, export
checks, snapshots, rendering or file workflows, and is not public-release evidence.

For editable caption handoff, **Captions file** opens one compact
destination selector, a short import guide, and **Download SRT**. Keep advanced
formats behind a labeled disclosure. Show what each format retains and what the
destination must style again; a word-per-cue file must never be labeled a portable
full-sentence highlight effect. Explain CapCut mobile's manual Desktop/Web sync
route and its external cloud boundary without offering a fake direct import.

Studio caption-data import opens an inline review of count, timing, sample text,
warnings and replacement scope. **Keep current captions** and **Replace captions**
are explicit. Newer text or media invalidates that preview. Block incompatible
word exports with a direct word-timing review path. File creation and restore use
the existing shared error/toast language, keyboard focus and mobile touch sizing.

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
- Place a clearly labeled **Video export preset** selector near Video settings,
  with Save/Delete inside a secondary **Manage presets** disclosure. This stores
  output choices only; the separate Appearance preset stays in Appearance.
  A saved preset remains explicitly selectable for management/deletion even when
  an unavailable codec or hardware encoder forces current output settings to
  fall back. Label effective output as customized after fallback, while retaining
  the original preset values and showing the name to be deleted before confirmation.
- Recall last-used output settings from the most recently accepted render when
  entering a new Export visit. Preserve local in-progress choices while repairing
  export issues and ignore late profile responses after the user edits. Recheck
  device/source capabilities for a recalled preset, and explain any unavailable
  codec or hardware encoder before selecting a compatible fallback.
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
  Completed exports retain the actual time taken, expose an obvious **Download
  video** action, and show Studio's fixed local exports-folder path instead of a
  fragile desktop-shell action.

### Export issue repair

Keep **Check before export** inline in the Export workspace. Each issue states
whether it blocks this output or is a review suggestion, shows caption text and
timestamps, and offers a labeled **Go to caption** action. Overlap findings list
the involved captions. Page long issue collections so every target remains
reachable without an unbounded wall of controls. Keep Khmer text readable and
use the existing focus and mobile touch sizing.

Native **Check layout** is explicit. Show unchecked, checking, cancelled/failed,
stale, blocked and checked states honestly. A checked result applies only to its
caption/appearance/resolution/font snapshot. Preserve the media and normal editor
while checking; Cancel check must remain available.

Repair navigation opens the appropriate focused workspace and exposes **Back to
export**. Restore the temporary output/settings selection and focus the checks
heading on return. Users can finish the export review without changing captions.
Selecting a word-file option with unresolved timing reveals its blockers while
the actual download remains disabled. Plain SRT remains independently available.

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

### Fine Timing and word highlighting

Keep **Caption edges** and **Word timing** visibly separate inside the single
Fine Timing workspace. Caption-edge drag handles and editable word handles occupy
distinct lanes. The larger caption bar is a text label plus cue duration; original
transcript word estimates are optional, explicitly named reference marks.

Share a compact header for caption navigation and audition. Start/End fields and
their actions remain in the inspector while the waveform uses its separate dock.
Preserve labeled 36px desktop controls and 44px touch controls. Use available
panel width to adapt rows; allow scrolling for expanded settings, word-timing
details and longer notices rather than clipping controls to force a fixed fit.

Start with neighbor protection and no ripple. **Allow overlaps** is explicit.
**Move adjoining edge too** changes the shared transition of two captions, honors
both timing locks, and undoes atomically. A prevented move explains the boundary.

For word edits, keep the selected word name, Hear word, Start/End, and simple
movement controls together. Untimed fields are only a local draft until **Apply
word timing**; tentative times require adjustment or **Confirm this word**.
Corrected text is reconciled against a stable editing/composition basis so
unfinished Khmer input cannot progressively destroy surrounding timing evidence.

**Sync words** uses the current exact wording and proposes timing without changing
the saved caption. Keep **Use timing / Keep current** visible while that candidate
is previewed. Newer text/timing/lock/media edits invalidate it. Do not let an old
highlight bitmap remain labeled exact during a word transition or text correction.

Put the optional **Spoken word highlight** toggle and color under Appearance, with
counts of usable and unresolved captions and a direct **Review word timing** link.
Keep the disclosure heading and its controls inside one restrained enclosing
surface, with one explanation, separate color and readiness rows, and flat
preparation states. Hide idle preparation when no spoken caption needs timing; keep active
preparation, cancellation and results reachable when highlighting is off.
An optional **Prepare word highlights** section in the same workspace offers one
action to check all unresolved captions locally. Show checked/total progress,
cancel, ready/needs-review totals, explicit **Use ready timings / Keep current**,
and **Review remaining** into the existing Fine Timing editor. After applying,
offer a guarded **Undo batch**. Keep preparation non-modal and preserve playback;
never imply estimated, stale, or locked words were made ready automatically.
For Khmer word-boundary mismatches, display trusted KFA acoustic evidence without
claiming a separate boundary when no separate measurement exists. A confirmed
whole-word interval can be used for one exact displayed word; any proportional
division into several displayed words stays visibly review-required. Fallback
ASR timestamps are review evidence and must never be presented as independently
verified acoustic word boundaries solely because a spelling match is strong.
Do not animate or reshape words to communicate timing. The full sentence stays
visible, only the active word changes color, and pauses restore base color. Export
discloses any captions that remain plain; SRT copy explains that it carries no
word-highlight metadata. Setup/provider names stay out of normal controls.
In the Phase 3 development preview, prioritize the exact currently requested
native word-paint frame before nearby future states. Use video-frame callbacks
where supported to notice actual word/paint boundaries without refreshing the
whole editor every decoded frame. Keep lookahead bounded and cancel safely on
new project, media, word edits, visual changes or obsolete focus. Until new
native pixels arrive, an older bitmap must never be marked exact for another
word. Replay, motion, pauses and Review Focus continue to share export geometry.
If a current native paint finishes after playback has passed it, one bounded
lookahead attempt may target the predicted completion time to recover useful
exact pixels. This best-effort recovery never changes playback or saved timing
and cannot guarantee every paint on a slower renderer. Keep that attempt within
nine nearby states, one second of timeline lookahead and one second of wall time;
seek, pause, playback-rate changes and edits reset it. Unavailable speculative
work must yield back to the exact current paint.

### Caption rows

Correct everywhere pairs labeled **Before / After** text in two columns on desktop
and vertically on mobile. Preserve Khmer line height and whitespace; label locked,
unchanged and empty-text results. Show changed-caption and protected-match counts,
disable Apply when nothing changes, and provide labeled pagination for all matches.

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

Product dialogs share focus entry, forward/reverse Tab containment, topmost-only
Escape dismissal and return focus to a connected opener. Find & Correct starts in
Find; destructive confirmations start on the safe decision. Updates and the privacy
introduction start on their dialog root so async disabled controls and consent
choices do not steal initial focus. Busy guards remain authoritative. Composition
Escape and keyboard events already handled by a field remain with that field.
Editor shortcuts remain isolated for the entire lifetime of a product dialog.

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
- Regeneration review uses the focused comparison inspector with the media
  evidence visible. During comparison, the shared toast stack occupies its own
  bounded footer so recovery notices cannot cover proposal decisions. On small
  screens, messages temporarily compact the preview to keep the video and
  decisions usable together. An empty stack reserves no footer space.
- Activity is the durable progress surface for generation, regeneration and video
  export. Every running job shows a horizontal progress bar and elapsed time;
  completed jobs retain **Took …** duration. Video-export completion shows an
  obvious **Download video** action plus the fixed local exports-folder path; it
  never auto-opens a desktop folder or overwrites media.
- Toasts use one non-overlapping stack and provide dismissal for errors/notices.
- Error copy states: what happened, what remains safe, and how to recover.
- Unfinished caption and Accuracy changes share the header Save action and
  conditional close/reload protection. Pending writes keep that protection even
  if newer typing temporarily matches the previous saved value.
- A failed save remains in the shared toast stack with **Retry save** and
  **Download edits** until the affected edits save or return to the saved value.
  A saved-project conflict instead keeps a persistent **Saved project changed**
  notice with **Download edits** and **Reload saved project**. Preserve the local
  draft, stop queued saves/retries, and disable Save until the saved project is
  reloaded. Capture the recovery copy before reloading; changed saved evidence
  requires comparison when the project is reopened.
  Recovery offers show a timestamp and collapsed preview with labeled
  **Restore draft**, **Download draft**, and **Discard draft** actions. Use an
  explicit discard confirmation; keep the media and caption list accessible.
  Changed saved captions/context/media disable restoration and explain comparison.
- Saved-project read warnings use the shared toast stack with **Review storage**.
  Settings → System check separates projects loaded in this session from readable
  files at the last check. Keep recovery guidance and the labeled read-only
  recheck visible; do not offer destructive repair or automatic reload. Unknown
  storage status must not make an empty library look like a confirmed new install.
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

### Appearance precision and menu navigation (source-only)

Appearance's numeric readouts accept exact values alongside the existing sliders.
Enter or blur applies one edit; Escape discards the typed draft without closing
the workspace. Empty or invalid drafts restore the current value. New numbers
use the slider's bounds and step; simply focusing a saved fractional value never
rounds it. Each changed numeric setting offers a small reset to its named Studio
default, preserving sibling settings and participating in the existing Undo/Redo
and local autosave. Keep the unit visible and the numeric/reset targets at least
44px on mobile. Reset look retains its separate decoration-only meaning.

Tools uses compact, labeled groups without a repeated menu introduction. Keep
action names, useful explanations, disabled reasons and attention counts. Tools
and caption-row menus focus the first action on opening; Arrow Up opens at the
last enabled action. Up/Down wrap, Home/End jump, and typing finds actions.
Disabled actions are skipped. Tab leaves the menu, Escape returns to its trigger,
and structural caption actions restore focus to the resulting caption if the
trigger was removed. Menu navigation must never run playback or timing shortcuts;
Ctrl/Cmd+F and modal focus priority remain intact. These changes describe source
behavior, not public-release availability.

### Activity and first-open tools (source-only)

Activity keeps each job's title, status, message and measured progress readable
at a glance. Put elapsed time in a stable, tabular-numeral column and percentage
beside the bar. Completed jobs retain **Took …**. Stage names, update timestamps
and video-file specifications belong in the native **Details** disclosure.
Errors, export-freshness notices and recovery/download actions stay visible.
Keep server ordering, status and action eligibility authoritative; 100% alone
does not mean completed, and cancellation requested still means stopping.

First opening a deferred tool may show a quiet, static outline of its controls
with **Opening [tool]…**. Keep it within the inspector, label it as status and
hide decorative placeholders from assistive technology. No simulated progress,
shimmer, delayed import or minimum loading duration is needed. Cached tools open
directly. The media and caption list remain mounted and usable during loading
or a download failure; **Retry loading tool** remains available after repeated
failures. Retry requests fresh tool bytes and failed styles without reloading
Studio, saving a draft, or replacing the media/caption-list instances. A build
check keeps each optional tool in a separate JavaScript leaf whose shared editor
dependencies are already loaded; retry metadata must match the running build.
Keep successful styles in their cascade position and successful tools cached.
Never reload automatically or imply that the current draft was saved.
These local source refinements do not establish public-release availability.

### Interface motion (source-only)

Tools, caption-row menus and Arrange panels use a restrained trigger-anchored
entrance, approximately 180ms in and 140ms out. Menus stay immediately actionable.
Closing removes their interaction and accessibility presence immediately; a brief
visual exit must never intercept a new action or consume a dialog's Escape.
Utility side sheets use the same timing with at most 10px of right-edge movement.
Focus entry, containment, return focus and busy dismissal guards retain their
existing logical open/closed behavior. Rapid reopening cancels the old exit.

Enabled ordinary actions may depress 1px while held. Keep layout dimensions,
labels, precision handles, panel grips and video/caption evidence unchanged.
Header Save and its keyboard shortcut may acknowledge a successful manual save
with a brief check and one quiet border pulse. Bind acknowledgement to the editor
visit and saved state; failed saves, newer unfinished edits, hydration and
background autosaves must never produce it. Preserve a stable Save/Saved width.

Reduce Motion removes spatial effects and delayed dismissal while retaining
readable state feedback. Native popovers keep their immediate fallback where
discrete transitions are unsupported. No animation library or new cloud request
is needed. These source refinements do not establish public-release availability.

### Reading and feedback refinements (source-only)

Keep notifications in the existing fixed stack, with a short fade and at most
4px of movement. Dismissed actions become inert immediately. Timed notices and
Review Undo pause while hovered, keyboard-focused, hidden by a dialog, or in a
background tab, then resume their remaining reading time. Returning focus after
dismissal must not scroll or remount the caption editor. Persistent errors keep
their existing explicit dismissal and recovery actions.

The upload surface holds its drag state across child elements and says **Drop to
import**. Explain multiple-file and recognizable non-media selections beside the
surface; ambiguous media containers retain the existing processing path. Failed
uploads may retry the same file through the picker without reopening Studio.

Frequent editor controls use concise hover and keyboard-focus hints with optional
shortcut badges. Keep labels and existing accessible descriptions. Hints remain
hoverable, dismiss on Escape without moving focus, and disappear when their
control is hidden or unavailable. Touch interaction must not require a tooltip.

Long inspectors and utility sheets use faint scroll-boundary shadows, hidden at
the corresponding content boundary. Cues must not cover text, intercept input,
reserve layout space, or change the video/caption viewport. Reduced Motion removes
notification movement and hint fades. These local changes do not imply a public
release or alter the upload → generate → review → export workflow.

### Names, prerequisites and correction previews (source-only)

The project title opens a compact nonmodal **Project details** view containing the
full project and source-file names. It supports pointer, keyboard and touch,
preserves editor geometry and drafts, and returns focus on dismissal. Hover/focus
hints also expose the names; small screens retain a labeled Project details
control. Recent-project titles wrap within their existing cards. Never hide a
full name behind a pointer-only native title.

Unavailable caption actions retain native disabled behavior and explain their
locking prerequisite in visible text. Fine timing names missing or locked
adjoining-caption prerequisites beside the affected edge, with accessible
descriptions. Explanations must not unlock, save, or otherwise alter a caption.

Find & Correct highlights changed grapheme spans in its existing Before/After
preview, using distinct underlines and restrained colors. Exact text, whitespace,
locks and replacement rules remain owned by the replacement plan; preview markup
never changes the applied edit. Bound comparison work to visible rows, and retain
plain exact text when safe grapheme segmentation or the comparison budget is
unavailable. These local refinements do not establish public-release availability.

### Completion and form feedback (source-only)

Timestamp errors use readable 12px helper text, wrap beside their field, and keep
the existing exact parsing, bounds, draft and Escape behavior. Invalid input must
not change saved timing or force horizontal scrolling.

Appearance preset actions say **Save preset** for a new name and **Update preset**
for the existing trimmed, case-insensitive name match. Announce **Saved** or
**Updated** with the name beside the form only after persistence succeeds. Keep
failed input and newer name/appearance edits; a pending save captures the clicked
appearance, and must not clear or confirm a newer form draft.

An empty Review queue offers **Show all captions** and **Continue to Export** in
the existing inspector. Distinguish reviewed flags from **No automatic risks
detected**, including informational flags normally suppressed by approval. This
classification is presentation only: the queue, QA analysis, readiness and export
checks retain their authority. Review badges and guide counts show the pending
queue, excluding approved captions. Completion never certifies caption accuracy or
downloads automatically. Keep pending **Approve & next** as the far-right
decision, restore useful focus after completion/Undo, and preserve editor nodes,
unsaved changes and deliberate navigation. Final approval cancels a pending
post-edit replay before pausing. These refinements are source-only,
not evidence of a public release.

### Correction recovery and value feedback (source-only)

Find & Correct applies a replacement once, then saves the optional glossary rule
as a separate step. A failed glossary save keeps the applied caption edits and
offers **Retry glossary save** for the captured rule and scope only. Repeated
activation must not repeat the replacement. Confirm success only when the rule
is present in the saved response; a late response cannot close a newer sheet
visit or update another project's Accuracy draft. The result remains in the
existing sheet, with an explicit way to continue without saving the rule.

Find preview page changes reveal and focus the first new caption preview and
announce the page and caption range. Search edits reset preview scrolling without
moving focus away from the field. Keep query, replacement, scope and lock behavior.

Appearance exact-value inputs explain minimum/maximum clamping and step rounding
with quiet, readable feedback beside the affected field. Keep existing numeric
normalization and Undo behavior. Valid inputs, untouched saved fractions and
Escape stay quiet; new input, reset, slider interaction and external value changes
clear stale feedback. Moving keyboard focus alone retains the adjustment notice.
These refinements do not establish release availability.

### History and Settings recovery (source-only)

Project history distinguishes loading, a failed read, a loaded empty list and a
refresh. Keep the last loaded entries visible during refresh and failure, offer
**Retry history**, and retain request/source ownership checks. History feedback
must not change checkpoint restoration or the caption editor.

Copying correction and diagnostic reports confirms **Copied** only after a
successful clipboard operation. Keep keyboard focus and guard duplicate requests.
If both clipboard methods fail, offer the report as selectable text inside the
same surface. Copy never sends the report elsewhere.

Settings keeps edited glossary text through unrelated profile updates and late
save responses. Topic-pack creation retains its name until the captured pack is
acknowledged; newer names and context remain intact. Confirm only acknowledged
content, including normalization omissions. Profile-import failures stay in the
form, retain drafts and support retrying the same file. Local file validation
expects an exported Studio profile; server normalization and privacy rules remain
authoritative. These form drafts are not new persistent recovery storage.

Video-export presets use **Save preset** or **Update preset** before submission.
Confirm only the captured saved settings, preserving newer names and choices.
Failed preset loading offers an in-place retry without overwriting current
export choices. Existing export admission, settings and rendering remain unchanged.

Font search follows combobox keyboard behavior: arrows browse the active result,
Enter commits, Tab leaves without committing, and Escape dismisses the results.
Khmer IME composition and legacy composition keystrokes cannot commit a font.
Browsing does not change appearance; an explicit choice retains normal Undo.
These refinements are source-only and do not establish public-release availability.

### AI settings, export records and shortcut help (source-only)

AI connection tests and saves belong to the submitted form snapshot. Delayed
results must not clear newer key/model entries or claim to have checked a newer
draft. Guard duplicate actions, preserve retryable input, and keep typed keys in
component memory only. Clipboard denial offers manual paste with the platform's
shortcut. Forgetting a saved key uses Studio's existing confirmation dialog and
does not erase a typed replacement. Key storage and connection authority remain
unchanged.

Export history retains same-project records during refresh or failure, labels
them as last loaded, and offers an in-place retry. Clear records across projects;
never present failed or pending reads as an empty history or an up-to-date list.
Existing content comparisons still include unsaved edits and retain their receipt
semantics.

Quick guide includes a collapsed Keyboard shortcuts section, grouped into editing
and playback versus Review-only actions. Show Command/Option on macOS and Ctrl/Alt
on Windows. The guide uses one scrollable body below its persistent header;
shortcut help does not change key handling or add another workspace.

These refinements are source-only and do not establish public-release availability.

## Home launcher copy rule

The home screen is an operational launcher, not a marketing landing page. Keep one concise value line, one concise action-oriented supporting sentence, and the upload surface. Once setup is healthy, collapse onboarding status to a compact readiness indicator; do not keep a completed checklist or repeated workflow explanation in prime space.

### All projects

Keep Home's upload flow and six recent projects compact. **All projects** opens a
dedicated page with **Back to Home**, labeled **Search projects** and **Sort
projects** controls, a result count, and 24-row pagination. Search covers the
complete metadata collection. Distinguish loading, failed loading, an empty
collection, and no search matches; offer the relevant retry or clear action.

Each project shows its name, caption state, dates, and a visible **Continue
editing** or **Open project** action. Names must remain readable with long Khmer
and mixed-language content. Keyboard focus, explicit labels and mobile touch
targets follow the existing interface rules. Returning from the editor retains
the collection view in this tab; a pending open must not win after a newer
navigation choice. Keep the saved-project/conflict/recovery workflow intact.

### Video-centric review focus

- In Review mode, the selected caption is the user's current decision target. When playback actually enters that caption's timestamp, identify it directly over the video with restrained Studio-lime corner brackets.
- Do not recolor, resize, reposition, or restyle the caption text itself to indicate review state; the creator must judge the caption in its real project appearance.
- Pre-roll remains clean: the review marker must not appear on the preceding caption before the target timestamp begins.
- Default review focus is **Brackets + label**; users may choose **Brackets only** or **Off**.
- The same review-focus language may remain present during Current/Proposed regeneration comparison.
- Review-focus graphics are editor chrome and must never affect SRT export, captioned-video appearance, or source media.

### Export history

Keep collapsed Export history after the primary output controls, preserving the
desktop Download SRT viewport. Show the number needing an update in its summary.
Expanded entries name format, preparation time and matches/changed/unknown state
in words. Explain comparison with the open project and that file preparation does
not confirm download. Unknown history offers Retry without blocking output.
Activity labels individual completed videos similarly; old jobs with no receipt
remain downloadable and explicitly unknown. Offer Open project to compare when a
different project is open, using the existing protected navigation path.
