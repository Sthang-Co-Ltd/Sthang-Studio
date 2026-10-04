# Signed Studio updates (Windows public path; Apple Silicon bootstrap)

This document describes the updater implemented in Studio. The `0.8.0` GitHub Release is the first updater-capable bootstrap, but it is **not evidence that OTA updates are publicly available** by itself. Version `0.85.2` became the first deliberately promoted public signed Windows OTA offer. Its signed immutable objects remain historical and must not be mutated.

Version `0.85.6` introduces a separate installed Apple Silicon macOS bootstrap
using the same explicit user-confirmation and Ed25519 verification model but a
platform-bound `macos-arm64` namespace. It does **not** make any Mac version a live
OTA offer by itself. A Mac offer exists only after its exact source, recovery
installer, immutable OTA package/manifest/attestation, native-Mac acceptance and
signed `macos-arm64/latest.json` pointer are separately verified and promoted.
Users on the older manual-only Mac line install the `0.85.6` GitHub recovery
package once to gain this bootstrap. Promotion of a later Mac in-app offer remains
a separate governed action.

Version `0.8.0` carries the reviewed Studio public verification trust. No public signed `latest.json` pointer is promoted by the 0.8.0 GitHub Release.

Real `0.8.0` client evidence for `0.85.2` exposed a preparation failure before active-version activation: the OTA runtime package intentionally excludes repository-only tests, while the preparation typecheck still required `tests/tsconfig.json`. Dependency setup and signed-package verification completed, then TypeScript validation failed closed and left the prior version active.

Version `0.85.3` was production-signed as immutable evidence but deliberately never promoted after exact unchanged-`0.8.0` preparation showed that the old stable broker still invoked plain source typechecking before activation. Its immutable objects remain historical and must not be mutated. Version `0.85.4` became the promoted emergency recovery and remains the rollback/public baseline until a later pointer is deliberately advanced. It supports unchanged v0.8 brokers through a narrowly bounded compatibility bridge inside their verified `updates/work/.../source` preparation context, while current brokers and curated/manual Windows setup explicitly request runtime-only validation. Normal source `npm run typecheck` still includes repository tests; runtime-only validation still checks shared, server, and web TypeScript. Version `0.85.5` uses the same signed update contract and becomes an in-app offer only after its exact accepted source, curated recovery release, immutable signed OTA package/manifest/attestation, public update origin, upgrade/rollback evidence, and signed `latest.json` pointer are deliberately verified and promoted. Source code, packaging, signing, or signer deployment alone must never be described as a live `0.85.5` OTA offer.

## User experience

Studio checks at most once per browser session/startup and also provides a manual **Check for updates** action. A failed or offline check is non-destructive. Studio never polls continuously, never downloads automatically, and never installs without two explicit choices: **Download & verify**, then **Install & restart**.

Update controls remain secondary to caption work. Installation is blocked while captions have unsaved edits, a text field is active, Review or a regeneration comparison is open, another Studio action is busy, or caption processing is active. Release notes are bounded, sanitized plain text. Browser-visible failures are mapped to safe recovery messages rather than exposing hosting URLs, provider responses, local paths, or secrets.

## Trust and immutable release contract

Studio has dedicated platform-bound Ed25519 trust-root configuration:
`config/update-trust-root.json` for `windows-x64` and
`config/update-trust-root-macos.json` for `macos-arm64`. They use the Studio
update verification key rather than any ACO trust root or credential. Only the
public key is committed. The matching production private key remains outside the
repository behind the dedicated signing-service custody boundary.

For both installed updater bootstraps, the **public verification key is provisioned**
in the committed platform trust root; provisioning that public key does not itself
publish or promote an update.

Provisioning the public key is necessary so the published bootstrap can verify later signed updates. It does not create a signed latest pointer or public OTA offer by itself.

The public Studio updater requires no license, authentication, D1 enrollment, or
device credential. It must never reuse ACO enrollment state, update credentials,
or Tauri updater code.

The Sthang-controlled update endpoints are:

```text
https://updates.sthang.app/studio/windows/latest.json
https://updates.sthang.app/studio/macos-arm64/latest.json
```

The mutable pointer and immutable version manifest are both Ed25519-signed.
Platform names are part of the signed identity, and URLs must remain beneath the
matching immutable platform namespace. Windows retains release-manifest schema 1.
Apple Silicon uses schema 2, which additionally binds the accepted Git commit/tree,
source-owned production-build evidence, the derived-runtime manifest, `arm64`,
the macOS 12.3 floor and the curated-runtime setup strategy. Both platforms bind
the exact package byte length, SHA-256, expanded-size ceiling, lockfile hash,
Python requirement hashes, minimum broker version and bounded release notes.

`npm run package:ota` creates the unsigned Windows candidate.
`npm run package:macos` creates both the manual Mac recovery ZIP and a rootless
unsigned Mac OTA ZIP/manifest from the same exact curated payload. Local protocol
tooling verifies those relationships, but production signing is performed by the
runner-free signing broker. Neither local packaging nor source acceptance uploads a
public OTA release or advances `latest.json`.

## Runner-free production signing broker

The production signer is a dedicated Cloudflare Worker under `infra/ota-signer/`
rather than a GitHub Actions signing job. The owner-controlled private key stays
behind a Cloudflare Secrets Store binding. Windows uses the exact
`/studio-ota-sign` and `/studio-ota-promote` issue commands. Apple Silicon uses
the separately authorized `/studio-ota-sign-macos` and
`/studio-ota-promote-macos` commands. GitHub sends the signed
`issue_comment` webhook directly to `signer.sthang.app`.

The signer service and private R2 staging bucket were deployed separately from the 0.8.0 GitHub Release. Provider-specific account/store/secret identifiers remain outside public source and release documentation. Deployment is infrastructure evidence only; it does not establish that an OTA release exists.

The signer does not accept arbitrary messages, manifests, or upload URLs to sign.
Windows staging remains `staging/<commit>/package.zip`; Apple Silicon staging is
`staging/macos-arm64/<commit>/package.zip`. Before using the Studio key, the
Worker obtains the exact accepted `main` source. Mac signing additionally resolves
that commit's Git tree and verifies every staged tracked payload byte plus every
generated server/web/shared file against the source-owned
`.sthang/macos-release-build.json`. The staged derived-runtime manifest must bind
that exact commit/tree, build-evidence hash and lockfile hash. Only after those
checks does the Worker derive and sign the platform manifest/attestation.

The Worker rechecks accepted `main` immediately before private-key use and again before immutable release-object writes. If `main` changes, the signing request fails rather than signing stale source.

Signing never promotes `latest.json`. Promotion is a separate owner-bound command
per platform and re-verifies accepted source, immutable package/manifest/attestation
and the matching GitHub recovery release before advancing that platform's pointer.

## Staging, activation, and rollback

The existing installation root remains `%LOCALAPPDATA%\Sthang Studio\app`. Runtime/user state remains at its existing stable paths. OTA packages are forbidden from containing `data`, `uploads`, `exports`, `node_modules`, `.venv`, `.env`, update state, version directories, or release artifacts.

A verified package is downloaded under `updates/staging/`. Immediately before install, Studio fetches and verifies the latest pointer and manifest again; a changed manifest cancels activation and requires the user to review the new offer.

After Studio closes, the stable broker safely extracts the ZIP beneath the update area, rejects traversal/absolute/alternate-stream paths and expansion beyond the signed ceiling, rechecks package identity and dependency files, runs locked `npm ci`, prepares the version-local Python environment, and typechecks shared/server/web before the production build. Current brokers explicitly request runtime-only TypeScript validation. The unchanged v0.8 broker invokes plain `npm run typecheck`; a target package may infer runtime-only mode only when the exact legacy broker markers are present, its source root is strictly beneath `<installRoot>/updates/work/.../source`, and repository-only `tests/tsconfig.json` is absent. Curated/manual Windows setup also explicitly requests runtime-only validation because its runtime package omits repository tests. Normal source `npm run typecheck` still includes repository tests. Dependency/setup/build failure happens before the active pointer changes.

Prepared source and dependencies move to immutable `versions/<version>/`. npm's Windows workspace junctions use absolute targets, so runtime startup verifies and refreshes only the known `@kcs/server`, `@kcs/shared`, and `@kcs/web` workspace links after that relocation before building/starting services. An atomic `updates/active.json` pointer chooses the version; the desktop shortcut continues targeting the stable root `run-windows.bat`, which preserves registered-default-browser behavior. The previous pointer and version are retained. The new API and web service must become healthy, and the API must report the offered version, before the transaction is accepted. Failure restores the prior pointer and relaunches the prior version. A power interruption after pointer change leaves a transaction marker; the next normal launch restores the previous pointer before starting.

The old root installation is retained as the initial rollback/manual-recovery version. No OTA path uses the legacy delete-then-copy installer as its atomicity mechanism.

### Apple Silicon activation

The manually installed Mac baseline remains at
`~/Library/Application Support/Sthang Studio/app` and acts as the stable broker
and recovery source. `~/Applications/Sthang Studio.app` is a thin Finder launcher
with the approved icon; `Sthang Studio.command` remains the Terminal recovery
launcher. Neither normal OTA package needs to replace those stable launchers.

A Mac package contains the reviewed prebuilt server/web/shared production output,
not development build tooling. Before activation, the stable broker re-verifies the
signed pointer/manifest/package, holds the same macOS install lock used by the
manual installer for the complete prepare/activate/health/rollback transaction,
safe-extracts the rootless ZIP beneath `updates/work`, rejects traversal,
symlinks/special files, Unicode/case collisions, protected state and expansion
beyond the signed exact size, then verifies package lock, Python inputs,
source-owned build evidence and every derived output hash.

The version runs curated `npm ci --omit=dev --ignore-scripts` plus the reviewed
local timing setup and is moved to immutable `versions/<version>` only after
preparation succeeds. `updates/active.json` changes atomically afterward. The new
API must report the exact offered version and the same-origin production UI must
be healthy before the transaction commits. Health failure or interruption restores
the previous pointer. User data, managed prerequisite tools and the stable baseline
`.env` stay outside immutable versions.

A later manual recovery/bootstrap installer intentionally returns launch authority
to its newly installed baseline: OTA control pointers are backed up under the same
install transaction and removed only at commit. Failure restores both the prior
baseline/launchers and the prior OTA control pointers; immutable versions/receipts
are preserved.

### Maintainer-assisted repair for the affected stable Windows broker

A known stable-broker revision can fail to restart Studio when the installation path contains command-shell metacharacters such as `&`. The affected `scripts/update-runtime.mjs` has SHA-256 `4785bd13a3c5e22623a4f9ccaadc93f1c7ea7f3e0540d83834d7a8cc77aba308`. The durable source correction launches the fixed filename `run-windows.bat` from the already verified installation `cwd`; it does not pass the absolute installation path to `cmd.exe` as command text.

A maintainer-assisted repair is permitted only for an explicitly authorized installation whose stable broker is a regular file and matches that exact affected digest. First confirm Studio is quiescent and no update transaction is active. Save a byte-exact backup outside the public source worktree and verify the backup has the same digest. Prepare the candidate separately, replace exactly the one `path.join(installRoot, 'run-windows.bat')` argument inside `startStudio()` with `'run-windows.bat'`, preserve every other byte, and validate the candidate with Node syntax checking. Recheck the installed digest and quiescent state immediately before an atomic same-directory replacement. Verify the repaired bytes and syntax afterward; if replacement or verification fails, restore only the verified backup.

This procedure changes only the stable installation-root `scripts/update-runtime.mjs`. It does not alter an immutable version directory, signed package or manifest, trust root, launcher, dependencies, update pointer, receipt, credentials, settings, or user data. It does not authorize forced activation or private `apply` invocation. After repair, the normal updater must still re-fetch the public offer and preserve both explicit **Download & verify** and **Install & restart** decisions, exact-version health checks, transaction cleanup, and rollback behavior.

This is a bounded maintainer recovery procedure for matching installed brokers, not evidence that the source fix has been released or delivered fleet-wide. Other affected installations require a separately reviewed delivery mechanism that updates the stable broker before relying on a later OTA payload.

## Dependency and state policy

Each immutable version owns its `node_modules` and `.venv`. This permits `package-lock.json`, npm packages, Python requirements, local timing setup, or supporting scripts to change without mutating the running version. The signed manifest declares those dependency inputs. Caches and all user state remain preserved; a future incompatible state/cache migration must be signed, staged, rollback-safe, and explicitly documented rather than deleting state during source refresh.

The dependency-maintenance source candidate retains the released `pythonFiles`
manifest schema. Platform lock inventories and provisioning code are authenticated
by the signed whole-package SHA-256 before extraction/execution, then the embedded
lock manifest is checked before pip runs. It does not add lock paths to that
legacy field and thereby reject released brokers. Actual Python environments are
prepared at stable private state-root paths rather than beneath relocatable OTA
work directories; each version's `.venv` selects its validated environment.
Interrupted selection is recovered from a durable journal, and prior environments
remain available for rollback. Candidate/native acceptance gates are listed in
`docs/DEPENDENCY-RUNTIME-MAINTENANCE.md`; no update pointer is advanced by this work.

Released Windows brokers can still perform their initial `npm ci` using their
existing Node before candidate setup runs. The new candidate does not inject a
lifecycle hook into that process. After provisioning, its build/typecheck/launch
entrypoints select reviewed private Node or fail before activation. Full replacement
of that initial old-broker process requires a broker/manual-installation upgrade.

The Windows-protected Gemini key already lives outside source versions. The advanced `apps/server/.env` fallback remains in the stable installation root and is selected through `STHANG_STUDIO_ENV_FILE`. Projects, media, history, correction memory, jobs/checkpoints, proposals, exports, and compatible caches continue using the stable state root.

On macOS, the Keychain-backed Gemini key and stable state root remain outside
version directories as well. The baseline `apps/server/.env` is explicitly
injected into active immutable versions as the advanced fallback.

## OTA production gates

The 0.8.0 GitHub Release provides the bootstrap trust only. For `0.85.5`, and for every later signed Studio release, the rollout must satisfy these gates before the new version is described as available through in-app update:

1. Build the ordinary Windows GitHub Release candidate and OTA candidate for that later version from the same exact accepted `main` commit, with committed bounded release notes.
2. Stage and sign the exact OTA candidate through the production signer; independently verify the signature, package bytes, manifest, attestation, dependency declarations, and immutable R2 objects.
3. Verify the public `updates.sthang.app` serving layer and cache behavior without promoting `latest.json` yet.
4. Run clean Windows installation and representative Khmer caption regression tests, plus dependency-change upgrade, failed setup, interrupted download, interruption before/after pointer swap, failed health, rollback, state preservation, shortcut/default-browser, and manual GitHub recovery tests.
5. Publish and verify the matching deliberate GitHub Release for the offered version so users retain a manual recovery path.
6. Advance signed `latest.json` only from matching verified immutable-release, GitHub Release, and Windows upgrade/rollback evidence.
7. Verify a real installed 0.8.0-or-later bootstrap client offers the intended newer signed version once per session and through the manual check action.
8. Complete approved HQ intake and Distribution synchronization before changing public website/docs claims about OTA availability.

Apple Silicon follows the same evidence principle but its acceptance is
platform-specific: use `npm run stage:ota:macos`, authorize only the Mac signing
and promotion commands, verify the exact schema-2 source/build provenance chain,
exercise install → in-app offer → download/verify → prepare → activation → fresh
launch on real Apple Silicon, test failed preparation/health/interrupted activation
rollback and state preservation, and verify the matching manual Mac recovery release.
The platform pointer must not be promoted before those native-Mac gates pass.

The public anonymous signed OTA model is represented as `public-signed-ota` in
Studio's product manifest. HQ and Distribution must accept and synchronize that
public model before `sthang.app` or the public docs claim OTA availability.
Distribution then needs matching `/studio/` installation, update, privacy,
rollback, troubleshooting, and GitHub recovery documentation based on exact
release and deployment evidence.

The public verification key in 0.8.0 is not public OTA release evidence. No source branch, local build, signer deployment, private staged package, or successful signature is by itself proof that OTA is publicly available. A release is offered in-app only while the matching signed `latest.json` pointer is publicly available and verifies against Studio's committed trust root.


## Source-only admission and activation hardening

New source changes reserve one server-wide admission lease before updater
preparation performs any asynchronous work. Job creation/resume (including
export and direct compatibility processing) and playback-copy preparation share
that boundary across browser tabs. An in-flight admission or active job prevents
installation; preparation failure releases the lease, while successful preparation
keeps it until the authorized restart, even if its requesting tab disconnects.

Windows OTA preparation sets an updater-only strict KFA requirement. Both a fresh
setup and an existing prepared target must pass dependency pins/checks, actual
native imports, the Khmer tokenizer and the prepared model session. Immutable
setup requires a complete reviewed environment and retains the previous one on
failure; runtime Whisper fallback remains lazy. Existing targets also recheck
the exact dependency-lock profile. This check never preloads the large Whisper
model for perceived readiness.

Activation probes now impose per-attempt and total wall-clock deadlines plus a
bounded response body, including stalled or trickling responses. They accept only
HTTP 200 with the expected API version and independently built frontend identity,
and require the fresh launch identity on both services. The launched process must
remain alive through transaction completion. Wrong identity, redirect, timeout,
process exit or health failure restores the previous active pointer.

These changes are not automatically delivered to an already installed stable
broker by placing them in a later immutable OTA payload. A separately approved
manual/bootstrap delivery and clean native Windows/macOS failure/rollback
acceptance are still required. No existing signed object, pointer or release
claim is changed by this source work. The macOS installed-bootstrap acceptance
gate remains in force.
