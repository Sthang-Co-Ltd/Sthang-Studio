# Export checks and caption repair

Status: included in [Sthang Studio 0.88.0 Public Beta](V0.88-RELEASE.md).
The product manifest and release record contain the verified publication evidence.

## Workflow

1. Open **Export** and select the intended output.
2. Read **Check before export** and open **View captions to review**. Each issue explains its effect on that output,
   identifies the caption by number, text and time, and suggests a correction.
   Blockers open automatically. Long lists have Previous issues and Next issues controls.
3. For video or styled ASS, choose **Check layout** to measure the whole draft at
   the relevant resolution using Studio's local native caption renderer. ASS uses
   source geometry. The check includes the actual overlapping caption groups.
4. Choose **Go to caption** to select, reveal and inspect a listed caption in the
   relevant editing workspace. Source playback remains available.
5. Choose **Back to export** after editing. The current output, video settings,
   caption destination and advanced selection remain available during repair.
   Recheck the layout after changing it, then export through the normal save path.

Finish export review dismisses the return affordance. Temporary choices are scoped
to this editor visit and source. Switching project or media resets them.

## What blocks an output

| Finding | Effect and recovery |
| --- | --- |
| Invalid or empty caption in a caption-file handoff | The serializer requires valid wording and timing; correct or deliberately remove the affected caption. |
| Invalid Unicode/control text, unrepresentable blank lines or timing precision | A caption-specific blocker follows the selected serializer. SRT/VTT blank-line restrictions do not block TTML/data; styled ASS uses the 10 ms timing grid. |
| Malformed or stale saved word evidence | Every caption-file handoff first captures a portable snapshot. Repair the indicated corrupt track before downloading. Missing tracks may remain absent and partial tracks retain their explicit state; they do not block ordinary SRT. |
| Missing, partial or stale word timing | Word-per-caption SRT/VTT requires complete usable timing. Open Word timing, sync or adjust it, and explicitly apply the reviewed result. |
| Unresolved words with video word highlighting | Advisory: the affected caption retains its normal color. It does not lose its base appearance. |
| Unresolved words in the handoff kit | Advisory: the kit omits word-timed files until all captions are ready. |
| Unrepresentable word cue in an all-ready handoff kit | The kit includes both word-SRT and word-VTT, so their serializer restrictions also block the kit and identify the affected caption. Ordinary SRT remains independent. If any caption lacks ready timing, the kit omits both word files and does not validate files it will not create. |
| Readability, speech timing or overlap review | Advisory: review against the source; an intentional choice may remain. Existing render-warning confirmation still applies. |
| Unavailable saved font or weight | Choose an available font/weight in Appearance for styled output. Studio does not substitute one silently; plain SRT is independent. |
| Appearance could not be loaded or saved | Video and ASS show the prerequisite failure in Check before export. Use **Retry appearance load**, or **Retry in Appearance** and its existing **Retry** save action. ASS and Check layout stay blocked until the saved appearance is verified for the current project/source; plain SRT does not depend on appearance. |
| Measured native layout extends outside the frame | Inspect the listed caption or overlap group in Appearance, adjust size/width/position and recheck. |
| Layout cannot be safely measured | No fit result is established. Read the recovery message and retry; final rendering retains its own mandatory check. |
| Saved-project conflict or failed save | Existing draft protection applies. Keep/download and compare the draft or retry the save through the editor before export. |
| Portable JSON exceeds the file-size limit | Studio data and kits show a project-level blocker using the same serialized-byte limit. Other eligible caption formats remain separate. |

An overlap-group result identifies all captions painted in that native state. It
does not claim that each member individually caused the overflow. Duplicate
native layouts retain attribution to their corresponding caption occurrences.

## Snapshot and performance boundaries

The explicit layout request carries the current draft captions, word tracks,
appearance, output resolution and expected media identity to the local server.
It does not save captions, align words, generate AI text, queue a render or transfer
content to a hosted provider. Expensive native work is requested deliberately;
the existing lightweight caption QA can update with editing.

A result belongs to the exact request. Editing captions, word timing, appearance,
output resolution or fonts invalidates it. Rechecking local export support also
invalidates an earlier layout result. Leaving the check or cancelling aborts its
ownership; a late response cannot mark a newer draft as checked. Returning from
repair requires a fresh check rather than certifying old pixels.

Checked layout is limited evidence about frame fit. It does not certify wording,
audio alignment, readability, destination-editor behavior or the final encoded
file. The final export still saves through existing guards, captures its own
immutable snapshot, performs mandatory native bounds validation and verifies the
finished file. Later edits do not alter a running render.
Archive entry/total limits, available disk space and final file preparation are
still enforced during export; caption checks are not a guarantee that a file
can be written on this PC.

## Source evidence

- `apps/web/src/export-checks.ts` reuses QA and word-readiness rules.
- `apps/web/src/components/ExportChecksPanel.tsx` presents issues and check state.
- `apps/web/src/components/ExportWorkspace.tsx` owns check requests and validity.
- `apps/web/src/App.tsx` owns project-scoped repair navigation and return state.
- `apps/server/src/services/export-preflight.ts` and the video-export route perform
  bounded local checks without mutating a project or creating an export job.
- `apps/server/src/services/caption-overflow.ts` retains the native measurement
  authority and adds caption attribution to rejected native states.

See [validation](EXPORT-CAPTION-REPAIR-VALIDATION.md) for checks and the reproduced
baseline font limitation, and [public-impact intake](EXPORT-CAPTION-REPAIR-PUBLIC-IMPACT.md)
for documentation and release coordination.
