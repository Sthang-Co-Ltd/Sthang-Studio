# Export caption repair: public-impact intake

- Change ID: `studio-export-caption-repair-20261021`
- State: source-only implementation and intake proposal
- Public impact: required for export checking and correction workflow documentation
- Downstream assessment: uncertain until authorized HQ Phase 3 evidence and the
  exact approval plan are available

## Product change

Export lists affected captions, reasons, remedies and output-specific severity.
Creators can open each caption for repair and return to the current output choices.
Explicit native layout checking identifies frame overflow and overlapping groups,
with request cancellation and invalidation after relevant edits. Word-file
readiness, native render authority and save/conflict protections remain in force.

PR #88 review corrections keep the same source-only scope: handoff-kit checks
include the word files actually selected by the service, and ASS explains failed
appearance prerequisites with explicit recovery. The source workflow document
records these restrictions and retry actions; they introduce no new output format
or public-release claim.

The work uses existing local project data and native rendering. It adds no cloud
provider, analytics event, telemetry, dependency, source-media copy or new durable
user-data category. `PRIVACY.md`, `SECURITY.md` and `THIRD_PARTY_NOTICES.md` retain
their existing local-processing boundary. Installation, operating-system support,
protected artwork, update trust and download authorities are unaffected.

## Evidence and release boundary

| Evidence | Purpose |
| --- | --- |
| `apps/web/src/App.tsx`; `apps/web/src/export-session.ts` | Repair navigation and temporary project/media-scoped choices |
| `apps/web/src/export-checks.ts`; `apps/web/src/components/ExportChecksPanel.tsx`; `apps/web/src/components/export-checks.css` | Caption attribution, severity, explanations, bounded list and accessible actions |
| `apps/web/src/components/ExportWorkspace.tsx`; `apps/web/src/components/CaptionHandoffPanel.tsx`; `apps/web/src/api.ts` | Output decisions and invalidation of native checks |
| `packages/shared/src/caption-interchange.ts`; `apps/server/src/services/caption-handoff.ts` | Format-specific serialization blockers and conditional inclusion of word files in the handoff kit |
| `apps/server/src/routes/video-export.ts`; `apps/server/src/services/export-preflight.ts`; `apps/server/src/services/caption-overflow.ts` | Local native measurement, cancellation and structured findings |
| `README.md`; `PRODUCT.md`; `DESIGN.md`; `CHANGELOG.md`; `docs/EXPORT-CAPTION-REPAIR.md` | Source-only workflow and limits |

The reviewed `.sthang/product-manifest.json` represents the separately governed
`studio-v0-86-0-release-20261013` change. Preserve its release/distribution/update
evidence. This new source feature does not establish that published v0.86.0
downloads contain the repair workflow or authorize a new release claim.

## Proposed downstream follow-up

| Authority or surface | Proposed update |
| --- | --- |
| HQ Studio workflow/features | Caption-specific export checks, direct repair and return navigation, explicit local native layout check; retain source-only availability until release evidence advances |
| HQ Studio limitations | QA suggestions remain advisory; word-file readiness and styled-output blockers differ; a checked draft does not certify final encoding or destination-editor compatibility |
| `landing/studio/index.html`; `docs/studio/index.md` | Review `/studio/` export guidance after HQ acceptance, including return-to-export and the check's limits |
| `governance/hq/portfolio.json`; `governance/hq/sync-lock.json` | Transport the exact accepted HQ input through Distribution Phase 2 |

Distribution's README was read. Phase 2 requires clean authorized checkouts,
immutable evidence and approval of the exact digest/classes. The authoritative
HQ checkout is not in the connected roots. Prepare the new Phase 3 intake when
that evidence is available, then its matching Distribution plan. This PR prepares
the product-owned handoff; it does not write to HQ/Distribution, deploy the website
or publish a release.
