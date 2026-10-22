# Saved project readability and recovery

Change proposal: `studio-project-storage-recovery-20261021` (tracker #9).
This documents development source, not a published release or verified backup.

Studio checks per-project JSON files during the existing startup load. Files with
an unusable load shape are skipped with a notice; readable projects stay usable.
Repairable caption timing remains editable. Diagnostics report counts, never
project names, caption text, file paths, or raw filesystem errors.

**Settings → System check → Saved projects** shows projects loaded in this session,
readable/unreadable files at the last check, duplicates, indexed or previously
loaded project files that are missing,
and project-order or older-data problems. The shared toast offers **Review
storage**. An unresolved empty collection offers storage review rather than
claiming no projects exist. **Recheck saved projects** performs a local read and
updates the report. It does not run the full system check, start processing, repair
files, or replace the running session's project objects. There is no polling.

Back up the Studio state folder and download available unfinished edits before
recovery. Keep Studio open long enough to capture available work if loaded files
have disappeared. Stop Studio before restoring known-good copies, preserve the
originals for comparison, and restart afterward. Do not delete/reset storage to
clear a warning. Rechecking restored files can show that they are readable, but a
restart is required to load them safely.

## Preservation and limits

- An unreadable project order is retained byte-for-byte. Explicit project saves
  can still persist project files, but do not overwrite the unreadable index.
  References to missing/unreadable files remain in a readable index for recovery.
- Incomplete or unreadable legacy data, an unusable backup destination/marker, or
  unreadable per-project data prevents finalizing legacy migration. Valid records
  can remain usable in memory. An old legacy record cannot overwrite or stand in
  for a newer unreadable per-project file. Legacy sources/backups are retained.
  Saving a new project during partial migration keeps usable legacy-only records
  in the session list without adding them to the saved index. Genuine existing
  index references remain preserved, including references to missing files.
- Project deletion is refused with an actionable, count/content-free recovery
  response while legacy migration is unresolved. This protects every project in
  the affected session, including records already on disk: otherwise the retained
  legacy source could restore a deleted record after its media/history were
  removed. Refusal leaves project files, source media, caches, and history intact.
  A recheck that discovers a missing/unusable migration marker also activates this
  protection. Rechecking repaired files or metadata does not unlock deletion;
  recover with Studio stopped and restart with a completed migration first.
- Missing-file counts include valid saved order references even if none of those
  projects loaded in this session, plus previously published project files that
  disappear. Duplicate references count once; an existing unreadable file counts
  as unreadable, not missing. Memory-only legacy records are not missing files.
  Explicit deletion removes its saved reference and does not create a warning.
- Readability is a load-shape check, not a complete semantic audit, proof of
  backup integrity, free-space measurement, or verification of media/history.
- Rechecks are snapshots coordinated with Studio's project saves and deletions.
  A scan overlapping a mutation is discarded before any warning or restart state
  is published. Verification makes at most three attempts; ongoing changes can
  leave the check unavailable, with retry still available, rather than reporting
  a file as missing from an inconsistent snapshot. A later successful check can
  resolve that unavailable state. Genuine storage faults retain their restart
  and migration protections. Later external changes can still change disk state
  after verification. Newly restored files are not hot-reloaded. Files already
  loaded can still be explicitly saved through the normal editor workflow.
- Existing project/history/media storage and privacy rules remain in force. This
  adds count-only diagnostics in memory and no new persistent category or cloud
  transfer; `PRIVACY.md` requires no data-flow change.

## Verification

The initial proposal recorded 36 deterministic library/store/storage/API cases,
including real isolated
filesystem fixtures for malformed/partial legacy data, corrupt indexes, unreadable
files, duplicate identities, failed backup destinations, preserved index
references, and read-only recovery checks. The endpoint returns no-store metadata
or a generic failure. 71 edit-recovery cases passed. 33 isolated browser cases
cover the storage notices, healthy-project access, retry, empty-library recovery,
mobile layout, project discovery, startup, and unfinished edits; all 38 isolation
guards passed. Desktop and mobile captures were inspected. These fixtures do not
prove recovery of an actual damaged user installation. That initial proposal had
no independent review.

The server revision reproduced seven failures against unchanged PR #94 head
`c3a57d532d1995c43df9a298285df531b631361c` (17 passed, 7 failed), then passed all 43
targeted store/storage/API cases. Synthetic filesystem and loopback API fixtures
cover partial legacy deletion/refusal/restart, retained media/history/cache and
original legacy bytes, sticky recheck protection, healthy deletion, cleanup
ordering after file-removal/index-publication failure, all-indexed-files-missing
startup, mixed unreadable/missing files, after-load removal, deduplication,
retained index references through saves/restart, and completed legacy migration.
Independent review then identified that a new save during partial migration
could publish a memory-only legacy record into the index and create a false
missing-file warning. A new fixture reproduced that failure before correction;
it now verifies the session list, exact persisted index, retained legacy bytes,
and missing-file count through recheck/restart. The full library/store/storage/
API group passes 52 cases after the correction. Independent re-review accepted
the server preservation and frontend request/error ownership corrections.
The explicit shared compiler build and server typecheck passed. These checks use
disposable synthetic state and do not establish damaged-user-install recovery,
crash/power-loss deletion durability, or public-release availability.

The frontend revision retains failed/unknown verification after a dismissible
toast is closed; only a successful check resolves it. A failed recheck after a
previous success is also unresolved. Browser regressions cover initial 503,
dismissal, pending/retried checks, later failures and superseded responses. The
unchanged baseline reproduced the dismissal defect; a modal-navigation fixture
mistake was retained and corrected separately. Independent review additionally
found misleading missing-file copy when no projects had loaded. A frozen
zero-loaded/two-indexed-missing case reproduced that contradiction before the
panel was corrected to cover indexed or previously loaded files and any available
session work. The final isolated browser spec passes 9/9 cases plus 38/38
isolation/lifecycle guards, one worker and zero retries, on Windows/Node 24.21.0.
These browser fixtures model server responses; the filesystem/API tests above
provide separate persistence evidence.

The subsequent recheck-concurrency correction uses filesystem barriers, not
timing delays, to hold a real directory snapshot while store saves or deletions
publish their files and index. The unchanged `8020f9a` store failed all 13
initial focused cases; the expanded corrected matrix passes 18 cases. It covers
completed and still-active mutations, overlapping index publication, failed
save/delete operations, bounded three-scan exhaustion followed by a healthy
retry, a real sanitized endpoint 503, genuine missing indexed files, and a
discarded migration observation that must not latch deletion or restart state.
Independent project writes remain concurrent; work inside a project-write
callback does not block verification before actual persistence starts. A stable
recheck still leaves in-memory project contents unchanged. These deterministic
fixtures do not establish crash/power-loss durability or prevent external edits
after the snapshot.

## Public impact: required

Compared with `.sthang/product-manifest.json` and its README/privacy/installation
evidence: the recovery workflow and limitations change. The governed v0.86.0
release/download/version claims and identity remain unchanged. Product-owned
README, PRODUCT and DESIGN documentation are updated with source-only scope.

Proposed maintainer follow-up after source acceptance: HQ's Studio workflow and
limitations evidence should describe read warnings, explicit recheck, backup/stop/
restore/restart guidance, missing indexed files even when no projects loaded,
the deletion restriction during unresolved migration, and the lack of automatic
repair. Distribution's
`/studio/` website/docs should receive the corresponding troubleshooting guidance
when availability is established. No new hosted service or disclosure is proposed.
Use HQ README Phase 3 intake, then Distribution README Phase 2 synchronization;
each needs its own fresh exact plan digest and approval classes. Surface edits,
release claims and publication require their separate approvals. No HQ or
Distribution writes, release, merge, or deployment are part of this change.

The recheck correction adds a bounded unavailable/retry outcome during concurrent
project changes to that proposed troubleshooting scope. The new proposed intake
identifier is `studio-storage-recheck-20261022`; this document is source evidence,
not an applied HQ intake, approved public availability or website synchronization.
