# Replacing media while keeping reviewed captions

Status: source-only. This does not establish availability in a published package.

## Creator workflow

1. Keep the overall timeline duration and ensure every existing caption remains
   inside the replacement's duration. Volume edits, added music and sound effects
   can be accepted without changing the reviewed caption and word times.
2. Open the reviewed Studio project, then **Tools → Replace media** and select the
   revised export.
3. Choose **Keep reviewed captions** and let Studio check the two files locally.
   Saving pending caption and appearance edits
   is a prerequisite; a failed save stops replacement.
4. If otherwise valid audio differs, Studio offers a warning. Accept only if you
   want the existing caption and word times kept and take responsibility for
   their alignment against the edited audio. Leaving it unchecked or canceling
   keeps the old source and project. Changed files or project revisions require
   a fresh check and acceptance.
5. After successful replacement, review alignment and caption placement,
   particularly when crop, rotation, dimensions, or aspect ratio changed.

**Start over** is a separate confirmed choice. It clears the active transcript and
captions, without automatically requesting generation. An incompatible preserving
request never falls through to start-over.

## What preservation means

Caption objects are retained, including wording, segment timing, exact-text word
timing, approvals and locks. Canonical transcript/tokens, transcript-sync status,
mode, and saved appearance are retained. Source-derived caches and native preview
sessions are retired; new preview/export work uses the new source identity.

The unchanged-audio comparison is conservative signal evidence, not a semantic
speech-recognition proof. No cloud request or model listen is used. Different
audio can be explicitly accepted only after complete file/decoder/timeline safety
validation. This records **unverified alignment**, not a compatibility certificate:
old captions and word times are retained unchanged, and an alignment reminder
stays visible after reopening and during export. Overall duration changes, unsafe
timestamps, undecodable/corrupt inputs and caption bounds beyond EOF cannot be
overridden. Do not choose Start over unless losing the active caption set is intended.

For accepted audio changes, automatic timing cleanup and regrouping from the old
transcript are blocked before changing captions. Existing ready word timing stays
exportable. Manual timing edits and explicit word-sync or regeneration previews
remain available; they do not silently clear the alignment reminder.

## Local recovery

Successful replacement stores the prior source, full project snapshot, and its
media-scoped history in a local recovery. **Undo media replacement** in Tools
remains available after reopening Studio. Restoring a selected backup replaces
current editing state after confirmation and saves the current version as another
backup. Restored media receives a fresh identity so delayed requests from an older
tab cannot become valid again.

Up to five recovery snapshots are retained per project. At capacity, another
replacement or restore stops; explicitly delete an unneeded backup to make room.
Deleting a backup does not delete the active project. Backups contain private media
and captions, consume local disk space, and are removed with their project. They
are not remote backups. No recovery is silently evicted to make a swap succeed.
Restore also backs up the active source before switching. Missing, unreadable,
non-regular or size-inconsistent active media stops restore rather than silently
losing the redo version. Copy/hash consistency is checked, but the active source
is not decoded or compared with an earlier known hash; same-size corruption can
therefore be copied into redo. Recovery from a source that cannot be backed up
needs a separately reviewed manual recovery flow.

When directory durability cannot be confirmed (including Windows), the previous
source and its History namespace are retained as an extra safeguard. Deleting a
recovery removes its snapshot and retained source, but retired History entries
may remain until project deletion; deleting one backup
is not a purge of all prior caption/History data. The five-recovery limit does
not bound all retained History storage.

## Engineering and verification boundary

- Multipart replacement requires explicit `preserve` or `reset`, the expected
  media identity, and saved project revision. Missing/stale preconditions fail.
- A complete safe audio mismatch offers a ten-minute confirmation tied to the
  exact old/new source hashes, replacement size, project and saved revision.
  Acceptance retries the exact selected file. Changed file bytes, stale revisions,
  replay after replacement, expiry or server restart invalidate the confirmation.
  No source swap or recovery-slot consumption happens while asking for acceptance.
- Both complete decodes and frame clocks remain required before a warning can be
  offered or accepted. Audio differences never hide a later decode/timestamp error.
  Staged replacement bytes and the old-source backup are rechecked before publication.
- Verification and staging occur before atomic project publication; active jobs,
  concurrent media transactions and updater activation are excluded.
- New processing requests carry the source identity from the open project. Saved
  jobs are bound to that source and cannot resume after replacement. Older jobs
  without a recorded source identity are safely rejected; start a new operation
  from the current project if it is still wanted.
- The source and recovery copy are checked before activation. Persistence or
  verification failure leaves the previous saved project and source in place; it
  does not repair pre-existing damage.
- Recovery history is rebased to fresh media identities, preserving older review
  decisions without making delayed old requests valid.
- Comparison uses complete aligned mono/stereo PCM with compatible channel
  layouts, independently per channel,
  rather than a duration check or a few sampled excerpts. Resource limits and
  cancellation terminate local subprocesses; no comparison audio is retained.

Current checks allow at most 40 ms of container-duration rounding, 2 ms of
origin/frame-clock discrepancy, and 32 ms of quiet codec padding. Aligned 20 ms
windows at 48 kHz must meet a 6% residual ceiling and correlation of at least
0.995, with a −60 dBFS quiet floor. These tolerances admit codec noise; they do
not prove that every audio sample is identical. Tiny sub-threshold edits can be
indistinguishable from that noise.

Detailed thresholds are defined alongside `full-timeline-pcm-v1` in
`apps/server/src/services/media-compatibility.ts` and exercised with generated
media in `tests/media-compatibility.test.mts`. Keep acceptance claims tied to those
checks. Synthetic Linux tests do not establish native Windows/macOS acceptance.

## Browser qualification before merge

Run on an authorized development machine with supported Chromium process/socket
access, using only the synthetic fixtures in the repository:

```text
npm run typecheck
npm run test:media-replacement
npm run test:browser -- tests/browser/preserve-media.spec.mts tests/browser/playback-grouping.spec.mts tests/browser/playback-grouping-disk.spec.mts
```

Check that canceling file selection/confirmation does nothing; preserving keeps
review approvals, word timing, style, playhead and selection; unaccepted changed audio
leaves the original active; start-over requires explicit confirmation; double
clicks submit once; dirty caption, appearance and Accuracy edits are saved before
backup; reopening still exposes recovery; restore warns about replacing newer
work; capacity can be resolved through confirmed backup deletion; and errors or
navigation never apply an older result to a different project. Inspect desktop
and narrow/mobile layouts, focus handling, and readable status/error copy. Run a
native Windows/macOS re-encoded clip smoke test before publishing that platform.

An earlier Linux sandbox qualification could not launch the browser. Later results
must identify the executed platform, runtime and suites; source-only browser tests
or type-checking alone do not establish runtime acceptance. Route-mocked UI checks
also do not establish durable filesystem recovery or native media export.

## Pending Accuracy edits and copied recovery (source-only correction)

Accuracy text drafts are separate from acknowledged project context. Caption-only
responses cannot reset them. Context saves are ordered with other same-media
mutations, and late responses are scoped to their original editor session/source.
Media preparation checks that accepted raw fields remain stable while saves drain;
its context PUT compares the saved project revision atomically before writing.
A conflict stops replacement and keeps local drafts for review. Ordinary explicit
context saves keep their existing last-writer behavior; this is not a claim of
general collaborative editing or cross-tab conflict resolution.

If accepted caption or Accuracy edits arrive after a media request is submitted,
they belong to the previous source. The existing Copy recovery notice retains
those captions and, when changed, exact raw Accuracy description/vocabulary. They
are not silently applied to the replacement or its already-captured backup. This
copied recovery is an editor-session aid, not a persisted disk backup: copy it
before dismissing it or closing/reloading the editor.
