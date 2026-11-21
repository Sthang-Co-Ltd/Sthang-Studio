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

The video and caption list are the persistent core. Review opens from the project header. The tool strip opens one specialist workspace at a time.

```text
Fine timing · Accuracy · Caption grouping · Appearance · Details
```

Use the refined A desktop layout at widths of 1200px and above: default preview
left, complete caption-list pane in the middle, and one optional inspector right.
**Arrange panels** beside Reset layout offers preview-position presets and a
compact drag/keyboard custom order. Within that popover, keep a clear lifted
proxy, drop target and actual-panel outline; commit positions on drop. Left/Right buttons
and arrow-key handles provide the same result, with spoken order feedback.
The actual panel headers expose a grip and draggable title at supported desktop
widths. Keep Close tool, Current, Follow playback and Add caption as independent actions.
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
In source builds, reorder handles accept only bare Left/Right and Home/End.
Composition, legacy composition keys, AltGraph, other modifiers and events already
handled before the layout listener leave the arrangement alone. Only plain Escape
cancels an active layout gesture; a foreground dialog retains its own keys.
The selector is a compact row above the panes. Remove repeated workspace
introductions and flatten caption rows into a readable list, preserving selection,
approval, timing, locks, editing and row menus. Keep all tool labels discoverable.

Opening or switching tools must preserve the media element, preview allocation
and caption-list instance. Dividers support dragging, Left/Right, Shift for larger
steps, Home/End and double-click reset. **Reset layout** restores default
proportions and pane order. Source builds reserve Shift for exactly Left/Right;
Shift+Home/End and other modified or composing keys do not resize panels. Measure
the editor synchronously on mount and on
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
scrollable arrangement. Keep a compact preview above an open tool, bring its
heading into view on entry, and give an empty caption list only the space it needs. Do not use a blocking modal for a task
that requires watching or replaying the video.

When no advanced workspace is selected, do not reserve a blank tool canvas beneath the media. Let the media surface use the available left-column height; only allocate extra vertical space when a workspace actually has content to show.

### Generate caption AI options

Place the primary Generate action before optional Accuracy context and **AI options**. Its collapsed summary pairs the selected model name with its mark.
Opening it exposes one native **Caption model** radio group. A wand identifies **Automatic**, and the Gemini mark accompanies **Gemini 3.8 Flash**,
**Gemini 4 Hydrogen**, and **Gemini 3.6 Flash**, with a short explanation that the choice applies only to
this project and leaves global settings unchanged. Existing projects start with
Automatic. Model names are appropriate in this explicit configuration disclosure.

Hydrogen is an optional development addition to the choices published in 0.89.
Keep Automatic on the configured primary/fallback policy, with 3.8/3.6 as the
shipped defaults. Supported caption models use low thinking without an additional
control in the generation workflow; AI connection settings may explain that policy.

For projects with captions, expose the same options in Accuracy beside full
regeneration. Expand options after a model-related generation failure. Keep the
selector disabled while its save or generation admission is pending, show saving
state, and retain the previous saved choice with a shared error toast on failure.
When a focused picker changes, move focus to the persistent **AI options** summary
before saving disables the picker. Reveal that target immediately and leave newer
focus alone when the save settles; Tab can return to the picker once it is ready.
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

For editable caption handoff, **Captions file** puts **Download SRT** before
the destination selector and its import instructions. Keep advanced
formats behind a labeled disclosure. Show what each format retains and what the
destination must style again; a word-per-cue file must never be labeled a portable
full-sentence highlight effect. Explain CapCut mobile's manual Desktop/Web sync
route and its external cloud boundary without offering a fake direct import.
In source builds, an explicitly focused caption-file download action moves focus
to the persistent **Captions file** output control before preparation disables
the action. Completion leaves newer focus and destination/format choices alone.

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
  entering Export without matching remembered project choices. Preserve local
  in-progress choices while repairing export issues and ignore late profile
  responses after the user edits. Recheck
  device/source capabilities for a recalled preset, and explain any unavailable
  codec or hardware encoder before selecting a compatible fallback.
  Without remembered project choices, keep video render and video layout checks
  unavailable during the initial saved-settings read until it finishes or the
  creator explicitly chooses settings. A failed read retains the displayed
  settings and the existing retry.
  Caption-file layout checks remain independent of remembered video settings.
- Show source dimensions/frame rate/color state, estimated output size, and free
  disk space before a long render where available.
- Before starting a render, re-read the saved project appearance and snapshot it
  together with captions, media identity and output settings. This avoids stale
  styling if the creator edited Appearance immediately before Export. Compare the
  reviewed caption-content fingerprint inside the final saved snapshot transaction;
  a remote wording, timing or word-highlight change requires renewed review.
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

In source builds, **Retry appearance load** hands focus from its initiating button
to the persistent **Check before export** heading before loading removes the
action. **Retry appearance comparison** uses its persistent **Export history**
summary instead. Only move focus when the initiating button owns it, reveal that
section's target, and leave newer focus untouched when loading finishes. Both
targets clear the sticky preview on smaller screens. The Appearance save-recovery
actions retain their existing repair navigation and focus destination.

Native **Check layout** is explicit. Show unchecked, checking, cancelled/failed,
stale, blocked and checked states honestly. A checked result applies only to its
caption/appearance/resolution/font snapshot. Preserve the media and normal editor
while checking; Cancel check must remain available.

Repair navigation opens the appropriate focused workspace and exposes **Back to
export**. Restore the current output/settings selection and focus the checks
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

**Sync words** uses the current exact wording and applies usable timing with Undo
in Fine Timing. Tentative results offer **Use tentative timing** and **Close
preview** as recovery actions. Newer text, timing, lock, or media edits invalidate
the result. During a word transition or text correction, label only the current
highlight bitmap exact.

When **Sync words** finds corroborated speech beyond a short caption, show the
suggested edges and word timing in the existing preview area. **Play suggestion**
uses the actual video. **Apply timing repair** commits the affected captions as
one undoable edit and explains its effect on Review approval before applying.

In unreleased source, place the **Word highlighting** toggle and color under
Appearance. Turning it on starts Apply. Show **Apply to all captions** when an
older project has highlighting on and has yet to arm follow. Show preparation
and checked/total progress with **Cancel** in the same disclosure. One result
line distinguishes individually lit captions, measured groups, partially lit
captions, and plain captions. Unsupported spans keep their normal color.

**Review remaining** and **Next timing issue** seek to the selected exception and
open **Word timing** with playback paused. **Sync remaining** retries unlocked
exceptions. If attention is still needed, open **Caption edges** for the most
urgent remaining caption unless the user has moved on. Keep **Undo** reachable
when the effect is off. Explicit actions that keep Appearance open return focus
to the persistent summary when their button disappears.
An armed project responds to saved wording or cue changes after a short delay.
Background work preserves playback and focus.
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

Long caption lists keep native text and timing fields mounted, preserving caret,
composition, selection and keyboard navigation. Completing composition with the
same text does not revoke approval or create another edit. Layout notices and
caption focus use bounded state; avoid ancestor-wide relational CSS selectors
that make each text edit reconsider the full caption list. Preserve the same
sticky-preview exclusions and notice exit behavior when optimizing this work.

An unchanged, owned caption-save acknowledgement may reuse the entire draft array
only after word-timing hydration and exact comparison of every serialized caption
field and its order. Retain the normal canonical result for any difference, and
keep server metadata, revision increments, selection and recovery publication.
Limit this reuse to the guarded save acknowledgement; do not extend it to project
opening, History or draft restoration. Keep the response and saved basis immutable.

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
  In source builds, **Not now** and Escape close the notice after its local marker
  attempt settles, even when that optional write fails. Do not claim a saved
  choice on failure; deliberate consent decisions still require acknowledgment.
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
- Privacy choices reflect the acknowledged saved profile. Older status reads must
  not replace newer choices. Distinguish loading or unavailable Contributor progress
  from a failed choice save; provide a read-only status retry in this surface.
  A status failure after a confirmed save must not imply the choice failed to save.
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
In source builds, dialog dismissal uses plain Escape only; Ctrl/Command/Alt and
AltGraph combinations retain their native meaning. Plain Tab and Shift+Tab still
contain focus. Track composition within the active dialog so an unflagged IME
Escape cannot close it; leaving that field clears stale composition ownership.

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
- In source builds, a failed update recheck always offers **Check again**, even
  after an earlier offer. Hide that stale offer's download/install actions.
  An explicitly focused manual check moves focus to the persistent dialog before
  its button disappears or disables; completion does not move focus.
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
  When a matching draft cannot yet be restored, explain the actual blocker:
  unfinished text entry, an active project task, a media change, another action,
  or unsaved edits. Associate that help with Restore while keeping Download and
  Discard available outside a restoration check.
- Retrying replacement-backup loading moves focus to the persistent **Close**
  button before the temporary retry action disappears. Reveal Close immediately;
  delayed success or failure must not change the user's subsequent focus.
- Explicit playback and caption-preview recovery hands focus from its changing
  action to the persistent, visibly focused **Media preview** region. It is
  programmatically focusable without adding a routine Tab stop; Tab can continue
  into its controls. While the region itself owns focus, playback and Fine timing
  shortcuts stay inactive. Automatic preparation and completion do not move focus.
- If an audio-replacement check expires while its acceptance checkbox owns focus,
  reveal and focus the persistent Cancel control before removing the checkbox.
  A newer field, another mode or a foreground dialog keeps its own focus.
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
Plain Enter or blur applies one edit; plain Escape discards the typed draft without
closing the workspace. Modified Enter/Escape, AltGraph and composition events,
including legacy composition keystrokes, leave the draft untouched.
Empty or invalid drafts restore the current value. New numbers
use the slider's bounds and step; simply focusing a saved fractional value never
rounds it. Each changed numeric setting offers a small reset to its named Studio
default, preserving sibling settings and participating in the existing Undo/Redo
and local autosave. Keep the unit visible and the numeric/reset targets at least
44px on mobile. Reset look retains its separate decoration-only meaning.

Tools uses compact, labeled groups without a repeated menu introduction. Keep
action names, useful explanations, disabled reasons and attention counts. Tools
and caption-row menus focus the first action on opening; Arrow Up opens at the
last enabled action. Up/Down wrap, Home/End jump, and typing finds actions.
Disabled actions are skipped. Tab leaves the menu. Escape closes the focused menu
and returns to its trigger while keeping the current workspace open. Structural
caption actions restore focus to the resulting caption if the
trigger was removed. Menu navigation must never run playback or timing shortcuts;
Ctrl/Cmd+F and modal focus priority remain intact. These changes describe source
behavior, not public-release availability.

Caption-row menu items retain 44px touch targets on narrow layouts, including
wrapped prerequisite explanations. Position the inline popup within the visible
caption region, accounting for enclosing scrolling, sticky preview/toolbars and
pane resizing. An occupied fixed toast stack also bounds the menu where their
columns overlap; observe toast size changes and preserve its recovery actions.
Keep the focused action visible inside the menu after placement;
menu scrolling must not move the caption list or media. Opening beside the lower
viewport edge may reveal the minimum extra workbench space needed for an action,
once for that opening. Do not chase subsequent user scrolling. Dismiss a menu
whose trigger is no longer visible or whose remaining space cannot fit an action.

### Activity and first-open tools (source-only)

Activity keeps each job's title, status, message and measured progress readable
at a glance. Put elapsed time in a stable, tabular-numeral column and percentage
beside the bar. Completed jobs retain **Took …**. Stage names, update timestamps
and video-file specifications belong in the native **Details** disclosure.
Errors, export-freshness notices and recovery/download actions stay visible.
Keep server ordering, status and action eligibility authoritative; 100% alone
does not mean completed, and cancellation requested still means stopping.

Distinguish loading, a loaded empty history and an unavailable Activity list.
A failed refresh keeps existing rows and open Details, labels them as last
loaded, and offers **Retry activity**. Manual refresh acknowledges the request
and prevents duplicate activation; routine background updates remain quiet.
A late read must not replace feedback from newer accepted success or failure.

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
When the focused Retry button is activated, move focus immediately to the
persistent **Close tool** control and reveal it below the mobile preview.
Loading, success and failure do not take focus from a newer interaction.
Export's initial heading focus yields to a retry target, newer editor control or
foreground dialog while preserving ordinary opening and return from repair.
Source recovery must accept supported local project paths containing spaces;
path decoding cannot weaken the running-build and allowed-module checks.
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
Retain existing focus on Save while its request is pending and after it becomes
Saved. Use semantic unavailability with an explicit activation guard so pending,
composition, conflict and other disabled states cannot submit. Unavailable Save
stays out of sequential Tab navigation; completion never takes focus from a newer
task. Keep its unavailable appearance and the existing request/receipt ownership.

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
Project details accepts only plain Escape and the exact Ctrl/Command+F handoff.
Menus similarly ignore composing keys and unrelated modifier combinations for
opening, navigation, dismissal and Tab. Preserve Shift+Tab and uppercase typeahead.

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
Select the prefilled Find query once when the sheet opens so typing can replace
it directly. Later typing or focus changes must win over opening-time selection.
Associate invalid regular-expression feedback with the Find field and announce
the error; keep the exact draft editable and Apply unavailable until valid.

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
Guard a pending refresh synchronously and keep the refresh control focused while
showing its unavailable/busy state. Closing and reopening History admits a fresh
read; a previous visit's response cannot replace or unlock that read.

Copying correction and diagnostic reports confirms **Copied** only after a
successful clipboard operation. Keep keyboard focus and guard duplicate requests.
If both clipboard methods fail, offer the report as selectable text inside the
same surface. Copy never sends the report elsewhere.

Settings keeps edited glossary text through unrelated profile updates and late
save responses. Topic-pack creation retains its name until the captured pack is
acknowledged; newer names and context remain intact. Confirm only acknowledged
content, including normalization omissions. Topic-pack deletion uses the same
pending-write guard, names the affected pack in progress and receipt feedback,
and remains retryable after a missing or failed acknowledgment. Before disabling
or removing the focused Delete action, reveal and focus the persistent Topic
packs heading; completion leaves newer focus alone. Profile-import failures stay in the
form, retain drafts and support retrying the same file. Local file validation
expects an exported Studio profile; server normalization and privacy rules remain
authoritative. These form drafts are not new persistent recovery storage.

Accuracy's **Save globally** owns a captured normalized glossary and its receipt.
Guard repeated submission synchronously, show **Saving globally…**, and compare
the acknowledged vocabulary before reporting success. Keep the full raw draft on
partial or failed saves; distinguish newer edits from the earlier saved glossary.
Publish only the vocabulary field while its starting state is still current, so a
late response cannot undo newer global glossary acknowledgements or other settings.
Associate the inline receipt with the current project's vocabulary field and clear
it when that field changes. Pending controls retain existing keyboard focus.
Keep the Accuracy action row within the inspector width so its labels remain
visible. Actions wrap as the panel narrows and retain 44px mobile touch targets.

System check keeps progress, completion and retryable failure inside Settings.
Label a retained report **Last loaded report** during another check or after a
failure; do not present old green results as a current successful check. Keep the
Run/Retry control focused through pending work and preserve newer focus on finish.
Closing or reopening Settings never duplicates the request. A successful AI
connection change invalidates current and pending reports from the older settings.
The full-width System check action retains a 44px minimum across idle, pending
and retry states.

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
does not erase a typed replacement. Cancel returns to **Forget saved key**;
confirmation moves focus to the persistent key field before removal starts and
reveals that field immediately. Completion must preserve any newer field focus.
Key storage and connection authority remain unchanged.

Export history retains same-project records during refresh or failure, labels
them as last loaded, and offers an in-place retry. Clear records across projects;
never present failed or pending reads as an empty history or an up-to-date list.
Existing content comparisons still include unsaved edits and retain their receipt
semantics.
Distinguish a pending content comparison from one that failed. A failed comparison
shows unknown freshness and offers a local retry even when the content has not
changed. Keep successful comparisons for other formats and ignore late results
for an old content basis. Activity's completed-video comparison uses the same
failure and retry distinction; downloading remains independently available.

Quick guide includes a collapsed Keyboard shortcuts section, grouped into editing
and playback versus Review-only actions. Show Command/Option on macOS and Ctrl/Alt
on Windows. The guide uses one scrollable body below its persistent header;
shortcut help does not change key handling or add another workspace.

These refinements are source-only and do not establish public-release availability.

### Review navigation, pending actions and precision input (source-only)

Keep a caption still while it is already inside the list's comfortable tracking
band. Sequential Review reveals a target only when needed, with immediate
correction when a filtered row disappears. Preserve the surviving row's viewport
position, manual browsing and keyboard focus. Respect reduced-motion preferences
in scripted scrolling as well as CSS; deliberate distant jumps may still animate.
Review's keyboard Previous/Skip actions share the visible buttons' queue limits.
At a disabled boundary, preserve selection and leave playback and scrolling
undisturbed. Turning
Follow on reveals the playhead cue without selecting it or releasing owned
playback. Perform that reveal in the initiating action; a later queued jump must
not override a newer Follow toggle or manual selection. Current explicitly selects.

Activity acknowledges Cancel and Resume immediately on the affected job. Disable
duplicate actions while the request is pending, keep other jobs usable, and retain
the pending state when Activity closes and reopens. **Requesting stop…** describes
the submitted request; **Stopping…** requires server acknowledgement. Failures stay
retryable. Late reads and mutation responses must not replace newer job evidence,
and a resumed job's completed result is handled once even if its response is lost.

Fine Timing uses pointer-aware acquisition around caption and word boundaries,
with visible hover intent. Keep the drawn edges exact and preserve locked edges,
nearest-edge selection, body movement and click-to-seek. Expand pane-divider
targets around the existing layout track without covering neighboring controls.
Keep caption-row actions at least 36px on desktop and 44px on narrow touch layouts.

Timestamp fields accept surrounding whitespace, Khmer digits and a decimal comma
in a complete colon-delimited timecode. Normalize those unambiguous inputs before
strict timing validation, then display the canonical timestamp after commit.
Malformed, ambiguous and out-of-range drafts remain editable with an error;
Escape restores the current value. Enter during IME composition does not commit.

These refinements describe source behavior, not a released download.

### Startup availability and deliberate shortcuts (source-only)

Home keeps the upload action recognizable while preferences are loading or
unavailable. Explain the prerequisite beside the upload surface and point to
Retry startup after failure. Reserve **Uploading…** and upload busy semantics
for a submitted media import; an unrelated task has its own waiting explanation.

Settings opens the same dismissible sheet while required preferences and AI
connection settings load. Keep its header, close action and focus ownership
through loading, failure, retry and the ready form. **Retry settings** reuses the
startup recovery path without overwriting already loaded settings. Closing before
data arrives must not reopen the sheet. Topic-pack Apply requires an open project
and explains that prerequisite on Home.

Playback, Review and timing shortcuts accept only their documented chords.
Other modifier combinations, AltGraph and composition keystrokes must not trigger
an edit, approval, seek or workspace dismissal. Holding an approval key consumes
repeat events without advancing through additional decisions. Deliberate timing
nudges and navigation keep repeat behavior. These refinements are source-only.
Native video/audio controls own ordinary player keys, Escape and timing shortcuts.
Global caption and waveform listeners yield to the media host, including events
retargeted from native controls. Exact Ctrl/Command Save and Find remain available.

### Guide navigation and caption import (source-only)

Open a completed comparison from Activity at its heading. Put the preview switch
and wording ahead of the decision buttons, then offer optional refinement. Keep job
progress visible when refinement is collapsed. An unavailable saved preview font
links to the font picker in Appearance and leaves the saved choice with the user.

Quick guide is a nonmodal companion. Focus its Close control on explicit opening,
allow Tab to leave for the editor, and return focus to a connected launcher only
while the guide owns the interaction. Escape respects composition and foreground
dialogs or menus. Hand off focus before opening Settings; Accuracy receives its
description field, while Review and Export receive the named workspace. Reveal
these destinations without smooth motion, and cancel stale focus requests.
Preserve a tooltip's pending dismissal when focus moves to an unhinted control;
an old keyboard hint must not remain stuck over the newly opened guide.

Caption-data import keeps its preview readable during active caption processing.
Disable Replace captions with a visible, associated reason; Keep current captions
remains available. An independent video render does not block caption replacement.
Keep and Replace hand focus to the persistent Captions file control at activation,
so removing the preview or finishing a delayed request never loses or steals focus.
Preview arrival may focus and reveal its heading only while the initiating import
still owns focus. Later caption editing, player use, dialogs and output choices
win. A preview retained in Captions file mode never suppresses the video mode's
checks; returning to Captions file exposes the existing Keep/Replace decisions.

### Resource recovery and word timing focus (source-only)

Appearance offers separate read retries for local fonts and saved appearance
presets. Keep the current appearance, query, preset-name draft and last-loaded
resources through pending or failed reads. Resource request ownership must yield
to later successful font and preset mutations. Distinguish checking or failed font
verification from a confirmed unavailable choice. Font search handles only plain
navigation, commit and dismissal keys; modified keys, AltGraph and composition
retain their normal input behavior.

Font import publishes the added families even if appearance changed while waiting.
Auto-select the imported family only while the original typography choice still
belongs to that request; font/weight changes, presets, Undo and Reset take priority.
Report whether the font was added or selected accurately, including a Regular
fallback. An unrelated color adjustment does not cancel ordinary font selection.

Project-library Retry hands focus to its persistent heading before the loading
state removes the button. Return to results or Retry only if that heading still
owns focus when the request settles; later Search, Sort or Settings interaction
wins. Storage rechecks retain one polite status for progress and completion,
announce failures inside Settings, and label retained counts as last-loaded.

After explicit word-timing Cancel or preview decisions, focus Sync words after
the control is available. Successful manual word creation and confirmation focus
the selected word chip without advancing. Use a one-shot action-owned handoff
after the commit, with a named panel fallback when the preferred control is
unavailable. Yield to newer focus or a foreground dialog. Keep the focused target
visible without smooth scrolling. Async sync completion never requests focus,
and timing, lock, history and approval rules remain unchanged.

### Comparison drafts and preset decisions (source-only)

Automatic regeneration delivery owns only the comparison view and edit revision
captured when its job was submitted. Opening, closing or editing a comparison
invalidates that automatic handoff; recheck ownership after fetching the completed
proposal. Keep newer wording and Accuracy hints in place, and announce that the
new take is available in Activity. A resumed or externally discovered job without
that snapshot must not replace an open comparison. Deliberately opening a result
from Activity retains its existing meaning.
Expose the selected Current/Proposed version with `aria-pressed` on both the
comparison switch and its matching Preview actions. Keyboard activation and
wording edits keep these states synchronized with the actual preview.
When comparison mode has no workspace toolbar, collapse its empty mobile band
and let the sticky preview start at the workbench edge. Keep desktop arrangement
controls available.

Include textareas in the narrow inspector's existing scroll margins for the
sticky preview, both at normal height and when a comparison notice makes it
compact. Check focused wording with a visibility hit test; focus alone does not
prove that the preview leaves the field readable.
Comparison card headers must not inherit the outer app header's stacking level;
keep them beneath the sticky video and verify its bottom controls remain exposed.

When proposed wording is empty, mark the editable field invalid and associate a
nearby explanation. Disable Accept text only and full-proposal acceptance until
wording is present. Keep current and Accept timing only remain distinct decisions.

Save grouping preset has independent pending feedback and a synchronous duplicate
guard that survives closing/reopening the grouping workspace. Acknowledge the
submitted mode and character target only after they are confirmed in the response;
preserve newer control values and unrelated newer profile preferences. Save and
Apply grouping remain separate actions.

Correction Inbox decisions focus their named card at activation. If it disappears
from Pending after success, hand off to the next surviving card, then the previous
one, or the persistent Pending filter. History retains its resolved card; failure
restores the available initiating action. Invalidate the handoff when the user
changes focus, filter, or dialog visibility. Reveal the chosen target instantly.

Export preset Retry and positively confirmed Delete focus the persistent Manage
presets summary and reveal it instantly before loading disables or removes their
temporary controls.
Cancel keeps the confirmation dialog's normal return behavior. Async completion
never requests another focus move or changes the user's current output choices.

### Profile, navigation and caption recovery (source-only)

Publish profile acknowledgements by the submitted fields, comparing each with its
captured client basis. Preferences are independent keys, not a replacement object.
Keep the existing optimistic preference interaction and send only changed keys.
Full profile reads/imports preserve fields changed since their request began.
Import may merge glossary terms into the current Accuracy form only if that draft
revision and project visit still match; otherwise retain the exact newer raw draft.
Settings must not show an old glossary as current after a newer global save.

Profile import uses one structural file check in the picker and server replacement
path. Reject missing or mistyped core sections before any profile write or privacy
reset. Keep startup loading, patch semantics, legacy optional fields and deeper
normalization under their existing rules. Invalid-file recovery preserves local
form drafts and lets the user choose the corrected file again. For a valid file,
show the backup name and the scope of replacement before offering **Keep current**
and **Replace profile**. A retry applies to the file the user already confirmed.

An acknowledged import invalidates profile reads in mounted Export and Appearance
workspaces. Refresh their preset catalogs and reconcile removed selection IDs;
preserve current output settings, project appearance, typed names and focus.
Imported Last used is an explicit choice. Older reads cannot replace the refreshed
catalog, and import refresh does not start a font scan or reapply appearance.

Explicit Recent/All projects Open may hand focus to the persistent Project details
control after the new editor commits. Its accessible description identifies the
project even when the compact header is shown. Failure may restore its own
reenabled Open control. Back to Home continues at upload. Returning to All projects
focuses the original project even if its refreshed summary moves it to another page. Arm these handoffs only while the initiating
control still owns focus after any required save, cancel them on newer interaction,
and yield to guides and dialogs. Background project publication never arms one.

Appearance save Retry hands focus to its persistent status before removing the
button; give that target visible focus and the sticky-preview scroll margin.
Confirmed font removal focuses Khmer font; confirmed appearance-preset deletion
focuses Saved presets. Make no completion-time focus move. Failure keeps the
current appearance and retry path; Cancel uses the dialog's normal return target.

Review Undo owns only approval transitions it actually made, at the captured
post-approval caption revision. Skip changed or removed captions and explain
partial results. A fully stale action never alters captions, selection or playback.
When its Undo control owns focus, continue at the persistent header Review control,
clear of the preview and notice, without scrolling the editor.
Add caption must not create a cue past a known media duration; clamp its default
tail length or explain the missing room before changing draft or playback-follow.
Its focus/reveal handoff runs once after the new row commits, while the originating
action and new selection still own it. Never schedule an independent delayed focus
that can reverse a newer caption or player interaction.

Starting per-caption Sync words uses the word panel's existing action-owned focus
handoff before disabling its trigger. Keep the named controls and Cancel reachable
while waiting; completion never requests focus after a newer interaction.

### Connected save and recovery journeys (source-only)

Treat each file selection as one immutable upload attempt. Retry uses that attempt
and captured file/title; an uncertain response offers an exact saved-result check
and deliberate Open. Never infer creation from a filename or automatically submit
a replacement attempt. Keep recovery actions readable and at least 44px tall, and
keep their keyboard focus through pending checks. Successful creation follows the
same owned project-entry focus handoff as explicit project opening.

Persist only the immutable upload ID, file name/size/type/modification time and
capture time before submitting. Reload may offer a saved-result check, never an
automatic upload. Reselection must match the recorded details and still requires
explicit Retry. Keep unresolved reminders when starting another attempt; forgetting
a reminder is distinct from deleting a project. Exact stored-record ownership
guards late checks, opens and cross-tab cleanup. Warn truthfully when the optional
bounded browser record cannot be written; keep the active File usable in that page.

Appearance drafts enter the shared unsaved state synchronously, before debounce.
Header Save, tool flush, navigation, updates and unload protection observe the same
revision. An older write may finish without acknowledging a newer draft; explicit
Retry and Save flush the latest draft even after the tool closes. Capture all edit
revisions before awaiting existing saves, then cancel older navigation if input
arrives. Keep the current media, captions and focus mounted on failure.

Capture Appearance in the existing bounded unfinished-edit journal synchronously.
An appearance-only record includes its complete normalized look and saved-look
basis, without caption/Accuracy content. Restore is explicit, rechecks exact record
ownership and media, then uses the normal guarded save lane. Keep the canonical
project visible until Restore; update an already-open Appearance form and preview
together without remounting media or duplicating the save. Do not restore focus
after newer interaction. An already saved look needs no write; a foreign saved
look permits Download/Discard only. Compare appearance inside the server project
transaction; only this lane's acknowledged writes may advance a queued draft's
basis. Export also compares its reviewed saved look and never writes appearance.
Offer Cancel check while a recovery read is pending. Cancelling or navigating away
aborts that read and immediately releases its controls; a late finalizer cannot
disable or clear a newer project's recovery. Explicit cancellation returns focus
to Restore only while it still owns the interaction.

New caption/Accuracy captures use the field-specific version 3 contract, with a
lossless compact version 4 fallback for large caption copies. Compare only
the fields included in that payload and omit unrelated private baseline text:
Accuracy-only copies carry no caption comparison, and caption-only copies carry
no Accuracy comparison. Mixed records guard every included field, including any
Appearance. Keep the conservative interpretation of version 1/2 records and the
appearance-only version 2 format. Current media and fresh canonical timing remain
authoritative. Neither schema version nor a matching saved text grants stored
approval or word tracks authority.

Treat a return to the old caption text during an intermediate pending save as a
newer unfinished intent. Capture it from queue admission through acknowledgement;
an unconfirmed submitted write keeps its comparison copy until an owned save
establishes the result. Never clear that copy merely because the editor currently
equals an earlier baseline.

When several copies exist, put a native labeled **Recovery draft** selector in
**Preview draft**. Options identify capture time and field categories without
private text. Keep it enabled during a check: selecting another copy cancels the
old read, clears its conflict and retains focus on the selector. Announce selected
status politely and keep a 44px target. Restore, Download and Discard use only the
selected exact key/raw snapshot; viewing another copy requires no destructive step.
On narrow screens, place persistent recovery in a bounded scrollable footer and
compact the sticky Preview so the mounted video and caption editor remain usable.
An unavailable browser recovery copy offers Download edits immediately; avoid a
duplicate action when the save-failure notice already offers it. Keep that warning
in the same bounded mobile footer while the edits remain unsaved. When that footer
changes the caption viewport, keep an already-visible focused text or timing field
visible with a nearest-edge reveal after layout. Preserve native focus, selection
and Follow; do not pull a field that was already offscreen back into view.
Use the same reserved footer for persistent save failures at every width, keeping
the Export inspector's final controls reachable. Native caption focus must exclude
the sticky evidence from the outer workbench's scrollport without adding that
padding inside the nested caption list. Complete that focus reveal once after
layout when the field intersects the outer viewport, with the same active target
still owning it. Cancel on blur or unmount; later browsing and notice-dismissal
focus returns must retain their scroll position. Recovery actions remain reachable through
ordinary Tab navigation within the footer. When an inspector action is revealed
before focus leaves Captions, apply the sticky exclusion once: its own margin
must not add that exclusion again to the outer workbench padding.

Saved-appearance read errors have their own GET-only retry. Retain the latest known
look while loading; request, media and edit ownership guard its acknowledgement.
Read recovery never turns into a write. Transfer focus from the disappearing Retry
action to the persistent status before starting, without a later focus move.

Remember optional per-project/source Export metadata after direct output choices,
without turning hydration, capability fallback or delayed preset receipts into
new stored decisions. Preserve same-source choices when an operation renews its
editor ticket. A different source uses matching remembered choices or ordinary
defaults. The bounded seven-day browser record contains output settings and IDs,
handoff choices and disclosure state, never draft text, preview results or render
authorization. Reading it cannot start a render, download, import or layout check.
Storage failure explains that current choices remain usable while the project is
open. The profile's Last used and named presets retain their separate ownership.
Keep completed layout diagnostics only in the current export visit so repair trips
retain the problem context. A changed basis labels earlier findings as previous
advice, never verified current output, and omits targets that no longer exist.
Explicit support rechecks invalidate that evidence across tool returns.

Background failures and interruptions use the shared toast stack with the project
name and Open Activity. Do not open a modal over active text or composition. Give
Activity a persistent return target before removing its notice. A result-read error
after processing completes is a loading failure with an explicit Open result retry;
it must not rerun generation. Newer notification dismissal, edits and Activity
visits take precedence over an older completion.
Show **Opening result…** on its existing action without removing keyboard focus.
Ignore repeated activation while that exact open is pending. Closing Activity
withdraws the open intent and retires its project/proposal reads; it leaves current
evidence and playback alone. Announce the pending action and the close-to-cancel
option through the existing Activity status.

Keep Activity reachable on Home and All projects while any job history exists,
including after the final active job finishes or its notice is dismissed. Show a
count only for active jobs; completed downloads and recovery actions remain inside.
An unreadable Activity file must remain a visible retryable error. Never let an
empty event-stream snapshot disguise that error or replace the file. Recheck storage
on the ordinary explicit Retry path. New and resumed queued states become visible
and executable only after persistence; failed admission retains the prior state
and identity. Keep sampled progress and existing terminal/update-tail behavior.
If the running-state write fails, expose an interrupted same-ID Resume action
without starting work or stranding another queued project. Publish ordinary stop
and terminal feedback to live subscribers even when persistence fails, and recheck
cancellation/current status inside the progress mutation lane.

A verified export records its exact publication identity before final rename.
If that receipt cannot persist, do not publish the file. If completion persistence
fails after publication, retain completed/nonresumable feedback and Download video
with a clear Activity durability warning. On restart, show **Checking output** in Activity
without blocking startup while the exact receipt-owned file is streamed for size
and SHA-256 verification. Matching bytes recover the same result; only a missing
file offers explicit same-job Resume. Unreadable, changed or unverified output
shows **Completion uncertain** with the export folder and guidance, never a guessed result or
automatic render. Recheck current job ownership after verification and serialize
Resume against an active same-project job of the same kind.

Explicit caption Edit selects its current unlocked field synchronously. Manual
native seeking ends bounded timing playback ownership without pausing or reseeking;
only the audition's own initial and loop-restart seeks retain that ownership.
Native pause/seeking also releases Review and comparison looping, including any
delayed post-edit replay. Leave the selected caption and saved loop preference
intact; ordinary native Play does not rearm the retired pass. Keep native playback,
volume and dismissal keys on the player host in its controls rather than treating
them as caption approval or workspace dismissal. Documented Ctrl/Command Save and
Find shortcuts keep their existing editor-wide behavior.

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

Refresh collection metadata when returning to Home/All projects, on foreground
return while that collection is visible, and through **Refresh projects**. Retain
search, sort, page and newer locally published summaries across delayed replies.
Keep the last loaded collection on failure with an in-place retry. Do not fetch
all caption bodies, replace an active editor, or start processing during a refresh.

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


### Source-only stalled playback recovery

Keep stalled-player recovery within Media preview with the existing Retry playback
and Prepare playback actions. Do not move focus on a background watchdog warning
or natural recovery. Explicit recovery retains the existing media-region handoff.
A stopped progress check offers Check progress and Cancel preparation. Neither
checking status nor retrying the player reloads the project or discards drafts.
