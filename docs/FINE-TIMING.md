# Fine Timing

Status: source implementation, unreleased. The existing `0.85.4` release identity
and download/update evidence do not establish that these changes are installed.

## Adjust a caption

Open **Fine timing** below the source player. Select a caption in the list or use
**Previous** and **Next**. The waveform focuses on a few seconds around that
caption, even in a long recording. **Full clip**, **Focus caption**, and the zoom
controls switch between orientation and close timing work. The navigation slider
scrolls the displayed time range without changing captions.

Click the audio area to move the playhead. Drag a caption's left or right handle
to change its start or end; drag the middle of its bar to move it without changing
its duration. A drag previews locally and becomes one edit when released.
**Escape**, pointer cancellation, or lost pointer capture cancels an unfinished
drag. Clicking without dragging does not create a timing edit.

Start and End accept seconds (for example `12.375`), `m:ss.mmm`, or
`h:mm:ss.mmm`. Fractions can contain one to three digits. Press **Enter** or leave
the field to commit a valid value. **Escape** restores the accepted value. Invalid
or out-of-range text stays uncommitted and shows a recovery hint. The caption-list
timestamp fields follow the same rules.

Use **− / +** on either edge, or **Move earlier / Move later** for the whole
caption. The step can be **10**, **50**, or **100 ms**. Movement stays within the
source duration and preserves at least 40 ms between a caption's edges. Moving
captions past one another also updates their list/save order chronologically;
neighbouring timings are not silently changed. Overlap is shown explicitly.
**Set to playhead** is enabled only when that position is legal for the edge.

## Listen and compare

**Replay caption** plays the caption with a short 120 ms margin on each side,
bounded by the source. **Hear start** and **Hear end** play 500 ms on either side
of the respective edge. **Loop** repeats that chosen audition until stopped.
Changing caption, editing, seeking through Studio, leaving the workspace, or
changing project/media cancels the timing audition. Ordinary source-player
playback and sequential Review remain separate.

On desktop, source playback stays above the independently scrolling timing
controls. On narrow screens it remains visible while scrolling the timing area.
Playback speed is under **Snapping, playback speed and display**.

## Snapping, locks, and recovery

Word snapping uses existing start estimates for starts/moves and existing end
estimates for ends, with a small screen-distance tolerance. Those marks are
estimates, not a fresh transcription or a guaranteed caption-to-word mapping.
Quiet-gap snapping requires a clear, sufficiently quiet energy drop; flat audio
does not force a jump. Hold **Shift** while dragging to bypass snapping, or turn
it off in the options. Spectrum remains an overview of the recording; use the
waveform and source playback for close boundary work.

Timing locks disable edits while retaining playback and navigation. Unlock timing
from the caption's menu. Numeric timing and source auditions remain usable when
waveform loading fails and the source duration is known; the preview can be
retried independently.

**Undo / Redo** retains the latest 50 Fine Timing edits while this workspace is
open. Undo restores timing and its review metadata, never overwrites a subsequent
text/lock/approval edit, and does not reverse unrelated work. Closing the workspace
clears this local undo stack; ordinary project autosave and History remain the
persistent recovery path. A new timing change marks the caption unapproved.

While Fine Timing is open, **R** replays the caption, **Alt+Left/Right** moves it by
the chosen step, and **Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** undo/redo timing. Text
fields keep their own typing/undo behavior. These shortcuts do not change Review
auto-advance or enable a background playback loop elsewhere.

## Validation and public handoff

Run `npm run test:fine-timing`, `npm run test:performance`, `npm run typecheck`,
and `npm run build`. The browser suite covers interactive timing, waveform reuse,
project/media replacement, keyboard edits, locks, playback, and narrow layouts.
Tests use synthetic fixtures and make no paid AI requests.

Public impact: required for the changed timing workflow. Proposed change ID:
`studio-fine-timing-generation-20260918`. Product-owned evidence is this guide,
the README development section, the Unreleased changelog, `WaveformEditor.tsx`,
`CaptionEditor.tsx`, and the timing helpers/tests. The existing product manifest's
release version, verified release claims, download actions, brand assets, and
data-processing declarations remain unchanged.

Before advertising the new controls as released, maintainers must run the governed
HQ intake and Distribution synchronization for Studio's `/studio/` website/docs
representation using reviewed release evidence. The corresponding downstream
checkout files and approval digests have not been inspected or authorized by this
local implementation task. Proposed documentation updates cover selection-focused
timing, committed timestamp entry, bounded replay, and undo scope. Do not promise
a general generation-speed percentage or an automatic caption-to-word retiming
feature. There is no new provider, cloud transfer, dependency, telemetry category,
installer, updater, or branding change in this implementation.
