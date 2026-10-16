# Reviewed-caption media replacement — public-impact record

Change ID: `studio-preserve-reviewed-media-20261015`

Status: source-only implementation, not a released-download claim.
**Public impact: required.** This changes the replacement workflow and adds local
recovery state for visual revisions of an already reviewed project.

## Intended scope

Creators can explicitly choose to keep reviewed captions when replacing footage
with a visual-only revision. Local verification must find compatible full-length
audio and timeline evidence before the replacement becomes active. Equal file
duration is not enough. Uncertain or incompatible evidence stops the preserving
operation; it must never silently reset captions or request generation.

Caption wording, segment and word timing, approval and lock flags, canonical
transcript state, and project appearance remain editing state. A new frame shape
or crop still requires checking caption placement against the new image. A local
recovery snapshot keeps the prior project and media available for explicit
restoration. Restoration must guard newer edits and use a fresh media identity.

The separate start-over choice remains explicitly destructive to the active
caption set. Neither mode authorizes a fresh AI request.

## Evidence and privacy

Product-owned workflow and retention documentation belongs in `README.md`,
`PRODUCT.md`, `PRIVACY.md`, and `CHANGELOG.md`. Implementation and synthetic
regression evidence are in the replacement route, local compatibility/recovery
services, and dedicated API/browser tests. This change adds no hosted service,
provider, dependency, telemetry event, or automatic media upload. Verification
uses local media tooling. Backups contain private source media and project state
and must remain in ignored local runtime storage and follow project deletion.

## Downstream handoff

The current `.sthang/product-manifest.json` and its validator bind the separately
governed v0.86.0 release proposal. This new change ID records the feature intake
without overwriting that accepted release evidence or weakening its validator.

Before public representation or release, prepare a new HQ Phase 3 intake covering
Studio's replacement/recovery workflow, supported audio-compatibility limitations,
and local-data retention. After exact-plan approval, synchronize the Distribution
website and documentation under `/studio/` (known surfaces
`landing/studio/index.html` and `docs/studio/index.md`) through its Phase 2 workflow.
HQ/Distribution writes, publication, releases, and deployment are not authorized
by this implementation task. No authorized downstream checkout or new plan-digest
approval was supplied here.

## Validation boundary

Use synthetic media only. Automated verification must cover full-length audio
comparison, re-encoding, mismatched and shifted audio, interrupted replacement,
stale mutations, restart-readable recovery, and browser interactions. Passing
Linux synthetic tests does not establish clean Windows/macOS acceptance or
public-release availability. Exact executed checks belong in the task handoff.
