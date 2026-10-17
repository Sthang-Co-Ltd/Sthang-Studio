# Reviewed-caption media replacement — public-impact record

Change ID: `studio-preserve-edited-audio-20261017`

Status: source-only implementation, not a released-download claim.
**Public impact: required.** This extends the preserving workflow to explicitly
accepted audio changes and records local unverified-alignment provenance.

## Intended scope

Creators can keep reviewed captions for visual-only revisions through the existing
verified-audio path. They can additionally accept volume edits, music or sound
effects after complete local file/decoder/timeline safety validation finds audio
differences. The concise warning states that existing caption/word times remain
and alignment is the creator's responsibility. Acceptance is bound to replacement
bytes and current project/media revision, expires, and cannot survive a restart.
An unverified-alignment flag persists through reload and History. Equal duration
alone is not proof, and overall duration changes, caption bounds beyond EOF,
unsafe timestamps, corruption, decoder errors or storage failures remain blocked.
Unaccepted/stale/canceled requests leave the active project unchanged; no silent
reset or automatic generation is permitted.

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
audio-change acceptance, unchanged duration/bounds limits, unverified-alignment
reminders, blocked old-transcript automatic retiming and local-data retention.
Proposed HQ fields are the source-change intake/workflow capability, compatibility
limits and local-retention evidence; this is not a new public-download claim.
After exact-plan approval, synchronize the Distribution
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
