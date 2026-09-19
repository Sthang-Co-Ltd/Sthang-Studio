# Original Looks and caption effects

Status: unreleased source implementation. These controls do not establish that
the published Windows/macOS packages contain the feature.

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

**Motion → Fade** fades each caption in and out. Choose 80–400 ms for each side.
Short captions automatically use shorter fades so the two sides cannot exceed
the caption duration. **None** or **Turn motion off** disables motion without
resetting the Look or word emphasis. This first version provides Fade only; it
does not implement Rise, Pop, per-word scale/bounce, texture or 3D animation.

**Replay effect** prepares the selected caption's opening and plays it once with
a short listening margin. It does not loop the gallery or start merely because
you selected a Look. New appearance/caption edits, project/media changes, or
leaving the workspace cancel pending replay work. Ordinary preview follows the
source clock during playback and paused seeks.

Preparation is bounded to 16 distinct opening paint states, requested in batches
of at most eight. Later states are prepared as needed. Combining fades, word
highlighting and overlapping captions can create more states than that opening
budget; first playback can therefore show a preparation indicator. Cached native
frames are scoped to the current project/content/appearance and remain bounded
to 24 images and approximately 32 MiB of encoded image data. This is not a promise
of real-time rendering on every computer or a guarantee that an entire caption
has been pre-rendered before replay.

Fades use a shared palette of at most 16 opacity levels on the native subtitle
10 ms timing grid. Their clock is the original caption start/end, not a word
highlight event's start. A new spoken word or an overlapping caption must not
restart another caption's entrance. Normal caption text remains one fully shaped
run; Review focus is a separate non-exported mask and remains identifiable even
at a transparent fade boundary.

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
An unavailable font remains explicitly unavailable, and a missing Bold face uses
the established disclosed Regular fallback.

The native preview, styled ASS and captioned MP4 use the same appearance recipe
and temporal paint plan. MP4 bakes the result into the picture. SRT, WebVTT and
plain TTML still carry editable caption text/timing without these effects. Other
editors can discard ASS styling, so an accepted import is not an effect-fidelity
guarantee. See [Caption handoff](CAPTION-HANDOFF.md).

Studio caption-data **version 2** preserves nondefault Glow/Fade settings as an
appearance reference. New readers accept versions 1 and 2. Default-effect data
continues to export as version 1 without the newer fields; old version-1 readers
reject version 2 explicitly. Never relabel a v2 file as v1 to bypass that guard.
The existing captions-only restore keeps the receiving project's appearance;
the included reference does not silently replace it.

## Implementation and verification

The shared recipe/settings live in `packages/shared/src/caption-looks.ts` and
`caption-settings.ts`; `caption-layout.ts` owns the cue-clock opacity states.
`caption-renderer.ts` composes layer opacity explicitly for every caption so ASS
overrides cannot leak across line breaks. Snapshot preview preserves original
timecodes and freezes the requested state; it does not reset fade phase to zero.

Relevant checks: `test:caption-effects`, `test:caption-effects-native`,
`test:caption-renderer`, `test:caption-handoff`, `test:video-export`,
`test:browser`, `typecheck`, and `build`. Tests use synthetic media and existing
local runtimes; no paid AI requests or private footage are required.

An isolated 640x360 synthetic test found eight-frame Fade preparation faster
through the existing one-shot batch than through eight persistent document
reloads. Routing changes only for a full eight-frame Fade request; one-to-seven
samples retain the persistent path. These measurements concern this local
preview fixture, not generation speed or representative 4K performance.

Validation recorded for this source change:

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

## Public impact and publication handoff

Public impact: **required**. Change ID: `studio-original-looks-fade-20260920`.
Product evidence includes this guide, README's Development changes, CHANGELOG's
Unreleased section, PRODUCT/DESIGN, PRIVACY, and the caption-data schema notes.
The `.sthang/product-manifest.json` still describes the separately governed
0.85.4 release. Its source version, download links, approved identity and verifier
must not be rewritten merely to advertise this local feature.

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
