# Browser playback and updater safety

Status: development source, not a released-build acceptance claim.

## Scope

- A synchronous server-wide lease excludes updater preparation from job creation,
  resume, export, compatibility processing, and local playback-copy preparation
- HEVC/browser decode recovery generates one bounded local H.264/AAC MP4 preview,
  retaining original media, caption timestamps and export inputs
- Windows updater-only preparation requires usable KFA and its model; ordinary
  manual setup intentionally retains Whisper fallback
- Activation health has hard total/per-attempt deadlines and bounded bodies
- API version, frontend-owned version/build identity, fresh launch identity and
  launched-process liveness must all pass before acceptance

## Preview limits and recovery

Only local regular upload files are read. FFmpeg runs without a shell and with
restricted input formats/protocols. One encoder and two bounded probes can run.
Copies are at most 720p and 512 MiB; inputs are limited to two hours; encoding is
limited to 15 minutes. Total reusable preview storage is bounded to 2 GiB.
Progress, cancellation, failed preparation and retry are visible. Source
replacement/deletion cancels in-flight work before removing cached data. An
expired copy can be rebuilt from the unchanged original. No cloud upload, new
model, dependency, telemetry or export format is introduced.

## Verification

Run `npm run test:updater`, `npm run test:media-preview`,
`python tests/windows_timing_check_test.py`, `npm run test:browser`,
`npm run typecheck`, `npm run build`, and the aggregate `npm run ci`.
The native CI job runs preview tests with reviewed FFmpeg on Windows and Linux.
Browser fixtures exercise unsupported HEVC, repeated actions, seek preservation,
cancellation failure and project navigation. Native tests use synthetic media
and disposable local state; no real update, signing key or release is involved.

Native Windows batch/PowerShell installation and process-tree behavior, real
Windows browser codecs, and installed Apple Silicon bootstrap/rollback acceptance
still require native evidence. An isolated source snapshot cannot substitute for
the required complete-history public-readiness scan. Source tests do not prove
zero regressions or an accepted public release.

## Public impact: required

This is a new source-only intake proposal, `studio-preview-update-safety-20261004`.
Product-owned evidence is README.md, PRIVACY.md and docs/OTA-UPDATES.md. It changes
playback compatibility/recovery and updater safety claims, while preserving
existing data-transfer boundaries, original media and exports.

The accepted `.sthang/product-manifest.json` describes the separately governed
0.85.6 release and is not rewritten or weakened to advertise this unreleased work.
Before publication, maintainers should prepare a separate HQ proposal for playback
compatibility, local derived preview retention, updater preparation/activation and
stable-bootstrap delivery. The corresponding Distribution `/studio/` website/docs
must use the accepted release evidence. HQ/Distribution writes, native acceptance,
version/release changes and pointer promotion require their own approval. No
cross-repository synchronization, deployment or release is performed here.
