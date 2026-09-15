# Playback ownership and explicit caption grouping

Development change; not public-release or installed-app evidence.

## Intended behavior

The Caption grouping mode buttons and character slider stage the next operation.
**Apply grouping** applies the currently selected mode and character limit once.
**Save grouping preset** only saves a reusable preset; **Apply saved grouping** uses
the same safe apply path. Word mode disables the character slider because it emits
one timed token. The limit is characters, not an exact number of words. Dynamic
rhythm, punctuation, pauses, duration limits and protected phrases still take
priority where the existing segmentation contract requires it.

Applying first saves current edits. A failed save prevents regrouping. When the
current wording differs from the timed transcript, explicit confirmation explains
that unlocked wording can be rebuilt; text/timing locks and the existing History
checkpoint remain the recovery/protection mechanism. Regrouping joins the editor's
save queue. A late response must not replace a newer draft or another project.
No segmentation, timing, lock-preservation, History or SRT algorithm is replaced.

Regrouping also carries the initiating media filename and size. The server checks
that identity inside the per-project persistence queue before it writes History,
segments captions or persists the result. A request without that precondition is
rejected with HTTP 428; a request for an older media generation is rejected with
HTTP 409. Clients from before this contract must refresh/update before regrouping;
silently accepting an identity-free regroup could restore captions and metadata
from media that has already been replaced.

Playback/proposal state belongs to a project **and its media identity**. Navigating
Home, choosing another project, uploading or replacing media invalidates older
pending reads and scheduled playback tasks. Returning to the same project creates
a new epoch, so comparing only project IDs is not sufficient. Ordinary caption or
appearance saves do not change the media key or reload the source video.

Media replacement has one durable commit boundary. Before the replacement project
is persisted, a failure leaves the previous project, source and recoverable History
active. After persistence succeeds, the replacement is the current project even if
retiring old History/proposals or removing the previous source file encounters a
cleanup fault. The server returns the committed project with the additive
`replacementCleanupWarnings` field in that case instead of reporting the whole
replacement as failed. Old-generation History and proposals are filtered against
the current generation so a cleanup fault cannot make them restorable/applicable.
Proposal application also resolves the current project inside that same per-project
write queue and checks the proposal's source generation before creating History or
persisting changes, so a same-ID replacement that wins the queue makes the older
proposal fail instead of republishing its media or captions.
Khmer spacing cleanup and safe timing cleanup use the same rule: the browser sends
the media filename/size the operation was prepared against, and the server resolves
that identity inside the serialized project write before it checkpoints or mutates.
Compatibility full-caption generation also rechecks its captured media identity at
the final publish boundary, so a long-running result cannot resurrect replaced media.
Older clients may ignore the additive warning field, but they should refresh the
project after any ambiguous replacement failure before submitting more edits.

History summaries record their media generation in the compact project History
index. Dedupe and autosave coalescing compare only entries from the same generation,
so an identical old-media snapshot cannot suppress the first checkpoint for a
replacement. Current-generation History listing uses project media metadata plus
the compact index and does not clone the full project or read every snapshot. An
older index without media ownership is enriched once from its entry snapshots and
then follows the same index-only path. Legacy migration/enrichment, listing, single-
entry reads, checkpoints and cleanup share one per-project History queue, so a
read-triggered index upgrade cannot overwrite a checkpoint created concurrently.
Restoring an entry still loads and validates that exact snapshot. History cleanup
waits for every sibling removal to settle before releasing replacement cleanup; one
failed removal can therefore produce a warning without allowing another still-running
removal to erase a later checkpoint.

Correction-Inbox **Add to project** actions also resolve the target project inside
the existing per-project write queue. They update only the current transcription
context vocabulary and timestamp. If same-ID media replacement commits first, the
vocabulary line is added to that current project; the action never republishes the
detached old media, captions, transcript, appearance or other unrelated project state.

The browser also treats a server mutation response as belonging to the editor state
that launched it. If a same-media spacing, timing, proposal or History request
finishes after newer caption edits, the committed server metadata is retained while
the newer local caption draft remains visible. If the server response does not contain
that visible draft, Studio explicitly returns the editor to dirty/autosave-pending;
only a save that acknowledges the visible caption state may make it saved again. These
four full-project same-media mutations also share the caption persistence queue used by
grouping: they wait for earlier caption-save acknowledgements, while a save requested
during a mutation waits for that mutation response and then commits against the resulting
server state. An older save acknowledgement therefore cannot arrive after a later
destructive mutation response and falsely clear pending state or republish obsolete
project metadata. A save request made while captions are already clean is redundant and
does not enter the persistence queue at all, so clean Ctrl+S cannot later reverse an
acknowledged mutation or an old project's committed restore after navigation. Genuine
dirty saves retain the exact draft/version, project/media identity and editor-session
ownership captured when that save was requested. If newer edits arrive after such a save
starts, its acknowledgement may update committed metadata but cannot make those later
visible edits clean; a subsequent save must persist them before Studio reports Saved.
With no intervening edit, the server result is applied exactly once.
Media replacement is
stricter: existing dirty captions are saved first, the committed replacement is
authoritative, and its caption list starts from the new-media response. Edits made
while replacement is in flight are never transplanted onto the replacement. Studio
keeps a bounded in-memory recovery snapshot containing the previous project/media
identity and the ordered caption structures (text, timing, locks and approval state),
and exposes each unacknowledged snapshot through a persistent **Copy recovery** notice.
Separate replacements append separate recoveries; once the bounded recovery slots are
full, another replacement is blocked until an earlier recovery is copied/dismissed.
A failed replacement leaves the old media and the pending draft intact.

A completed background proposal does not interrupt active playback or newer edits.
It remains available through Activity. Deliberately opening a proposal retains its
normal preview/loop behavior in its owning project. Review context-versus-focus
playback, native preview shaping and export output remain unchanged.

A failed media element offers **Retry playback**. This reloads the existing source,
attempts to restore the last good position, and stays paused. It never auto-retries
on a timer, replaces/transcodes source media, discards captions or automatically
starts playback. A persistent codec/file/transport failure remains a failure;
this recovery action is not proof that every visual corruption has been fixed.

## Verification

Use the repository's locked development dependencies and an isolated test state,
LOCALAPPDATA, provider-free environment and loopback-only test harness. Do not
trigger hosted CI or open a PR for validation when the owner prohibits runners.

- `npm run test:playback-grouping`: pure identity/epoch/proposal/wording contracts
  plus disk-backed Express/store races for replacement, project-glossary correction,
  generation-scoped History/index enrichment, list-I/O and replacement boundaries.
- `npm run typecheck` and `npm run build`: full application validation.
- `npm run test:browser -- tests/browser/playback-grouping.spec.mts tests/browser/playback-grouping-disk.spec.mts`:
  maintained browser cases
  for explicit grouping, failed saves, stale proposals, late Activity reads,
  stable media elements across caption saves, structured/multiple replacement edit
  recovery, same-media response races for proposal apply/spacing/timing/History, and
  real disk-backed History-restore overlaps in both acknowledgement orders. The
  serialized case proves a save requested during restore does not dispatch early,
  remains pending through the restore response, then persists the visible draft and
  becomes saved only after that later save acknowledgement. Separate clean-save cases
  prove redundant Ctrl+S does not create persistence work, cannot reverse a restored
  snapshot after leaving the old editor session, and cannot compose with later dirty
  saves to hide a newer unsaved edit. Later genuine edits still persist normally.
- Run the other maintained browser cases as regression coverage for Review focus,
  contextual first replay, tight repeat replay, navigation and exports.

Most browser fixtures use synthetic media and mocked API responses. The dedicated
History-overlap browser case starts the real local Express server against a test-owned
disk project/History state; focused server cases also exercise real Express routes and
the disk-backed project store. None of these layers proves correct decoding of the
creator's affected footage. Keep native/font prerequisites and any unavailable checks
explicitly recorded.
Portable component-logic probes using a substitute hook scheduler are not mounted
React tests or Windows/browser decoder evidence. Never label them as such.

For remaining original-picture corruption, observe the affected file locally at
its failure point: currentTime/duration, seeking/ended/error events, readyState,
networkState, buffered/seekable ranges, and media HTTP status/Content-Range. Do not
export the private file, caption content, credentials or local paths as evidence.
A wait followed by a reload is not sufficient to isolate its cause.

## Public impact and release boundary

The explicit Apply grouping/preset distinction, Retry playback action, replacement
edit-recovery notices and delayed-mutation edit-preservation behavior need user-guide/
release guidance when this change is released. This file is the
product-owned development evidence. A pending manifest proposal for unrelated
platform/runtime work must not be overwritten with an invented approval. Before
public publication, review the approved Studio record and `/studio/` guides for
any step-by-step instructions that need updating, using current release evidence
and the separately governed synchronization process.

No provider, data-transfer category, consent rule, supported platform, dependency,
model, artwork, source-media format, export representation or release version is
changed by this patch. No public claim of universal playback repair is warranted.
