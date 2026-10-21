# Unfinished edit recovery

**Source-only changes:** `studio-unfinished-edit-recovery-20261019` and
`studio-reject-stale-saves-20261020`. This document
describes development source behavior. It does not establish availability in a
published download or update.

## Saving and recovering work

Studio keeps a bounded local browser copy of unfinished caption text, caption
edges and locks, and raw Accuracy description/vocabulary. Accepted text input is
captured while the field is focused, including composition input. Studio does not
force a save during active text composition.

**Save** handles both captions and Accuracy changes. Leaving for projects, a job
result, or correction audio saves unfinished changes before switching. If a save
fails or newer input arrives while it is saving, Studio keeps the editor open.
**Retry save** retries a non-conflicting failed save; a failed save is not displayed as saved. Browser
reload/close protection applies while changes or relevant saves remain pending.
Browsers can suppress an unload prompt or terminate without delivering it, so the
local copy is written during editing rather than relying on that prompt alone.

Requesting navigation cancels generation, regeneration, regrouping, or video
export actions still waiting on a save or confirmation. Regrouping that is queued
but has not been submitted is cancelled too. Retrying a failed save does not
restart those actions. Already submitted saves still finish before Studio leaves
the project. If regrouping has already been submitted, Studio waits for its result
before leaving; navigation cannot undo that server operation.

Reopen the project in the same browser profile and at the same Studio address to
look for a recovery offer:

- **Restore draft** checks the current saved project and media again, then places
  compatible recovered fields in the editor. Review changed captions and save;
  the normal caption autosave behavior may also run after restoring.
- **Download draft** saves inspectable JSON for comparison or manual recovery. It
  is not a complete project/media backup or a Studio caption-data import file.
- **Discard draft** requires confirmation and removes that recovery copy, without
  changing the saved project or current editor text.

If the saved captions, context, or media no longer match the recovery basis,
Studio offers download/comparison instead of applying the old draft. A revision
check also protects the initial recovered save against a project change after
the restore check. A conflict keeps the draft; retrying does not authorize an
overwrite. Download the active unfinished draft before reloading if a failed
save cannot be resolved, especially when browser storage is unavailable.

Ordinary caption and Accuracy saves also protect against stale editing. Before
saving, Studio checks whether the saved fields it is about to replace still
match the editor's acknowledged copy, then sends the current saved revision.
The server compares that revision again inside the project's write lock before
changing the project, History, correction memory, Contributor candidates, or
approval analytics. Missing revisions are refused, including from older clients.

If those fields changed, or the revision changes between checking and saving,
the editor keeps the local draft and shows **Saved project changed**. Further
queued saves and automatic retries stop; **Save** is disabled. Use **Download
edits**, then **Reload saved project** to compare with the saved work. Reload
captures the existing recovery copy but does not merge or overwrite changed
saved fields. If browser storage cannot keep the copy, reloading requires an
explicit warning and confirmation; cancel keeps the editor open. Download first
to retain the current draft. A conflicted comparison copy remains even if you
type back to the earlier saved text, because that text is no longer the current
saved project. Browser reload protection and storage limits still apply.

An unrelated saved field can advance without invalidating the draft: a caption
save preserves saved Accuracy and Appearance, and an Accuracy save preserves
saved captions and Appearance. The editor serializes its own Appearance writes
with each revision check/save. A successful save or an explicitly accepted
History, grouping, or regeneration change supplies the basis for subsequent
queued edits; unrelated responses cannot grant that authority to a retained
draft. Simultaneous edits to the same saved field require manual comparison,
even when the two editors changed different caption rows.
If a whole-caption regeneration is accepted while an already unfinished draft
would replace its newly saved captions, Studio instead keeps the draft and
requires Download edits / Reload saved project before another save. Typing
entered after a clean History action still follows that action in save order.

Restored changed rows need approval again. Recovery does not accept stored
approval, confidence, or manual word-timing tracks. Existing approval on unchanged
rows and timing used for reconciliation come from the freshly read saved
project. The initial recovered caption save does not create correction-memory
events, Contributor candidates, or approval analytics. It still keeps the normal
History checkpoint of the previous saved captions.

## Data, retention, and limits

Recovery records contain editable caption IDs, text, start/end edges and locks;
raw Accuracy text; project/media identity; timestamps; and equality evidence for
the saved baseline. That equality evidence can itself contain saved caption text
and word timings. It is comparison data, not authority to restore those timings.
Records contain no source audio/video or API keys and are not sent to a new
external service. Studio stores this JSON in the browser's local storage without
adding its own encryption.

| Limit | Bound |
| --- | --- |
| One record | 1 MiB |
| Aggregate admission budget | 3 MiB |
| Records admitted across projects | 10 |
| Records admitted for one project | 5 |
| Captions in one record | 10,000 |
| One text field | 131,072 UTF-16 code units |
| Recovery eligibility | Seven days from the record's capture time |

Storage size counts UTF-16 bytes for both keys and serialized values. Aggregate
limits are admission checks: concurrent tabs can race those checks, and replacing
an old record can temporarily keep both copies. Each individual record remains
bounded. Studio does not evict another tab's fresh draft to make room.

Expired valid records are removed when Studio discovers drafts or writes another
copy. There is no background deletion timer while Studio is closed. Successful
acknowledgement and explicit discard attempt to remove the corresponding copies;
storage failures can leave a record behind. Invalid records are not offered for
restoration.

Storage belongs to a browser **profile and origin**: scheme, host, and port all
matter. Another browser, private session, or Studio port may not see the copy.
Clearing site data, private-mode cleanup, browser eviction, storage restrictions,
or device failure can remove or prevent it. A failed or oversized optional write
keeps editing available and displays a warning; keep the tab open until the
changes save or download the draft. Deleting installation/project folders is not
a purge of browser site data. An unavailable or replaced project cannot be
silently recreated from this record.

Only fields accepted into the caption/Accuracy drafts are covered. Uncommitted
timestamp input, draft-only per-word timing, approval-only changes, appearance,
generation proposals, and source media are outside the editable recovery payload.
Ordinary caption and Accuracy writes have revision protection. Other operations
retain their existing guards; this is not a general collaboration or automatic
merge system.

## Implementation and verification

| Source | Responsibility |
| --- | --- |
| `apps/web/src/unfinished-edit-recovery.ts` | Validated records, bounds, ownership, expiry, compatibility, and safe restoration |
| `apps/web/src/accuracy-context-draft.ts` | Raw Accuracy fields and their independent saved acknowledgement |
| `apps/web/src/App.tsx` | Input capture, owned save basis, conflict state, pending-save/navigation handling, and recovery actions |
| `apps/web/src/save-revision.ts`; `apps/web/src/caption-appearance-save.ts` | Field comparison and serialization with Appearance writes |
| `apps/web/src/api.ts`; `apps/server/src/routes/projects.ts` | Required ordinary revision guards and recovery-save side-effect exclusions |

`npm run test:edit-recovery` exercises Accuracy ownership, recovery utilities,
save-revision comparison, and the synthetic HTTP boundary.
`tests/browser/unfinished-edit-recovery.spec.mts` and
`tests/browser/stale-save-conflicts.spec.mts` cover the editor workflow.
Relevant verification includes focused/IME input,
delayed acknowledgements, save failure/retry, mixed caption and Accuracy saves,
navigation, storage failure, conflicts, and fresh timing provenance. The task's
verification receipt owns the actual results; these pointers do not assert a
passing test run or a released build.

Browser qualification also checks the native caption image during continuous
playback. Once an external media/frame callback recognizes a different interval,
the preview commits that interval before the callback returns. Initial effect
setup keeps ordinary React scheduling. This avoids an additional paint
opportunity with the previously selected image; it does not guarantee when a
delayed browser callback will run. Native request deadlines, cancellation,
project ownership, and rejection of cancelled decoded output remain in force.

The native browser fixture measures its synthetic response delay from request
admission, including lifecycle overrides, and drains its page routes before
teardown while retaining the context's ownership guard. Those harness checks do
not replace actual component, native-image, disk-save, or recovery coverage.
