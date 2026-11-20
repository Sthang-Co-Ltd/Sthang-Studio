# Sthang Studio product context

## Product

Sthang Studio is a short-form video finishing workspace. Its flagship **Captions**
module helps Khmer-speaking creators generate accurate wording, align it locally,
review difficult moments quickly, style finished captions against the real video,
and choose between a portable subtitle file or a finished captioned-video render.

The published release state is governed separately by release evidence. A feature
being present on `main` is not proof that it is available in the current public
download.

## Primary users

- Cambodian TikTok and short-form creators.
- Many users are comfortable with mainstream video editors but are not developers.
- Experience ranges from first-time caption-tool users to power users who need waveform timing, locks, correction memory, regeneration diffs, and quality-controlled export.

## Primary job

> Upload a video, generate accurate Khmer captions, quickly verify the few uncertain parts, optionally style the captions while watching the video, then export either editable timed captions or a finished captioned video without learning a professional subtitle application.

## Aha moment

The first captioned playback stays synchronized through the full video, with Khmer
wording that is materially better than generic caption tools and an obvious path
to correct any remaining issue. When the creator styles a finished captioned video,
the editor preview responds on the actual footage, that saved project appearance
remains visible while they continue reviewing, and the same layout and appearance
are preserved in the exported picture.

## Core workflow

```text
Upload → optional accuracy context → generate → review flagged captions → export
                                                ↘ Appearance (optional) ↗
                                                          ↳ SRT
                                                          ↳ Captioned video
```

Everything else is secondary and should appear progressively, at the moment it becomes useful.

## Project caption model choice

Current source exposes a collapsed **AI options** disclosure with Automatic,
Gemini 3.8 Flash, Gemini 4 Hydrogen, and Gemini 3.6 Flash. The choice saves locally for this project;
it does not change Settings or another project. Automatic uses the configured
primary/fallback policy. An explicit model uses only that model for new generation,
range regeneration, Alternative take, and Deep Verify. Exact-word local realignment
still makes no AI request. Details retains the actual model that produced wording.

Each new persisted caption job snapshots its effective model pair at admission.
Resume retains that pair; changing the project choice affects a new job, not an
existing job or review proposal. Older jobs without a pair snapshot Automatic on
their first execution after upgrade. Model choice alone must not change the
caption content revision, overwrite captions/context, or expire a review proposal.
The original Automatic/Flash choices are published in [0.89 release evidence](docs/V0.89-RELEASE.md).
Hydrogen is an optional development addition pending a reviewed release. Automatic
still defaults to 3.8 Flash with 3.6 Flash as fallback. Supported context-aware
caption models use an explicit low thinking level; legacy environment overrides
cannot raise it. See [model choice and request policy](docs/GENERATION-MODEL-CHOICE.md).

## Editor layout contract (published in 0.89)

On wide desktops, the editor keeps a large media preview, the full caption-list
pane and one optional tool inspector side by side. Opening or switching a tool
does not reduce the preview's allocated size or remount the media or caption list.
The contained picture retains its aspect ratio. **Arrange panels** offers preview
left/middle/right presets and all six orders through drag or keyboard controls.
The grip and title in each panel header also reorder directly, without opening
Arrange panels. Header arrow keys and Home/End offer the same ordering, with
visible focus and spoken feedback; adjacent header action buttons stay independent.
During a header drag, the real panel follows the pointer and its neighbours
slide aside at their midpoints to preview insertion. A marked vacant slot shows
the destination. This draft order is saved only on a valid drop; cancellation
restores the committed arrangement.
The chosen desktop order survives closing/reopening the tool; moving the two
remaining panes retains the hidden tool's slot. Closing tools preserves preview
width, and the caption list absorbs the freed space.

Fine timing docks its waveform beneath captions and the inspector when those
panes are adjacent. With the preview in the middle, it docks beneath captions
only; the preview and tool retain their full height. Reordering never reparents
the media or caption list. Layout changes cancel pending timing drags before new
geometry can turn them into caption edits.

Pane dividers resize their actual neighboring panes with pointer or keyboard.
Their proportions and the three allowlisted pane IDs are optional local browser
preferences, with **Reset layout** restoring both. Caption and
tool scrolling are independent; the ordinary generated-caption view reserves no
empty inspector. **Close tool** returns to video and captions. Review keeps its
existing flagged queue, decisions and playback rules.

Reordering requires browser support for matching visual and keyboard reading
order; unsupported browsers retain the canonical order and working resizing.
Smaller screens keep preview first and retain the desktop preference. Current source
uses a compact preview while a tool is open so its controls are easier to reach.
The caption list and tools remain available through scrolling. Appearance starts with Looks,
font, color, size and position; Motion, word highlighting, saved presets and
additional styling use labeled disclosures. Existing saved settings, native
preview/export behavior and all editing actions retain their existing meaning.
The desktop arrangement controls shipped in the verified 0.89.0 packages and signed offers.

## Caption appearance contract

Caption appearance is **project editing state**, not an export-only setting.
Creators may style captions before export while watching the real video evidence.

- Appearance is available as a focused editor workspace for video projects once
  captions exist to judge.
- The common path is deliberately small: preset, Khmer font, text color, size and
  position. Weight, outline, shadow, width, alignment and background styling stay
  progressively disclosed.
- Studio discovers compatible Khmer families already installed on the creator's
  computer. Creators may also choose **Add font…** and supply local `.ttf`/`.otf`
  files; Studio stores those user-selected copies in local application state for
  preview/export without installing them into the operating system or bundling a
  font catalog with Studio. Added fonts remain removable from the secondary font
  manager, while system fonts are never removed by Studio.
- The actual editor caption overlay reflects the current project appearance so the
  creator can judge it against their footage while styling **and** while moving
  through Review, Fine timing, Accuracy, Caption grouping, and Details. Appearance
  is where the look is edited; it is not a temporary visual mode.
- Preview/export **layout parity is a contract**. Studio uses a native caption
  preview pipeline powered directly by local FFmpeg and libass (`shaping=complex`),
  generating transparent RGBA PNG frames rather than approximating layout via
  browser CSS. Preview geometry is projected onto the contained video rectangle
  via `containedVideoFrame`, ensuring that preview and export share the same native
  caption layout and rasterization contract before video encoding; lossy encoding
  and display scaling may soften pixel edges without changing the intended typography,
  line layout, alignment, position, or effects across responsive viewports. Interactive
  controls and dialog buttons maintain accessible >= 44px touch targets on mobile viewports.
- Project appearance saves automatically and survives leaving/reopening the
  workspace. Reusable presets remain local creator-profile conveniences.
- During size/position edits, an existing matching native frame may move/scale
  immediately while the exact frame is being prepared. This temporary interactive
  approximation is labeled and must never be presented as final layout parity.
  Release, cancellation, keyboard release and blur flush the newest settings;
  only a decoded native frame for those settings restores the exact-preview state.
  Errors remain visible and retryable instead of silently certifying old pixels.
- Active styling prioritizes the visible caption state (including overlaps), not
  a full-project render. Native preview workers are local, bounded and disposable;
  the established one-shot native renderer remains the compatibility fallback.
- An unavailable saved font is preserved and disclosed; Studio must not silently
  change the creator's typography. Captioned-video rendering requires an available
  local export font when the saved choice cannot be honored.
- Font search reveals matching families while the creator types; finding a result
  must not require opening the native font selector afterward. When a selected
  family has no Bold face, Studio may fall back to Regular automatically, but only
  that unsupported weight changes and the adjustment is disclosed to the creator.
- Appearance never changes SRT serialization, caption text/timing, locks,
  correction eligibility, correction memory, Review behavior, or source media.

## Original Looks and Motion contract

Appearance separates starter **Look**, **Motion**, and **Word emphasis**. Six
original Looks change decoration only; the creator's font, bold/regular choice,
size, width, alignment, placement, motion and spoken-word color remain intact.
Saved user presets intentionally contain the complete appearance. Scope is
project-wide. Local appearance Undo/Redo covers one change or slider gesture;
Reset look restores decoration without resetting the independent choices.

Native Glow and Fade share the preview/ASS/MP4 recipe. Fade opacity derives from
each original rounded caption interval, not split word/highlight events, and
cannot leak between overlapping captions. Short fades remain bounded by the
caption duration. Native word layout/shaping is never rebuilt as separate words
to create these effects. Review focus stays separate and ignores visual fade.
Replay is explicit, prepares only a bounded opening and then plays once. Missing
or retained frames are labeled preparing/updating; only a decoded native frame
for the current appearance and paint state is presented as exact.

Replay works with static Looks as well as Motion, identifies its selected caption,
and exposes Cancel preparation / Stop replay. A manual seek releases playback
ownership without snapping back. Font-library changes invalidate both cached
pixels and preview errors; late discovery responses cannot undo those changes.
Preset saves capture their click-time appearance and never label later edits as
belonging to the saved preset.

Settings and derived preview data remain local. Caption-data v2 retains nondefault
Glow/Fade settings; v1 stays supported and unknown versions fail explicitly. Normal
subtitle handoff remains text/timing only. These additions do not establish a
published package, CapCut-asset license or universal editor effect transfer.

Rise and Soft Pop extend the same clock and native render path. Rise is a small
vertical entrance; Soft Pop scales the entire caption from approximately 94% to
100% with proportionally compensated native wrapping width. Both fade out without
exit travel or scale. Geometry stays neutral during overlapping intervals, with
that constraint disclosed in Appearance. An entrance that intersects any other
caption stays geometry-neutral throughout, preventing jumps around brief overlaps.
Each caption retains its own opacity phase. Review masks follow geometric motion and ignore visual opacity.
The final resting layout is the existing untransformed native layout. Captions
lasting 80 ms or less bypass motion at full opacity/geometry, so a transparent
entrance cannot hide the only video frame that contains a brief caption.

Caption-data v3 is emitted for Rise/Soft Pop. Existing Glow/Fade settings retain
v2, defaults retain v1, and the current reader accepts all three; v2 explicitly
rejects the new motion values. Acceptance includes decoded MP4 comparisons at
entrance, middle, exit and after caption end with caption-region/visibility checks.

## Word timing and spoken-word highlight contract

Fine Timing separates **Caption edges** from **Word timing**. Caption edits
prevent new/increased neighbor overlaps by default; intentional overlap and a
two-caption shared transition are explicit operations. No timing edit silently
pushes all following captions away from unchanged speech.

Each editable word track belongs to one exact caption text snapshot. Its UTF-16
offsets must be grapheme-safe and cover the spoken text. Stable stored offsets do
not depend on browser and server ICU versions reproducing identical word splits.
Whole-caption movement translates owned word times; edge trims never stretch
them. Text correction, splitting, merging, regrouping, regeneration, locking, and
History must preserve only timing that still matches the resulting wording.

Changed or ambiguous words need exact local alignment or human confirmation.
**Sync words** applies a ready, revision-bound result in Fine Timing and records
it for Undo. Tentative results are available as an optional preview for manual
recovery. Word-only changes preserve the caption’s wording, outer boundaries,
and Review approval.

**Sync words** can suggest an edge repair when a short caption's measured
speech falls outside the saved cue. A local alignment with adjacent captions
must support the new cuts. Preview the full change and apply explicitly as one
timing edit. Applying clears Review approval for the changed cues, and Undo
restores their previous edges, word timing, and approvals.

In unreleased source, turning on **Word highlighting** starts a local Apply.
**Apply to all captions** is available when an older project already has the
look on. Ready legacy tracks retain their paint and timing. For marked tracks,
supported words light individually, measured groups share one highlight interval,
and unsupported words keep the normal color. Word-by-word files require separate
usable intervals. Ordinary SRT uses caption text and cue timing.

Studio prepares project audio locally, checks eligible captions, and publishes
the results in one guarded write after normal saves settle. Apply arms the
project to recheck affected captions and neighbors after later saved wording
or cue changes. Armed projects can resume on reopen. Presets affect appearance.
**Review remaining** prioritizes uncertain and plain captions and opens Fine
Timing. **Sync words** uses the armed project’s guarded check for one caption.

**Cancel** keeps the saved paint and ends follow. Turning the effect off also
disables paint. **Undo** restores the exact prior tracks for the accepted Apply
when the targets still match and stops follow. History is the recovery path when
later timing or wording edits prevent the guarded inverse. The Word highlighting
summary retains focus when its explicit controls disappear.

Source-only Khmer alignment refinement preserves each directly forced-aligned
KFA acoustic word interval until the final wording is reconciled. Differences
between Khmer display token boundaries and KFA orthography cannot create
fabricated internal acoustic edges or make a proportional split highlight-ready.
Word sync can remeasure such a split using the exact displayed words as separate
alignment inputs. Keep the new boundaries only when they fit the original
measured span and its unchanged neighbors. If both passes independently place a
pause inside one display word, preserve the measured parts as separate exact
text spans so the pause uses the normal caption color.
Treat a Khmer word and its repetition sign `ៗ` as one written unit in timing and
caption wrapping. Use the measured timing for the exact marked unit.
Raw KFA CTC path scores are not calibrated ASR confidence and must not themselves
trigger word review; lexical correspondence, measured interval validity, and
explicit uncertainty still govern readiness. Local faster-whisper fallback word
timestamps retain usable caption timing but remain review-required for word
highlighting until exact local alignment or manual confirmation. Existing stored
word edits are not silently rewritten by this change.

Appearance may enable an optional current-word color while the entire caption
remains visible. It is off by default. Every spoken span in a caption must have
usable timing; partial/stale/estimated tracks leave that caption plain and expose
a clear editing path. Pauses use the normal text color. Word color changes must
not change Khmer shaping, line wrapping, placement, or Review-focus geometry.
Native preview and rendered MP4 consume the same exact paint states. SRT remains
plain cue text/start/end, with no word-highlight metadata. Appearance/export
reports how many captions will remain plain before a render.

Source-only Phase 3 responsiveness must favor the **currently spoken word** over
future native paint requests. The video-frame clock can refresh the small native
overlay at paint boundaries independently of slower whole-editor time updates;
it must not force the full editor to render on every video frame. Native paints
remain revision-/look-/media-owned, non-destructive and bounded; missing paint
data may show a pending state but never mislabeled old word color as exact.
Preview pixels, Review Focus, motion and Khmer layout continue to use the same
native ASS rules as captioned MP4. Short prefetch batches and repeated-ASS reuse
are optional performance aids, not new timing evidence or export semantics.

## Export contract

### Editable handoff

Export separates finished captioned video from editable caption files. SRT remains
the default for documented major-editor imports. A destination selector explains
CapCut Desktop/mobile and other editor routes; it does not assert universal
native editable-highlight transfer. CapCut mobile's current import route requires
Desktop/Web first and the creator's separate CapCut cloud-sync action.

WebVTT, plain TTML, ready word-by-word SRT/VTT, styled ASS, projected Studio caption
data and a fixed-name ZIP kit stay progressively disclosed. Plain files contain
text/timing; word files change grouping and require complete usable word timing;
ASS is a compatible-renderer reference with font/layout dependencies. No media or
font files are packaged. Times remain relative to source zero without silent
overlap repair, speed conversion or proportional retiming.

Caption-data restore is explicit preview then replace. It validates a bounded
versioned allowlist, preserves valid partial word tracks without promoting them,
checks the current source and snapshot, honors existing locks, checkpoints
History, and restores captions with new identities/unapproved state. Current
media and appearance remain unchanged. Import is not fresh correction evidence
for local learning or Contributor capture.

Sthang Studio has two deliberately different output paths:

- **SRT** remains the portable, editable caption handoff. It contains caption text
  and timing; it does not promise visual-style transfer into another editor.
- **Captioned video** is a new local render with the saved project caption
  appearance baked into the picture. The source media is never overwritten, and
  captions are no longer separately editable inside the exported MP4.

The most recent **accepted** captioned-video render remembers its normalized
resolution, frame rate, quality, codec, encoder preference, and optional bitrate
in the local creator profile. Entering Export for another project or after an app
restart recalls those choices. A canceled or blocked render must never replace
the remembered settings. Profile storage failure must not cancel an accepted
render; Export must warn that its output choices could not be remembered.
An overlapping request that reuses an existing job is not another accepted
render and must not change last-used output settings or the original job snapshot.
Changes made during the current editor visit remain
available while repairing export issues. Creators can save, apply, update by
name, or delete up to 20 reusable **video export presets** independently of their
caption-appearance presets. A preset contains output settings only, not media,
captions, appearance, or render authorization. Local device capabilities are
checked again when applying an older preset; unavailable encoders or codecs must
be explained before safe defaults are used. Even when those choices fall back,
the original saved preset remains selectable for management and confirmed deletion;
the current effective output must no longer appear to exactly match that preset.
Deleting a preset does not modify current or last-used output settings.
Persisted choices live in the
installation's local creator profile, alongside other user presets, and do not
change the immutable settings snapshot of a render already in progress.

Development source also optionally remembers the current Export choices for each
project and matching source in this browser: output type, video settings, preset
identifiers, handoff destination/format and disclosure state. These choices take
precedence over Last used when reopening that source. They survive closing Export,
repairing a caption and reloading, without starting a render, download or import.
The browser keeps up to 20 valid records for seven days, with a 4 KiB serialized
record limit. This metadata includes source identity, not caption/context text or
media bytes. Storage failure leaves the current choices usable in the open editor;
later reopening may fall back to defaults or Last used. Source replacement cannot
reuse choices bound to the old source.

Without remembered project choices, this source version waits for the initial
Last used read before video render and layout checks. Selecting settings makes them
usable immediately and protects them from the late read. A failed read explains
that the displayed settings are kept and offers Retry saved presets; caption-file
checks do not depend on remembered video settings.

For captioned-video export:

- Export focuses on output decisions. It shows a compact summary of the saved
  project appearance plus an **Edit appearance** path back to the editor; it does
  not duplicate the styling controls.
- Match-source is the recommended quality default.
- HD 720p, Full HD 1080p, QHD 1440p and 4K UHD 2160p must preserve source aspect
  ratio/orientation without implicit cropping; above-source output is labeled as
  upscaled rather than presented as recovered detail.
- Match-source frame rate is the default. Fixed 24/25/30/50/60 fps is an explicit
  conversion choice.
- Studio must probe real local encoder/filter/font capability rather than infer it
  from a GPU name or installed command.
- Khmer burned-in captions require the native ASS/libass path with **explicit
  complex shaping**. If the local FFmpeg runtime cannot expose that capability,
  Studio must block finished-video export rather than produce broken Khmer glyphs.
- Output is non-destructive: render to a partial file, verify it, then publish the
  final file atomically.
- Before a render starts, Studio re-reads the saved project appearance and uses an
  immutable snapshot of captions, appearance, export settings and source-media
  identity. Admission compares the reviewed caption content inside that saved
  snapshot transaction; newer saved wording, timing or word-highlight content
  requires another review instead of silently rendering unreviewed captions.
  Later caption or appearance edits do not mutate a running export.
- Video rendering has its own processing lane so a long 4K render does not block
  caption generation or regeneration. Media replacement/deletion remains blocked
  while an export uses that source.
- Long-running caption generation/regeneration and video export expose horizontal
  progress plus elapsed time. Completed work keeps the actual duration so creators
  can tell how long the operation took. Completed captioned-video exports expose
  an obvious **Download video** action and list Studio's fixed local exports folder
  so creators know where the verified MP4 is stored.
- Never silently crop, lower the chosen resolution/frame rate, drop source audio,
  flatten HDR, add a watermark, overwrite the original media, substitute a
  different caption font, change planned line count/geometry, or downgrade Khmer
  shaping without warning.
- HDR10, HLG, Dolby Vision and unknown HDR are blocked until the exact color path
  is validated. An honest block is preferable to a successful-looking export with
  damaged color.
- Release readiness requires representative real render validation, not only the
  browser appearance preview or type/build checks. At least one mixed
  Khmer-English regression sample must confirm correct shaping in the actual MP4,
  and one-line/multi-line samples must confirm preview/export layout parity.

Development source records an exact job-owned publication receipt before the
verified partial video is renamed into its final file. A receipt-write failure
prevents publication. After restart, Studio checks that exact output's size and
SHA-256 in the background while Activity remains available; it does not restart
the render. Matching bytes recover the same job and file as completed. A missing
file permits an explicit same-job Resume; an unreadable, changed or unverified
output remains uncertain and directs the creator to the export folder before a
new render. Resume also refuses another active export of the same kind for that
project. If the file completed but Activity could not save its completion, keep
the verified Download video result and disclose the persistence failure instead
of presenting failed work that invites a duplicate render.

## Export checks and repair (source-only)

Export shows caption-specific issues with reasons, remedies and a direct editing
path. Separate actual output blockers from editorial review suggestions. Preserve
the established word-readiness contract: incomplete word timing blocks word files,
while an affected caption in a video retains its normal color. A video-specific
font or layout problem must not disable a valid plain caption-file handoff.

Go to caption selects and reveals the exact caption while keeping the source
playable. A visible Back to export action retains the chosen output and temporary
settings during repair. Reset repair targets and pending actions on project/media
changes; retain current choices for the same media and recall optional stored
choices only for a matching source. Never let an older repair target or pending
request navigate a different project.

Full native layout checks are explicit and local. They check the current draft,
appearance and output resolution with the existing native bounds authority,
including overlap groups. Do not run whole-project native checks on each edit.
Invalidate results on caption/word/timing, appearance, resolution, media and font
changes; cancellation, incomplete measurement and stale responses cannot establish
fit. Rendering retains its mandatory snapshot validation and save/conflict guards.
The current visit retains the last layout findings through repair-tool round trips.
Unchanged input keeps its exact result; changed input marks the previous findings
as advisory until an explicit recheck. These diagnostics stay in page memory and
are excluded from remembered output choices. Ordinary tool returns reuse valid
local support/font prerequisites; Recheck support remains an explicit fresh check.
No release availability, new persistence category or cloud transfer is implied.

Large drafts may use several bounded native inspection documents. Preserve each
complete temporal overlap group on the renderer's 10 ms clock, original source
order, IDs, word timing and motion relationships. Every document must complete
before the whole draft can pass. Keep one aggregate work budget and deadline;
oversized overlap groups, incomplete measurement or cancellation still block
styled output. Final rendering receives the complete original snapshot. This
source capability is content-dependent and does not guarantee an arbitrary
caption count or establish a new public release.

## Unfinished-edit protection (source-only)

Caption and Accuracy work must remain recoverable while a field still has focus
and while a save is pending or failed. Leaving a project waits for pending writes,
then saves both caption and context edits. Closing/reloading warns only while
unfinished work or a protected media operation remains. Preserve exact Khmer
composition input without forcing it into a save.

Typing back to the earlier saved caption wording while an intermediate save is
pending is still an unfinished intent. Keep that final wording in recovery until
an acknowledgement establishes the saved result. A submitted save with an
unconfirmed response retains this protection; a newer canonical result may
require download/comparison rather than granting the draft new timing authority.

An unchanged save acknowledgement can retain the existing editor rows when all
normalized caption data matches exactly. Canonical changes still reach the editor;
newer typing keeps its own save ordering and unfinished-edit protection.

Failed saves remain visible with Retry and an explicit download of current edits.
Caption and Accuracy saves must compare their acknowledged fields with the saved
project and check the resulting revision again inside the server write lock.
A conflict keeps the local draft and stops queued saves and automatic retries.
Show Download edits and Reload saved project; do not authorize an overwrite from
an unrelated response or silently merge concurrent edits. Valid saves following
the editor's own accepted History, grouping, or regeneration changes must retain
their ordering and preserve typing entered while those operations were pending.
Accepting a whole-caption mutation with a previously unfinished conflicting
draft requires manual comparison before that draft may save over the accepted
result. Do not silently roll back accepted regeneration captions.
A bounded browser copy supports deliberate recovery after interruption. Reopening
shows the saved project first; restoring rechecks exact media and the saved fields
the record contains. Field-specific caption/Accuracy records, including the compact
version 4 fallback for large caption copies, compare only those
included fields: Accuracy-only copies omit caption text/evidence, and caption-only
copies omit Accuracy text. Mixed copies guard every included field. Existing
version 1/2 records keep their conservative checks; appearance-only copies remain
version 2. Changed relevant saved evidence requires manual comparison. Changed
recovered captions are unapproved. Browser recovery cannot supply approval, correction
memory, Contributor evidence, or trusted word timing. Scope, retention and
limitations belong in [unfinished-edit recovery](docs/UNFINISHED-EDIT-RECOVERY.md).

Compact copies preserve exact baseline and editable values within the existing
storage and retention bounds; they do not defer accepted-input capture. Long text
or word evidence can still exceed the byte limit. When browser recovery cannot
keep the current copy, offer Download edits immediately and keep the active editor
usable. Completing composition with unchanged text preserves approval and creates
no additional edit.

When several copies exist, Preview draft offers a labeled Recovery draft selector.
Choose a compatible older copy without discarding a newer one. Changing the
selection cancels its predecessor's pending check and keeps keyboard focus on the
selector; Restore, Download and Discard apply only to the selected exact copy.
While restoration is temporarily unavailable, identify the actual pending task,
action, text entry, or unsaved work so the user knows what must finish first.

## Project discovery and reopening (source-only)

Home keeps a compact six-project recent list beside the upload workflow. A labeled
**All projects** view makes the complete saved collection reachable with project
name search, last-edited/created/name ordering, and bounded 24-project pages.
Search includes projects beyond the current page and preserves Khmer text.

Reopening fetches the current saved project through the existing navigation,
save-conflict, and unfinished-draft recovery protections. A later project choice
or a return to Home cancels ownership of an earlier pending read. The collection's
search and ordering remain in the current tab while its editor is open. On
return, focus follows that project to its current page when it still matches.
Listing/searching uses existing local metadata and does not load every caption
body, start processing, or transfer searches to a provider. Returning to Home or
All projects, bringing that collection back to the foreground, and explicit
Refresh projects update its metadata. A delayed refresh preserves newer locally
published changes; a failed refresh keeps the last loaded collection and retry.
It does not replace the active editor or its unfinished drafts. Reopening does not
promise a restored playhead or automatic playback. These source changes do not
establish public-download availability.

## Saved project readability (source-only)

Unreadable project files, duplicate identities, an unreadable project order, and
incomplete legacy migration must produce a shared notice while healthy projects
remain usable. An unresolved empty library must offer storage review rather than
claim that no projects exist. Settings → System check shows bounded count-only
diagnostics and an explicit read-only recheck. A recheck never adopts external
file changes into active projects. Retain unreadable sources and index references;
do not finalize migration while its source is incomplete. Recovery guidance asks
for a backup, preservation of originals, a stopped app before restoration, and a
restart. Readability does not establish backup integrity or available disk space.
See [saved project recovery](docs/PROJECT-STORAGE-RECOVERY.md).

## Product principles

### Bulk-correction preview (source-only)

Correct everywhere shows each matching caption's original text and exact proposed
replacement before Apply. Locked matches stay unchanged and are labeled; no-op
and empty-text results are explicit. The preview and Apply use the same plan for
literal, case-insensitive and regex modes and the chosen project/selection scope.
Every match is reachable through bounded pages. Cancel changes no captions.
Existing timing, locks, undo and save protections remain authoritative.

1. **Evidence stays visible.** Audio/video remains playable during any decision about text, timing, or caption appearance.
2. **Safe by default.** Regeneration proposes; it never silently destroys reviewed work.
3. **Local where practical.** KFA/Whisper timing and finished video rendering stay local; paid cloud timing remains a last resort.
4. **Reuse completed deterministic work.** Normalized/range audio, local acoustic evidence, exact timing results, and completed stages of the same resumable job should be reused when their signatures still match. A request for a fresh AI alternative must remain a fresh listen.
5. **Fast repeated review matters.** The first pass may perform necessary preparation; subsequent Improve, Deep Verify, exact realignment, waveform reopening, and job resume should avoid repeating unchanged work wherever accuracy and safeguards allow.
6. **Plain language.** Casual users should not need to understand `.env`, forced alignment, CPS, tokens, providers, model names, or timing infrastructure to succeed. Keep implementation names out of routine tooltips and primary workflow copy; disclose them only where setup or diagnostics genuinely require them.
7. **Power without intimidation.** Advanced controls remain available, but one focused tool is shown at a time.
8. **Errors explain recovery.** Messages name what failed, what remains safe, and the exact next action.
9. **Khmer typography is first-class.** Do not apply English word-spacing assumptions to Khmer text; render-only wrapping must respect Khmer grapheme boundaries and final rendering must use complex-script shaping.
10. **Updates never compete with caption work.** Check at most once per Studio
    session plus an explicit manual action, require confirmation before download
    and install, and block activation while editing, Review, regeneration, export,
    or background processing is unsafe to interrupt.
11. **Private unless a creator deliberately contributes.** Caption/audio contribution
    is off by default. Khmer Caption Contributor is an explicit, reversible choice
    that applies only to eligible corrections made after joining; declining never
    reduces caption quality or removes local correction learning.
12. **Verified means verified.** A contributed edit is only candidate evidence until
    corpus QA accepts it. Studio must never inflate contributor progress by calling
    a successful upload a verified correction.
13. **Analytics cannot become content collection.** Optional product analytics is a
    separate explicit choice and is limited to a server-owned event/property
    allow-list. Caption text, media, filenames, project names, context, exports,
    API keys, and Contributor identity never belong in analytics.
14. **Cloud improvement paths fail open for creators.** Contribution/analytics
    outages never block generation, Review, editing, saving, export, or local
    correction memory. Studio remains useful when either service is absent.
15. **Technical export quality is a product promise.** A creator choosing Studio's
    finished-video path should not accept a hidden resolution, timing, audio, color,
    aspect-ratio, Khmer-shaping, layout, or caption-appearance downgrade. Creative
    NLE features remain out of scope unless they directly improve the caption workflow.

## Khmer Caption Contributor

The long-term purpose of Khmer Caption Contributor is to turn high-quality,
consented corrections from real creator workflows into evidence that can improve
Khmer caption technology. The program should help Sthang identify recurring
Khmer speech/transcription errors, build real-world evaluation sets, improve
correction/vocabulary intelligence, compare future models, and eventually prepare
verified training examples where that is justified.

The program has exactly two caption-data states:

```text
Private (default) ↔ Khmer Caption Contributor (explicit opt-in)
```

Contributor onboarding belongs after Studio has already delivered value, such as
a successful export, rather than before first use. The invitation may celebrate
the collective goal of better Khmer caption technology, but it must not shame,
penalize, or repeatedly pressure creators who keep their work private.

There is one migration-only exception: when an installation with evidence of
pre-v0.8 Studio use first runs a version that introduces Contributor, and the
Contributor choice is still unset, Studio may show one dismissible startup
explanation because that creator used the product before this data choice existed.
Fresh installations still use the post-export invitation. Closing or reviewing
the migration notice is not consent, and product analytics remains a separate,
default-off decision. The migration notice is recorded locally so it is not shown
again on every launch; if Contributor remains unset, the normal post-export
invitation may still appear in a later session.

An eligible contribution must trace back to generated wording, contain a material
human correction made after consent, and reach an approval decision. Formatting-
only edits and manually-authored starting captions are excluded. Only the bounded
matching audio clip and the minimum correction/model/timing evidence needed for
quality work may be contributed; the full project/video and unrelated context are
not part of the corpus protocol.

Contributor progress can recognize meaningful participation — for example,
verified correction count and verified Khmer speech duration — without public
leaderboards. Quantity incentives must never encourage fabricated/noisy edits.

## Success measures

- Time from first launch to first successful caption export.
- Percentage of videos completed without manual timestamp entry.
- Number of captions reviewed versus total captions.
- Repeat terminology errors after a correction rule is approved.
- Regeneration proposals accepted without losing locked work.
- Warm selected-range regeneration time versus the first pass on the same range.
- Deep Verify time with upload/emission reuse versus a cold run.
- Resume time after interruption when completed processing checkpoints are available.
- Human correction rate on a stable real-world Khmer evaluation set across Studio/model versions.
- Number and duration of **verified** Khmer contribution samples, kept distinct from submitted candidates.
- Percentage of Contributor uploads rejected as noisy/ambiguous evidence; quality should improve before volume is optimized.
- Contributor withdrawal/deletion requests completed without affecting local projects.
- Analytics funnel measures such as project creation → generation → review/approval → successful export, without collecting caption content.
- Captioned-video render success rate by source resolution/codec/frame-rate class without collecting filenames or content.
- Preview/export line-count and layout parity on a stable caption appearance regression set.
- User-visible caption-generation and export duration, derived from persisted job timestamps rather than analytics-only timing buckets.
- Post-render verification failures, cancellations, and resumptions, using only coarse allow-listed operational buckets if analytics consent is granted.

## Reviewed-caption media replacement (source-only)

Visual revisions of already reviewed footage should not require starting caption
review over. Tools progressively exposes a preserving choice and a distinct
start-over choice. Unchanged audio uses conservative local full-length audio and
timeline verification; duration equality is never sufficient. After complete
file/decoder/timeline validation finds an audio difference, including volume,
music or sound effects, the creator may explicitly accept keeping existing
caption and word times. Bind acceptance to the exact replacement and current
saved project revision. Show a concise alignment-responsibility warning and keep
an unverified-alignment reminder in the reopened project; never call this verified
alignment. Missing, expired, changed-file or stale acceptance cannot replace media.
Overall duration changes, captions beyond EOF, unsafe timestamps, corrupt files,
decode and storage failures remain hard failures. Preserve full caption objects,
approvals, locks, transcript state and appearance. No automatic regeneration or
destructive reset. Block automatic old-transcript regrouping/timing cleanup for
accepted changed audio; retain explicit manual/sync/regeneration review workflows.
Reload new video geometry and ask the creator to inspect caption placement when
the frame shape changes.

A replacement keeps a local recovery of the previous project/media state.
Restoration is an explicit destructive-to-current-state choice with revision guards
and fresh media identity, so stale work cannot overwrite the restored project.
Recovery access survives reopening the project. Clearly describe retention and
local disk use. No released-download availability is implied by this source contract.

## Export freshness (source-only)

Keep a bounded local receipt for the latest prepared output of each caption-file
format and completed video. Compare format-relevant content against the open
project, including unsaved edits. Plain subtitle checks ignore appearance and
review metadata; styled/video outputs include configured appearance and usable
word paint, while Studio data includes its archived review metadata. Media changes
invalidate comparisons. Undoing content to its original state may match again.
Activity retains a separate content fingerprint for each new completed video job.
Missing/legacy, invalid or unreadable evidence is unknown. File preparation is not
proof of disk download, and matching content is not renderer or release validation.

## Review and editing refinements (source-only)

Repeated Review decisions keep the caption list stable while the next target
remains comfortably visible. Removing an approved row from a filtered queue
preserves the next surviving row's position where the scroll range permits it.
Scripted navigation honors reduced motion and preserves explicit playback-follow
and manual browsing behavior.
Review shortcuts honor the same first/last queue boundaries as Previous and Skip;
an unavailable move does not seek or restart the current caption. Resuming Follow
reveals the playing caption without changing the selected caption or taking over
playback. **Current** remains the deliberate action for selecting the playhead cue.

Activity gives immediate, per-job feedback for Cancel and Resume. A pending
request remains guarded across closing and reopening Activity; confirmed job
states and completion still come from the server. Failed requests can be retried,
and delayed responses cannot undo newer job evidence.
Loading or failed Activity reads never appear as an empty history. A failed
refresh keeps the last loaded jobs visible and offers Retry activity. Manual
refresh gives immediate feedback without disrupting job actions or open Details.

Fine Timing provides larger pointer-aware boundary targets and visible hover
intent. Pane dividers and caption-row actions are easier to acquire while retaining
the existing editing layout, locks, neighbor protection, Undo and timing accuracy.
If a delayed restore changes the timing context during a drag, retire the preview
and keep the newer timings; the creator can drag again. Equivalent saved values
and unrelated caption wording preserve the gesture.
Timestamp fields accept pasted whitespace, Khmer digits and complete SRT-style
comma timecodes through the same strict range checks as canonical timestamps.
Caption menus retain usable touch targets and keep the focused action visible
as the caption viewport scrolls or changes size. Deferred-tool recovery remains
available from Windows source folders containing spaces, without reloading the
editor or discarding its draft. Explicit Retry keeps keyboard focus on the
persistent Close tool control while loading, including below the mobile preview.

Importing media, editing captions manually and downloading SRT are available before AI setup.
The empty project library offers Create a project, which focuses the file picker. Users
open Settings or Quick guide when they need them.

Home explains when preferences or another task prevent importing, and shows
Uploading only for an actual media import. Settings opens its existing sheet
while startup data loads, offers Retry settings after failure, and keeps the
same dialog through recovery. Applying a topic pack requires an open project.
Deleting a topic pack guards repeated submission, reports the named saved result
or retryable failure, and keeps a visible keyboard target and other form drafts.
Update recheck failures retain Check again and hide stale download/install actions.
Optional startup-notice dismissal still closes after a failed local marker attempt;
closing does not select or change either privacy choice.

Find & Correct selects its prefilled query once on opening and identifies invalid
regular expressions on the editable Find field. A blank replacement previews removal
and names it on the action. Text locks protect matching captions. Project History guards duplicate
refresh requests while preserving the visible entries and keyboard focus.
Accuracy's Save globally confirms the submitted glossary against the saved result.
Partial saves explain how to retry, preserve the full draft, and never claim every
term was saved. Delayed saves preserve newer Accuracy edits, acknowledged global
glossary changes and unrelated settings.
Accuracy actions remain fully visible in narrow panels and usable on touch screens.
Export-content comparison failures show unknown freshness with a local retry;
one failed format does not discard successful comparisons for other formats.

Quick guide takes keyboard focus when opened and returns it to its launcher when
closed from the guide. It remains nonmodal so the media and editor stay usable.
Its Accuracy, Review and Export actions move focus to the selected workspace
without delayed scrolling or interrupting a newer editing choice.
Moving keyboard focus into the guide also clears the old launcher hint, so a
stuck tooltip cannot consume the guide's Escape action.

Caption-data import explains when active caption processing prevents replacement
while retaining the inline preview and Keep current captions action. Choosing
Keep or Replace moves focus to the persistent caption-output control before the
preview changes; a delayed import response never takes focus from a newer task.
An arriving preview also yields to newer focus or an output-mode change. A retained
caption-import preview never hides captioned-video checks while that mode is active.

Appearance offers separate in-place retries for font discovery and saved-preset
reads. Retrying preserves current appearance and form drafts, and late reads
cannot undo successful font or preset changes. A failed font check is distinct
from a confirmed unavailable font. Modified keys in font search retain their
normal editing behavior; plain arrows browse and plain Enter confirms a result.
An imported font becomes available without overwriting a newer font, preset or
appearance-history choice made while the file was being added.

Retrying the project collection preserves newer Search, Sort or Settings focus.
Saved-project storage checks announce their completion and failures in Settings
while retaining clearly labeled last-loaded evidence after a failed recheck.
System check similarly distinguishes running, completed and failed checks, keeps
old reports explicitly labeled, and offers an in-place retry. Changed AI settings
invalidate reports and prevent an earlier pending check from becoming current.

Explicit word-timing decisions keep keyboard focus in the task: Cancel sync and
preview decisions return to a stable timing control, while manual creation and
confirmation retain the selected word. Late sync responses never move focus.

Comparison wording and Accuracy hints remain editable while another take runs.
If those fields or the open comparison change after submission, the completed
take stays available in Activity without replacing the current comparison.
The same protection covers edits made while the completed proposal is loading.
An unchanged submitted comparison can still open its completed refinement
automatically. Empty proposed wording cannot accept text or the full proposal;
Keep current and timing-only decisions retain their existing meaning.
Current/Proposed controls and the matching Preview actions expose the selected
comparison version to assistive technology as well as visually.
On narrow screens, comparison mode removes the empty toolbar band above the
preview so that space remains available for the video and editable proposal.
On narrow layouts, focusing an inspector text area accounts for the sticky video
preview so the wording being edited stays visible. Comparison card headings stay
below the preview layer to keep playback controls accessible while scrolling.

Saving a grouping preset shows its own pending state and submits one captured
mode/character target. The success message identifies those saved choices while
preserving newer choices in the controls. Failure keeps those choices retryable;
saving a preset does not apply grouping to captions.

Correction Inbox decisions retain keyboard position through pending, success and
failure. A resolved Pending item advances to a surviving correction, or the
Pending filter when none remain. History keeps the resolved card available
from Home after every decision is complete. Review audio keeps a failed project
read on its original card. Success reveals the saved caption and plays its
recorded excerpt with the configured surrounding audio.
Export preset retries and confirmed deletions move focus to the persistent
Manage presets control before their temporary actions disappear. Later responses
preserve newer focus and form edits.

Editor shortcuts match their documented modifier combinations and ignore input
composition. A held approval key performs one Review decision; deliberate
navigation and timing nudges retain their existing key-repeat behavior.
Native video and audio controls retain their own playback, volume and dismissal
keys. Caption navigation and timing Undo do not run while the player owns focus;
explicit Save and Find shortcuts remain available.
Project details, menus and modal dialogs also honor the exact shortcut boundary,
including legacy composition and independent AltGraph. IME Escape stays in the
active dialog's composing field; plain Escape and forward/reverse Tab keep their
existing dismissal and navigation behavior.
Caption menus keep their focused action clear of active notifications, including
persistent save-recovery warnings.

Panel order handles accept bare Left/Right and Home/End. Dividers additionally
accept Shift+Left/Right for larger steps. Composing, unrelated modified and
already-handled keys leave the layout unchanged; plain Escape cancels an active
gesture while foreground dialogs retain their own keyboard handling.

Header Save retains current focus while saving and after showing Saved. Pending
or otherwise unavailable Save remains guarded and is skipped by normal Tab
navigation. Completion preserves newer editing focus and saved-state feedback
still belongs to the submitted edit.

Retry appearance load moves focus from its own retry action to the persistent
Check before export heading before loading. Appearance comparison retry uses the
Export history summary. Later results preserve newer focus; Appearance save
recovery keeps its existing repair navigation.

Explicit playback and caption-preview retries keep a visible keyboard target on
the persistent media preview. Caption-file preparation keeps focus on Captions
file before its download button disables. Later results preserve newer editing.
If an audio-replacement check expires, a focused acceptance checkbox hands off to
Cancel; changed focus remains untouched and expired acceptance stays unusable.

These changes refine existing local workflows. They do not establish availability
in a public release.

Explicit project opening moves keyboard focus to Project details when the
initiating control still owns the navigation. Failed opening returns to that
control; Back to Home continues at upload. Newer focus, dialogs and the first-use
guide take priority over a delayed handoff.

Profile responses update only the fields they still own. Review and waveform
preferences send the changed keys, so independent choices survive delayed
responses. Profile import keeps newer raw Accuracy drafts, while imported defaults
remain available through the profile. Reopened Settings shows newer acknowledged
glossary choices rather than an earlier save's snapshot.

Profile import checks the required sections and asks whether to replace this
computer’s profile. The confirmation names the file, the settings and correction
data it replaces, and the effect on optional sharing. Keeping the current profile
sends no import request. After a failed import, Retry uses the same confirmed file. Incomplete or mistyped sections leave the current profile,
privacy choices and form drafts intact. Older exports may omit newer optional
appearance and video-output fields; existing normalization still applies.

A successful import refreshes saved presets in an already open Export or Appearance
workspace. Imported choices become available without changing the current output
settings or project appearance, discarding a typed preset name, or moving focus.

Appearance save Retry keeps focus on its persistent save status. Confirmed font
removal continues at Khmer font, and appearance-preset deletion at Saved presets.
Cancel retains the initiating action; late completion preserves newer focus.

Review approval Undo changes only captions that action approved and whose applied
revision still matches. Later wording, timing, locks or removal remain authoritative;
partial and fully stale Undo explain what was kept. Add caption fits a trailing cue
inside known media duration, or explains that no room remains without changing the
draft.
Adding a caption continues at its new text only while that action still owns the
interaction. Newer focus and selection take priority. Starting Sync words keeps a
visible keyboard position in the word controls while the request runs, so Cancel
remains reachable; later completion preserves newer editing focus.

Upload recovery distinguishes a proven unsaved attempt from an unconfirmed result.
Retry this upload retains the selected file and exact attempt; a lost response can
be checked and its saved project opened deliberately without creating a duplicate.
Studio retains a published project and its source when only the Recent order fails
to save. Starting another upload is an explicit choice while the earlier outcome
is uncertain. A bounded local reminder now survives reload and reopening Studio at
the same browser address for up to seven days. It contains the attempt ID and file
details, not media bytes. Check for a saved result and Open are explicit; if a file
is still needed, choose the original file and explicitly Retry the same attempt.
Starting another upload keeps earlier reminders. Forget removes only that reminder;
it does not delete a saved project. Storage failure explains the page-only fallback.
An exact saved-upload receipt becomes usable independently of the Recent-project
refresh. A rejected oversized or malformed transfer explains how to choose a valid
file; it cannot erase uncertainty about an earlier transfer with the same attempt.

Appearance changes participate in header Save, leaving a project and browser-close
protection, including changes still awaiting autosave or made before closing the
tool. Failed writes remain retryable and an older acknowledgement cannot mark a
newer look saved. Download edits includes the current unsaved appearance for manual
comparison. Appearance also participates in the bounded unfinished-edit recovery
copy. Reopening shows the saved project first; Restore checks the saved look and
source again before submitting the recovered appearance through normal save guards.
An appearance-only copy contains no caption or Accuracy text. An already saved look
is identified without another write, while a different saved look requires manual
comparison. Restoring into an open Appearance workspace updates its controls and
preview together and retains the media position. Newer interaction retains ownership.
Reopening Appearance retains the latest local look while checking the saved version.
A failed read offers Retry saved appearance without submitting an appearance write.
Video export consumes the reviewed saved look without rewriting it. A newer saved
look discovered during preparation requires reopening Export to review it.

Failed or interrupted background processing names its project in a nonmodal notice.
Open Activity is deliberate and returns keyboard focus to a persistent control on
close. A completed job whose result cannot be read stays completed; Open result
retries loading without requesting generation again. Background completion keeps
newer captions, Accuracy edits and deliberate Activity visits authoritative.
Open result shows pending feedback and ignores repeated activation. Closing
Activity cancels that open intent, including a pending comparison read, so a late
response cannot replace the editor or start playback after dismissal. Slow Activity
refreshes share their current read; a job action still requires a fresh result.
Transcription publication also preserves newer saved Accuracy context and current
project choices while keeping the generated evidence tied to its submitted inputs.
Home and All projects retain Activity when job history exists, so completed video
downloads and failed-job recovery stay reachable after dismissing a notice. Its
badge counts active jobs only and disappears when none remain.
Unreadable saved Activity is a retryable load error, never an empty history. Studio
preserves the file and refuses new job-file mutations until it can read it safely.
An explicit Retry can recover the existing history after storage is repaired.
New and resumed jobs are admitted only after their queued state is durably saved;
failed writes retain the previous state and permit a deliberate retry without a
phantom queued job. Restarted running jobs remain explicitly resumable unless an
export publication receipt first requires checking its existing result.
If saving the start of an admitted job fails, Activity explains that no processing
started and offers Resume for the same job. Another already queued project can
still proceed. Progress arriving after cancellation cannot replace its feedback,
and live Activity receives stop/terminal state even when its disk write fails.

Explicit caption text editing is ready immediately, including Khmer composition,
without a delayed selection that can replace newer typing or focus. A manual player
seek leaves a Fine Timing audition or loop at the user's new position and speed;
the retired audition cannot pause later playback. Native pause or seeking also
releases Review and regeneration-comparison loop ownership without changing the
saved loop preference or selected caption. Only a deliberate replay/Review action
arms a new pass. Internal loop seeks still work.
These connected workflow refinements describe development source, not a new release.


## Source-only playback recovery hardening

Compatible-copy lookup briefly precedes opening source video, so a cached copy
can open directly. If inspection takes longer than 1.5 seconds, original playback
becomes available while inspection continues within its 25-second request bound.
A failed lookup also releases original playback. Preparation requests and progress
checks are bounded and remain retryable.
For HEVC originals with negative browser capability hints, browsers with video
frame callbacks get five visible seconds to present an actual original frame.
A presented frame takes precedence over the hint and avoids automatic preparation;
otherwise preparation starts once. A slower inspection also respects a frame
already presented. Hidden-tab time does not consume this trial. Actual decoder
errors still request a compatible copy immediately, and browsers without frame
callbacks retain the immediate capability-hint fallback.
A separate 20-second missing-first-frame check offers Retry playback,
including when it is paused or only its audio clock advances. Once a frame has
appeared, a 20-second stalled-progress check excludes ordinary paused, ended and
background playback and allows sparse-frame video whose clock keeps advancing.
Browsers without video frame callbacks use loaded data to establish readiness.
Recovery preserves the editing session, position, speed, volume and mute state
and does not automatically resume. Retry restarts the decoder immediately;
an unavailable optional copy check does not block that restart. A confirmed
missing compatible copy is looked up or rebuilt. Each published copy keeps an
immutable URL; expiring leases and in-flight responses protect that exact copy
during rebuilds within the existing disk bound.
See [source evidence and platform limits](docs/PREVIEW-RELIABILITY-20261115.md).
