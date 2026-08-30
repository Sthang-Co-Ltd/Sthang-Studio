# Signed Studio updates (unreleased source architecture)

This document describes the updater implemented in source. It is **not evidence that OTA updates are publicly available**. The verified public Beta remains the matching GitHub Release and its checksum until a later release completes the production gates below.

## User experience

Studio checks at most once per browser session/startup and also provides a manual **Check for updates** action. A failed or offline check is non-destructive. Studio never polls continuously, never downloads automatically, and never installs without two explicit choices: **Download & verify**, then **Install & restart**.

Update controls remain secondary to caption work. Installation is blocked while captions have unsaved edits, a text field is active, Review or a regeneration comparison is open, another Studio action is busy, or caption processing is active. Release notes are bounded, sanitized plain text. Browser-visible failures are mapped to safe recovery messages rather than exposing hosting URLs, provider responses, local paths, or secrets.

## Trust and immutable release contract

Studio has a dedicated Ed25519 trust-root configuration at `config/update-trust-root.json`; it is separate from every ACO trust root or credential. The repository currently carries an explicitly **unprovisioned** public-key slot, so release signing and runtime checks fail closed. Production key generation/custody is a separate approval-gated operation. Only the approved public verification key may later be committed; the private key must stay in external protected custody.

The public Studio updater requires no license, authentication, D1 enrollment, or
device credential. It must never reuse ACO enrollment state, update credentials,
or Tauri updater code.

The planned Sthang-controlled endpoint is:

```text
https://updates.sthang.app/studio/windows/latest.json
```

The mutable pointer and immutable version manifest are both Ed25519-signed. Version manifests and package objects must live below `/v<version>/`, have no query string or redirect, and bind the exact package byte length, SHA-256, expanded-size ceiling, lockfile hash, Python requirement hashes, setup strategy, minimum broker version, and bounded release notes. A pointer is promotable only from a verification receipt produced after the versioned manifest signature and package bytes match.

`npm run package:ota` creates an unsigned local candidate only. `scripts/update-release.mjs` signs, verifies, and creates a promotable pointer from an externally held key; it does not upload or deploy anything. The tooling refuses signing while the trust root is unprovisioned or when the external private key does not match the committed public key.

## Staging, activation, and rollback

The existing installation root remains `%LOCALAPPDATA%\Sthang Studio\app`. Runtime/user state remains at its existing stable paths. OTA packages are forbidden from containing `data`, `uploads`, `exports`, `node_modules`, `.venv`, `.env`, update state, version directories, or release artifacts.

A verified package is downloaded under `updates/staging/`. Immediately before install, Studio fetches and verifies the latest pointer and manifest again; a changed manifest cancels activation and requires the user to review the new offer.

After Studio closes, the stable broker safely extracts the ZIP beneath the update area, rejects traversal/absolute/alternate-stream paths and expansion beyond the signed ceiling, rechecks package identity and dependency files, runs locked `npm ci`, prepares the version-local Python environment, and typechecks the staged source. Dependency/setup failure happens before the active pointer changes.

Prepared source and dependencies move to immutable `versions/<version>/`. An atomic `updates/active.json` pointer chooses the version; the desktop shortcut continues targeting the stable root `run-windows.bat`, which preserves registered-default-browser behavior. The previous pointer and version are retained. The new API and web service must become healthy, and the API must report the offered version, before the transaction is accepted. Failure restores the prior pointer and relaunches the prior version. A power interruption after pointer change leaves a transaction marker; the next normal launch restores the previous pointer before starting.

The old root installation is retained as the initial rollback/manual-recovery version. No OTA path uses the legacy delete-then-copy installer as its atomicity mechanism.

## Dependency and state policy

Each immutable version owns its `node_modules` and `.venv`. This permits `package-lock.json`, npm packages, Python requirements, local timing setup, or supporting scripts to change without mutating the running version. The signed manifest declares those dependency inputs. Caches and all user state remain preserved; a future incompatible state/cache migration must be signed, staged, rollback-safe, and explicitly documented rather than deleting state during source refresh.

The Windows-protected Gemini key already lives outside source versions. The advanced `apps/server/.env` fallback remains in the stable installation root and is selected through `STHANG_STUDIO_ENV_FILE`. Projects, media, history, correction memory, jobs/checkpoints, proposals, exports, and compatible caches continue using the stable state root.

## CI bootstrap evidence (not a release)

Windows pull-request validation runs `npm run test:update-bootstrap`. The test creates an ephemeral Ed25519 pair only inside the runner's temporary directory, signs synthetic versioned metadata, stages a minimal dependency-changing package through the real update service, prepares it through the stable PowerShell broker, activates it through the stable launcher, validates the exact API/web version, preserves representative project/media/export/`.env`/protected-key markers, and exercises interrupted-activation recovery back to the prior version. The ephemeral private key and fixture installation are deleted before the runner completes.

On pushes to `main`, Windows CI also records exact SHA-256 and byte-size evidence for the ordinary Windows ZIP and unsigned OTA candidate, then retains those files for seven days as a GitHub Actions artifact for maintainer testing. `bootstrap-candidate-evidence.json` explicitly records `signed: false`, `published: false`, `promoted: false`, and `releaseEvidence: false`. The artifact is not a GitHub Release, public download, production signature, hosting proof, clean-machine result, or authority to advance `latest.json`.

This automation strengthens repeatable broker evidence but does not replace physical clean-Windows installation, real dependency/model preparation, power/process interruption tests, representative Khmer-to-CapCut regression, externally held production signing custody, or public endpoint verification.

## Production/release gates

Before OTA can be advertised or enabled:

1. Approve production Ed25519 key generation and custody, then commit only the Studio public key and mark the trust root provisioned.
2. Approve and deploy the `updates.sthang.app` serving layer and immutable R2 object policy. Do not allow overwriting versioned keys.
3. Build a clean candidate, sign it externally, verify its exact bytes/manifest, upload immutable objects, and verify them again from the public endpoint.
4. Run clean Windows installation and representative Khmer caption regression tests, plus same-version refusal, dependency-change upgrade, failed setup, interrupted download, interruption before/after pointer swap, failed health, rollback, state preservation, shortcut/default-browser, and manual GitHub recovery tests.
5. Publish the matching deliberate GitHub Release and keep it available as the recovery/download path.
6. Advance `latest.json` only from the matching verification receipt.
7. Complete approved HQ intake and Distribution synchronization before updating public claims or website/docs.

HQ's current product schema can represent `manual-github-release` and
`private-signed-ota`, but not public anonymous signed OTA. A future rollout
therefore requires an approved schema/model extension and an updated Studio
record; this source change must not be mislabeled as private OTA. Distribution
then needs matching `/studio/` installation, update, privacy, rollback,
troubleshooting, and GitHub recovery documentation based on exact release and
deployment evidence.

The committed trust root remains unprovisioned. No step above is authorized by
the source implementation or this document.
