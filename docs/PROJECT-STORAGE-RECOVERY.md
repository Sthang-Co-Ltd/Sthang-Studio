# Saved project readability and recovery

Change proposal: `studio-project-storage-recovery-20261021` (tracker #9).
This documents development source, not a published release or verified backup.

Studio checks per-project JSON files during the existing startup load. Files with
an unusable load shape are skipped with a notice; readable projects stay usable.
Repairable caption timing remains editable. Diagnostics report counts, never
project names, caption text, file paths, or raw filesystem errors.

**Settings → System check → Saved projects** shows projects loaded in this session,
readable/unreadable files at the last check, duplicates, files missing after load,
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
- Readability is a load-shape check, not a complete semantic audit, proof of
  backup integrity, free-space measurement, or verification of media/history.
- Rechecks are snapshots. Concurrent writes and later external changes can change
  disk state afterward. Newly restored files are not hot-reloaded. Files already
  loaded can still be explicitly saved through the normal editor workflow.
- Existing project/history/media storage and privacy rules remain in force. This
  adds count-only diagnostics in memory and no new persistent category or cloud
  transfer; `PRIVACY.md` requires no data-flow change.

## Verification

36 deterministic library/store/storage/API cases passed, including real isolated
filesystem fixtures for malformed/partial legacy data, corrupt indexes, unreadable
files, duplicate identities, failed backup destinations, preserved index
references, and read-only recovery checks. The endpoint returns no-store metadata
or a generic failure. 71 edit-recovery cases passed. 33 isolated browser cases
cover the storage notices, healthy-project access, retry, empty-library recovery,
mobile layout, project discovery, startup, and unfinished edits; all 38 isolation
guards passed. Desktop and mobile captures were inspected. These fixtures do not
prove recovery of an actual damaged user installation. No independent review was
performed.

## Public impact: required

Compared with `.sthang/product-manifest.json` and its README/privacy/installation
evidence: the recovery workflow and limitations change. The governed v0.86.0
release/download/version claims and identity remain unchanged. Product-owned
README, PRODUCT and DESIGN documentation are updated with source-only scope.

Proposed maintainer follow-up after source acceptance: HQ's Studio workflow and
limitations evidence should describe read warnings, explicit recheck, backup/stop/
restore/restart guidance, and the lack of automatic repair. Distribution's
`/studio/` website/docs should receive the corresponding troubleshooting guidance
when availability is established. No new hosted service or disclosure is proposed.
Use HQ README Phase 3 intake, then Distribution README Phase 2 synchronization;
each needs its own fresh exact plan digest and approval classes. Surface edits,
release claims and publication require their separate approvals. No HQ or
Distribution writes, release, merge, or deployment are part of this change.
