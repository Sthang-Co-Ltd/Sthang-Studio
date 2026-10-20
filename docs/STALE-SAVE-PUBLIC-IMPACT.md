# Stale save protection: public-impact intake

- **Change ID:** `studio-reject-stale-saves-20261020`
- **State:** source-only implementation and intake proposal
- **Public impact:** required for save/conflict workflow documentation
- **Downstream assessment:** uncertain until an authorized HQ checkout, its
  Phase 3 intake evidence, and the exact approval plan are available

## Product change

Ordinary caption and Accuracy saves now require a saved revision. The server
compares it inside the project write lock before persistence or caption History,
correction memory, Contributor candidates, and approval analytics. A stale
request is rejected even when its payload is a no-op; an older client omitting
the revision is refused.

The editor compares the fields it will replace against its acknowledged copy.
Unrelated saved fields can advance safely. Its own Appearance writes share the
revision-check/save boundary, and accepted queued saves and explicit History,
grouping, and regeneration operations retain their ordering.
An accepted whole-caption mutation cannot silently authorize an already dirty
draft to overwrite the newly saved captions; conflicting drafts require manual
comparison while edits made after a clean History action retain their ordering.

A conflict keeps the local draft, stops queued saves and automatic retries, and
offers Download edits and Reload saved project. Reload captures the bounded
recovery copy; if browser storage cannot retain it, an explicit warning and
confirmation are required before leaving. Conflicting recovery is available for
download and comparison, not automatic restoration over changed saved evidence.
Studio does not automatically merge simultaneous edits to the same caption list
or Accuracy context, including edits to different caption rows.

## Product-owned evidence

| Evidence | Assessment |
| --- | --- |
| `README.md`; `PRODUCT.md`; `DESIGN.md`; `CHANGELOG.md`; `docs/UNFINISHED-EDIT-RECOVERY.md` | Updated source-only save/conflict instructions and limitations |
| `apps/web/src/App.tsx`; `apps/web/src/save-revision.ts`; `apps/web/src/caption-appearance-save.ts`; `apps/web/src/api.ts`; `apps/web/src/unfinished-edit-recovery.ts` | Field ownership, revision checks, local queue behavior, conflict/reload actions, and retained comparison copies |
| `apps/server/src/routes/projects.ts` | Required guarded caption/context writes before side effects |
| `tests/stale-save-api.test.mts`; `tests/save-revision.test.ts`; `tests/browser/stale-save-conflicts.spec.mts` | Rejection, valid saves, two-client conflicts, local draft preservation, and side-effect boundaries |
| Existing recovery, grouping, media-replacement, and Appearance tests | Compatibility with accepted saves, newer typing, History ordering, and recovery exclusions |
| `PRIVACY.md` | Existing browser-copy contents, bounds, origin/profile scope, and retention still apply; no new storage category, provider, external transfer, telemetry, or dependency |

Actual validation outcomes belong to the task receipt. Test pointers and source
implementation do not establish released availability.

The reviewed `.sthang/product-manifest.json` represents the separately governed
`studio-v0-86-0-release-20261013` change. Its `proposal.release`,
`proposal.distribution`, and signed update evidence remain tied to that release.
This proposal does not rewrite those accepted claims or imply that published
v0.86.0 downloads contain stale-save protection. Branding, installation,
compatibility, and download/update authorities are unaffected by this change.

## Proposed HQ and Distribution follow-up

| Authority or surface | Proposed follow-up |
| --- | --- |
| HQ Studio workflow/features | Describe guarded caption/Accuracy Save and the Download edits / Reload saved project path, with source-only availability until release evidence changes |
| HQ Studio limitations | State that conflicts stop stale retries and require manual comparison; avoid universal multi-tab protection or automatic merge claims |
| HQ Studio data-processing evidence | Confirm the existing local recovery disclosure; this follow-up adds no new transfer or retention category |
| `landing/studio/index.html` and `docs/studio/index.md` | Review the `/studio/` save/recovery workflow after HQ acceptance and carry the approved conflict limitations |
| `governance/hq/portfolio.json` and `governance/hq/sync-lock.json` | Transport the exact accepted HQ input through Distribution's Phase 2 plan/apply workflow |

Distribution's README was read for this assessment. It requires clean HQ and
Distribution worktrees, an immutable plan, and explicit approval of the exact
plan digest and listed classes. The existing v0.86.0 exception grants no authority
for this new change. Data-processing changes, if the HQ assessment requires any,
remain subject to the blocked public-visibility approval class.

The authorized HQ checkout and Phase 3 intake input are unavailable in the
connected roots, so this proposal does not invent schema fields, plan digests,
approval classes, or an accepted downstream diff. Next: prepare the new HQ
Phase 3 intake, obtain its exact approval, then prepare and approve the matching
Distribution Phase 2 plan. Website/docs writes, builds, publication, release
promotion, and deployment retain their separate approval requirements.
