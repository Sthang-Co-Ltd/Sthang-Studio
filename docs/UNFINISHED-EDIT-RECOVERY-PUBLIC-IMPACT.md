# Unfinished edit recovery: public-impact intake

- **Change ID:** `studio-unfinished-edit-qualification-20261020`
- **Related local proposal:** `studio-unfinished-edit-recovery-20261019`
- **State:** source-only implementation and intake proposal
- **Public impact:** required for the editing workflow and local retention disclosure
- **Downstream assessment:** uncertain until the missing HQ intake evidence and
  exact approval plan are available

## Product change and local evidence

Studio adds a persistent browser recovery copy of unfinished caption and Accuracy
fields, combined Save/navigation protection, visible save failures with retry,
and explicit recovery/download/discard actions. Restoration checks saved project
and media compatibility. Changed rows need approval again, and the guarded
recovery save does not create learning, Contributor, or approval-analytics events.

The qualification continuation also commits a recognized native caption interval
within its media/frame callback, avoiding a further paint opportunity before the
selected cached image is committed. This is a source-level preview correction,
not a measured user-PC speedup or a promise of a fixed presentation deadline.
It adds no provider, external transfer, stored data, or installation dependency.

The new storage is local to the browser profile and origin. It includes editable
caption text/edges/locks, raw Accuracy text, media identity, and canonical equality
evidence that can contain saved wording and word timings. It includes no source
media or keys and creates no additional external transfer. Retention and admission
limits are documented in [Unfinished edit recovery](UNFINISHED-EDIT-RECOVERY.md),
including expiry, concurrent-tab admission races, storage failure, browser-data
clearing, and fields that are not recoverable.

Product-owned evidence to reconcile is `README.md`, `PRIVACY.md`, `PRODUCT.md`,
`DESIGN.md`, `CHANGELOG.md`, and `docs/UNFINISHED-EDIT-RECOVERY.md`. Implementation
evidence is `apps/web/src/unfinished-edit-recovery.ts`,
`apps/web/src/accuracy-context-draft.ts`, `apps/web/src/App.tsx`,
`apps/web/src/api.ts`, and `apps/server/src/routes/projects.ts`. Focused tests are
the recovery/Accuracy unit suites, `tests/unfinished-edit-recovery-api.test.mts`,
and `tests/browser/unfinished-edit-recovery.spec.mts`. Actual validation outcomes
belong to the task's final receipt.

Additional preview evidence is `apps/web/src/components/NativeCaptionPreview.tsx`
and `tests/browser/native-preview-continuous.spec.mts`. The final receipt must
separate ordinary browser qualification from instrumented timing experiments,
retain unsuccessful attempts, and identify any unresolved historical timing or
opening failures. Passing a local check does not establish published availability.

The existing `.sthang/product-manifest.json` binds a separately governed
`v0.86.0` release and its download/update evidence. This new intake leaves that
manifest and its release claims unchanged. Presence of this implementation does
not establish that a `v0.86.0` download or any published update contains it.

## Proposed HQ and Distribution follow-up

| Authority or surface | Proposed follow-up |
| --- | --- |
| HQ Studio workflow/feature representation | Describe combined caption/Accuracy Save, failure/retry, and explicit recovery of unfinished fields, with source-only availability until release evidence authorizes a stronger claim |
| HQ Studio limitations and local data-processing evidence | Add browser-profile/origin scope, exact retention/admission bounds, failure and clearing behavior, no media/keys, and the narrow recovery scope |
| HQ Studio preview/workflow evidence | Carry the bounded source-level transition correction only with its actual qualification limitations; make no fixed-latency or released-availability claim |
| `landing/studio/index.html` | Review the `/studio/` workflow and feature copy after HQ acceptance; avoid automatic-backup, universal multi-tab protection, or released-availability claims |
| `docs/studio/index.md` | Carry the approved Save/recovery instructions, conflict/download path, privacy/retention details, and limitations |
| `governance/hq/portfolio.json`; `governance/hq/sync-lock.json` | Use the governed Phase 2 transport/synchronization workflow after an exact accepted HQ input; do not hand-edit around its authority checks |

Distribution's Phase 2 surfaces are known from its README. The authorized HQ
checkout/intake input and exact plan digest are unavailable, so the proposal does
not invent HQ schema fields, digest values, or approvals. Maintainers must prepare
the new HQ Phase 3 intake first, then the corresponding Distribution Phase 2 plan.

The current Phase 2 policy blocks the `public-visibility` approval class used by
the relevant `dataProcessing` authority. That unresolved policy/approval boundary
must be reported and resolved through its authorized workflow. A release-specific
exception or earlier release approval cannot be reused for this new change, and
the validators must not be weakened to admit it.

This record prepares the follow-up only. It performs no HQ/Distribution writes,
publication, deployment, release promotion, commit, or push, and does not grant
approval for those actions. The local documentation requirement is established;
the exact downstream diff and approval requirements remain uncertain until HQ
evidence is available.
