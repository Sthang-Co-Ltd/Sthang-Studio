# Original Looks and caption effects

Status: included in Sthang Studio `0.85.5` for Windows and Apple Silicon macOS.

## Choose a Look

Open **Appearance**, then choose **Clean**, **Bold Outline**, **Soft Shadow**,
**Solid Box**, **High Contrast**, or **Soft Glow**. These are original Studio
decoration recipes, not imported CapCut templates or bundled third-party assets.
The cards are illustrative samples; judge the result on the video preview.

A Look applies to **all captions in the project**. It changes text color,
outline, shadow, background and glow settings. Your selected font, weight, size,
alignment, width, position, Motion and word emphasis remain unchanged. Manual
decoration adjustments show **Custom** instead of falsely marking a stock Look.
**Reset look** restores Studio's default decoration while preserving those other
choices. There is no automatic gallery playback.

Use **More appearance** for individual settings. Glow has a color, width and
opacity; its translucent lower layer is softened by native blur without resizing
or individually laying out Khmer words. Large effects can extend beyond the text:
check captions close to the picture's edges on the actual preview.

## Motion and Replay effect

**Motion** offers **None**, **Fade**, **Rise**, and **Soft Pop**. Fade changes
opacity in and out. Rise brings the caption gently upward into its saved
position; Soft Pop grows the complete caption from approximately 94% to its saved
size without overshoot. Rise and Soft Pop settle during the entrance and fade
out at the end; they do not move or shrink again during the exit.

Choose 80–400 ms using **Fade duration** or **Motion duration**. Captions lasting
80 ms or less appear immediately at normal opacity and geometry: a one-frame
caption must not disappear because its only frame was a transparent entrance.
Other short captions automatically shorten the transitions. **None** or **Turn motion off** disables motion without resetting the
Look or word emphasis. The scope is the whole caption, not separate bouncing
words. Per-word scale/bounce, texture and 3D animation are not included.

While multiple captions overlap, Rise and Soft Pop keep the combined layout
still and apply each caption's own fade. If any part of a caption's entrance
overlaps another caption, that entire entrance stays still, including before and
after the brief overlap. This prevents a jump from a steady layout back into
partial motion. Appearance displays the overlap constraint when it applies.
The original caption clock still controls opacity, preserving readable
simultaneous captions and the existing seek-stable line arrangement.

**Replay effect** prepares the selected caption's opening and plays it once with
a short listening margin. It also works with **Motion → None**, so you can judge
a static Look or word emphasis. The target caption is shown beside the replay
controls. **Cancel preparation** stops a pending replay before it starts;
**Stop replay** ends its playback. It does not loop the gallery or start merely
because you selected a Look. New appearance/caption edits, changes to the selected
range, project/media changes, or leaving the workspace cancel pending replay work.
Seeking with the source player's controls ends replay ownership and preserves your
chosen position and playback. Ordinary preview follows the source clock during
playback and paused seeks.

Replay waits for a confirmed compatible font and caption text. Font-discovery
errors are distinguished from a font being unavailable. Adding or removing a
font refreshes the preview's cache and error state automatically, including when
you re-add the same font family. An older discovery response cannot replace the
new inventory or leave the workspace permanently loading.

Preparation is bounded to 16 distinct opening paint states, requested in batches
of at most eight. Later states are prepared as needed. Combining fades, word
highlighting and overlapping captions can create more states than that opening
budget; first playback can therefore show a preparation indicator. Cached native
frames are scoped to the current project/content/appearance and remain bounded
to 24 images and approximately 32 MiB of encoded image data. This is not a promise
of real-time rendering on every computer or a guarantee that an entire caption
has been pre-rendered before replay.

Motions use at most 16 entrance levels and 16 opacity levels on the native
subtitle 10 ms timing grid. Their clock is the original caption start/end, not a
word-highlight event's start. Rise has a maximum travel of 12 pixels at 1080px
frame height. Soft Pop compensates the available native line width in proportion
to its scale, avoiding the line-wrap changes caused by simply making text
smaller. It keeps the original alignment anchor. At the resting size/position,
neither effect adds geometry overrides. Decoration widths remain the existing
native style values; this is not a promise that every glow/shadow pixel scales
as a single bitmap.

Normal caption text remains a complete shaped run. Review focus is a separate
non-exported mask: it follows the same motion geometry while ignoring opacity,
and remains identifiable at transparent entrance boundaries.

## Word emphasis and corrected wording

**Word emphasis → Spoken word highlight** retains the existing timed color
feature. It is independent of Look and Motion. A caption with uncertain or stale
word timing keeps its chosen Look and Fade but does not highlight words until the
timing is usable. Correct wording, use **Fine timing → Word timing**, then sync,
adjust or confirm the affected words. No timing is invented from character or
syllable counts to make an effect appear synchronized.

## Save, undo and transfer

Appearance saves automatically. **Undo / Redo** retains one appearance change
while the workspace is open. A slider gesture is one change rather than many
intermediate positions. Choosing a Look, applying a saved preset or resetting
the Look is also one change. This local undo does not change caption History or
reverse wording/timing edits. Leaving Appearance clears that local undo state.

**Manage presets** saves the complete current appearance, including typography,
placement, Glow, Fade and word emphasis. Applying a saved preset intentionally
restores that full appearance; applying a starter Look changes only decoration.
Save captures the appearance when clicked. Changes made while that save is in
progress remain your current appearance and are not falsely labeled as the saved
preset. A delayed initial preset list cannot erase newly saved entries.
An unavailable font remains explicitly unavailable, and a missing Bold face uses
the established disclosed Regular fallback.

The native preview, styled ASS and captioned MP4 use the same appearance recipe
and temporal paint plan. MP4 bakes the result into the picture. SRT, WebVTT and
plain TTML still carry editable caption text/timing without these effects. Other
editors can discard ASS styling, so an accepted import is not an effect-fidelity
guarantee. See [Caption handoff](CAPTION-HANDOFF.md).

Studio caption-data **version 3** preserves Rise/Soft Pop as an appearance
reference. Glow/Fade data still uses version 2, and default-effect data still
uses version 1 without the newer fields. The updated reader accepts all three
versions. Earlier readers reject newer versions explicitly; version 2 cannot
contain the new motion names. Never change a file's version number to bypass
those checks.
The existing captions-only restore keeps the receiving project's appearance;
the included reference does not silently replace it.

## Implementation and verification

The shared recipe/settings live in `packages/shared/src/caption-looks.ts` and
`caption-settings.ts`; `caption-layout.ts` owns the cue-clock opacity states.
`caption-renderer.ts` composes layer opacity explicitly for every caption so ASS
overrides cannot leak across line breaks. Snapshot preview preserves original
timecodes and freezes the requested state; it does not reset fade phase to zero.

Rise changes the native vertical margin during entrance states only. Soft Pop
uses the original anchor and a proportionally compensated horizontal margin
budget, scaling the full native text run uniformly. The renderer adjusts the
scale to the integer available-width budget, including unequal left/right margins
when needed, so rounding cannot change the intended wrap ratio. The same geometry
is applied to Glow, Background, text and Review masks. Overlapping captions keep
their established single-block layout, with geometry neutral and opacity local
to each cue. Native syntax reference: https://aegisub.org/docs/latest/ass_tags/.

Relevant checks: `test:caption-effects`, `test:caption-effects-native`,
`test:caption-renderer`, `test:caption-handoff`, `test:video-export`,
`test:browser`, `typecheck`, and `build`. Tests use synthetic media and existing
local runtimes; no paid AI requests or private footage are required.

An isolated 640x360 synthetic test found eight-frame Fade preparation faster
through the existing one-shot batch than through eight persistent document
reloads. Routing changes only for a full eight-frame Fade request; one-to-seven
samples retain the persistent path. These measurements concern this local
preview fixture, not generation speed or representative 4K performance.

The polish pass also caches plain wrapped/escaped caption text inside one ASS
document construction, reusing it across Fade, Glow and background layers. It
does not cache AI results, change subtitle events, or alter word-highlighting
paint. In a 1,000-cue synthetic comparison on the same machine, document
construction changed from about 610 to 118 ms for Fade and from about 1,633 to
198 ms for Fade+Glow+Box. The compared ASS fixture remained byte-identical.
These are script-preparation timings, not whole-video export times or a claim
about every device. The timing-state planner was measured and left unchanged
because its proposed rewrite did not provide a meaningful improvement.

Validation recorded for the initial effects implementation (`2f0d1a8`):

| Check | Result |
| --- | --- |
| Complete browser regression suite | 128 passed, including 10 effects cases |
| Look ownership and bounded replay planning | 7 passed |
| Native effects and actual captioned MP4 | 7 passed |
| Existing native caption rendering/persistent preview | 19 passed; one optional FFmpeg 7.1 fixture unavailable |
| Caption handoff/schema compatibility | 29 passed |
| Export, fonts, preview planning and persistence | 64 passed |
| Media clock | 4 passed |
| Performance and timing-cache contracts | 24 Node tests and 17 Python tests passed |
| Contributor, analytics and consent boundaries | 19 passed |
| Type checking and production build | Passed with brand verification |

Desktop and 390px layouts were inspected. Review feedback led to explicit
per-caption alpha resets, a fade-independent single-caption Review mask, softened
Glow, readable sample strokes and bounded mobile playback. These fixtures verify
the supported behavior; they do not establish universal real-speech alignment,
all-editor style compatibility or a new public release.

The follow-up polish validation covered 136 distinct browser scenarios: 135
passed in the full run, and the long-Khmer phone/tablet case passed after its
assertion was corrected to use the browser's own grapheme segmentation rather
than the test runner's different ICU. All eight new polish scenarios passed.
The same source passed eight Look/planning/preparation tests, seven native
effects tests including actual MP4 output, 64 export/persistence tests, 28
Fine Timing/playback tests, 29 handoff/schema tests, type checking and production
build. Desktop, 390px, 320px and 768px layouts were inspected. A final independent
read-only review found no remaining material issue in the scoped changes.

## Rise / Soft Pop validation — 20 September 2026

The complete browser run covered 145 scenarios, with 144 passing immediately.
The remaining new overlap-context assertion incorrectly required a fresh request
at one timestamp despite valid cached paint reuse. It now checks that every
relevant request retains the entrance blocker. After that test correction and
the final short-cue safeguard, all 19 targeted Motion/Effects browser cases
passed, including all nine new motion cases. Phone layouts at 320/390px and a
768px tablet layout were inspected.

Final checks passed: 19 Look/planning/preparation tests, 16 native effects/motion
tests, 64 export/font/persistence tests, 31 caption-handoff/schema tests, type
checking and production build. The existing renderer/persistent-preview suite
passed 19 tests, with its optional FFmpeg 7.1 fixture skipped because it is not
installed. An initial Node test-runner transport error in the font suite cleared
when the unchanged file ran alone; the final complete 64-test export suite passed.

The native suite renders actual MP4 files and compares decoded caption regions
against the exact native preview at **160 ms entrance**, **400 ms middle**,
**840 ms exit**, and **920 ms after the cue ends** for Fade, Rise and Soft Pop.
Caption visibility and exit paint energy are checked as well as pixel differences
within a union of entrance/resting bounds, with a tolerance for video encoding.
Post-end preview is transparent and the decoded MP4 returns to the background.

A separate real 25fps test exposed the one-frame case: a 0–40 ms caption had
1,306 painted pixels with no motion but none with the previous transparent
entrance. The 80 ms instant policy fixes it for all three motions; the regression
now checks visible encoded frame zero, unchanged resting geometry, and a blank
next frame. Native checks also cover short overlap blockers, saved anchors,
odd-width portrait layout, hard-wrapped unspaced Khmer, word-boundary seeking,
Review-mask geometry, and minimum-bottom-position decoration clearance.

These are local source validations using synthetic media and installed native
runtimes. They do not establish public release availability, universal frame-rate
or hardware performance, or effect fidelity in another editor.

## Public impact and publication handoff

Public impact: **required**. Change ID: `studio-original-looks-fade-20260920`.
The follow-up replay/preset/font polish uses change ID
`studio-effects-polish-20260920`. The Rise/Soft Pop and encoded-exit validation
extension uses `studio-rise-soft-pop-20260920`. These development records are
bundled into the `0.85.5` release. Product evidence includes this guide, README,
CHANGELOG, PRODUCT/DESIGN, PRIVACY, the caption-data schema notes, and the
`0.85.5` product manifest/release evidence.

Proposed HQ updates concern the Studio feature/public-claim representation,
documentation-impact record and local appearance-data description. Known
Distribution surfaces are `landing/studio/index.html` and
`docs/studio/index.md` at the `/studio/` website/docs routes. The Distribution
README was inspected read-only; its exact plan-digest/approval-class workflow
still applies. No authorized HQ intake or new synchronization approval was
provided here. Complete the governed HQ intake and Distribution synchronization
with reviewed release evidence before public advertising; do not reuse an old
release exception. There are no cross-repository writes, new cloud services,
dependencies, copied effect assets, font distributions or telemetry categories
in this implementation.
