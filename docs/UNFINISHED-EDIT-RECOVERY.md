# Unfinished edit recovery

**Source-only change:** `studio-unfinished-edit-recovery-20261019`. This document
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
**Retry save** retries the save; a failed save is not displayed as saved. Browser
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
General conflict enforcement and merging for ordinary simultaneous editing in
multiple tabs remain separate work.

## Implementation and verification

| Source | Responsibility |
| --- | --- |
| `apps/web/src/unfinished-edit-recovery.ts` | Validated records, bounds, ownership, expiry, compatibility, and safe restoration |
| `apps/web/src/accuracy-context-draft.ts` | Raw Accuracy fields and their independent saved acknowledgement |
| `apps/web/src/App.tsx` | Input capture, saved caption basis, pending-save/navigation handling, and recovery actions |
| `apps/web/src/api.ts`; `apps/server/src/routes/projects.ts` | Recovery revision guard and recovery-save side-effect exclusions |

`npm run test:edit-recovery` exercises Accuracy ownership, recovery utilities, and
the synthetic HTTP boundary. `tests/browser/unfinished-edit-recovery.spec.mts`
covers the editor workflow. Relevant verification includes focused/IME input,
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
