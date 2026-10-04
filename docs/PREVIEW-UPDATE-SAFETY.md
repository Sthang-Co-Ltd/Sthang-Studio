# Browser playback and updater safety

Status: development source, not a released-build acceptance claim.

## Scope

- A synchronous server-wide lease excludes updater preparation from job creation,
  resume, export, compatibility processing, and local playback-copy preparation
- HEVC/browser decode recovery generates one bounded local H.264/AAC MP4 preview,
  retaining original media, caption timestamps and export inputs
- Windows update preparation rechecks usable KFA and its cached model on fresh
  and reused targets; immutable setup preserves the previous environment on
  failure, while runtime Whisper fallback stays lazy
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

## Integration with reviewed dependencies

This source combines playback/update safety with the reviewed dependency/runtime
maintenance described in [DEPENDENCY-RUNTIME-MAINTENANCE.md](DEPENDENCY-RUNTIME-MAINTENANCE.md).
Private Node selection and immutable Python provisioning remain intact. A cached
Windows update target must pass the authenticated lock manifest, exact dependency
profile and non-downloading KFA functional check before it can be reused. The
readiness helper disables telemetry before importing timing libraries. Build
identity and curated macOS build hashes are generated from the combined source.

## Verification

Run `npm run test:updater`, `npm run test:media-preview`,
`python tests/windows_timing_check_test.py`, `npm run test:browser`,
`npm run typecheck`, `npm run build`, and the aggregate `npm run ci`.
The native preview suite supports reviewed FFmpeg on Windows and Linux.
Validation for this integration is local; GitHub Actions are not run.
Browser fixtures exercise unsupported HEVC, repeated actions, seek preservation,
cancellation failure and project navigation. Native tests use synthetic media
and disposable local state; no real update, signing key or release is involved.

Native Windows batch/PowerShell installation and process-tree behavior, real
Windows browser codecs, and installed Apple Silicon bootstrap/rollback acceptance
still require native evidence. An isolated source snapshot cannot substitute for
the required complete-history public-readiness scan. Source tests do not prove
zero regressions or an accepted public release.

## Combined-source validation (2026-10-04)

The integration with dependency main `7a18c168` was checked locally using reviewed
Node 24.21.0. Clean locked installation, typecheck, production build, brand and
manifest guards passed; curated build evidence was regenerated for 91 derived
files. Python timing tests passed 65/65, dependency/bootstrap tests 20/20 plus the
persistent-to-recovery privacy test, macOS policy fixtures 116/116, updater tests
86 passed/1 Windows-only skip, preview tests 9/9, and native caption tests 20
passed/1 skip. The remaining aggregate component suites passed except the
previously reproduced ICU Khmer partition assertion. Two optional native-effect
assertions also match failures in the untouched baseline under host FFmpeg 7.1.5.

Independent checks passed runtime/dependency tests on Node 22.23.3 and 24.21.0,
media/admission tests on Node 22, and real Vite 8 frontend identity delivery.
PowerShell 7.6.6 parsed the scripts and passed signed-control-file integrity,
atomic-write and preparation-order fixtures. The full Windows extraction fixture
cannot run on Linux because of its Windows path-containment semantics; real
Windows PowerShell 5.1 and junction/process behavior remain native gates.

`npm run ci` stops at the known source-watch Unix-socket restriction. Browser
collection finds 162 cases, but local Chromium execution has the same restriction.
Historical PR65 browser execution passed 161/162, including all eight added preview
cases; its remaining unchanged replay/manual-seek race is not claimed fixed.
The known Node/GenAI forced-GC transport-abort limitation in the dependency report
also remains unresolved. No GitHub Actions were started for this integration.
Current-tree public checks pass; the local source snapshots do not establish a
new full-history clone scan or installed-release acceptance.

## Mid-edit player recovery follow-up (source only)

Explicit Retry now retires the failed media element and creates a fresh player,
instead of asking the same decoder instance to reload. It keeps the local
caption draft, prepared source, playhead, playback rate, volume and mute setting;
playback remains paused. Review/replay ownership is cancelled on failure, late
events from the retired player are ignored, and native caption geometry observes
the replacement element. Repeated Retry before metadata retains the pending
playhead. Error copy distinguishes browser read, decode and open failures without
exposing raw decoder messages or file paths.

This addresses the ineffective Retry path reported in Chrome. The original
intermittent mid-edit decoder failure has not been reproduced or attributed to a
specific trigger. The reported installed build is unverified. Local native
preview/recovery tests pass 12/12; adjacent clock/timing tests pass 13/13, and
typecheck/production build pass. Five new browser scenarios plus the eight existing
scenarios collect, but Chromium execution is blocked by the environment's
Unix-socket permission restriction. A separate browser-fixture type check retains
the baseline TimedToken fixture error. Real Chrome/Windows acceptance is still
required; no new release, deployment or Actions run is implied.

Public impact for this follow-up: none beyond the existing source-only proposal.
It repairs the documented playback recovery workflow, with no new capability,
data transfer, retention, installation or public-availability claim. The existing
manifest and separately approval-gated HQ/Distribution proposal remain unchanged.

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
