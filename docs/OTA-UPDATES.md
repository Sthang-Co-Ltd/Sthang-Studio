# Signed Studio updates (0.8 bootstrap; OTA not public)

This document describes the updater implemented in Studio. The `0.8.0` GitHub Release is the first updater-capable bootstrap, but it is **not evidence that OTA updates are publicly available**. The curated GitHub Release and its checksum remain the public manual download and recovery path until a later signed release completes the OTA production gates below.

Version `0.8.0` carries the reviewed Studio public verification trust. No public signed `latest.json` pointer is promoted by the 0.8.0 GitHub Release.

## User experience

Studio checks at most once per browser session/startup and also provides a manual **Check for updates** action. A failed or offline check is non-destructive. Studio never polls continuously, never downloads automatically, and never installs without two explicit choices: **Download & verify**, then **Install & restart**.

Update controls remain secondary to caption work. Installation is blocked while captions have unsaved edits, a text field is active, Review or a regeneration comparison is open, another Studio action is busy, or caption processing is active. Release notes are bounded, sanitized plain text. Browser-visible failures are mapped to safe recovery messages rather than exposing hosting URLs, provider responses, local paths, or secrets.

## Trust and immutable release contract

Studio has a dedicated Ed25519 trust-root configuration at `config/update-trust-root.json`; it is separate from every ACO trust root or credential. In the `0.8.0` bootstrap, the **public verification key is provisioned** with key id `studio-updates-ed25519-root-v1`. Only that public key is committed. The matching production private key remains outside the repository behind the dedicated signing-service custody boundary.

Provisioning the public key is necessary so the published bootstrap can verify later signed updates. It does not create a signed latest pointer or public OTA offer by itself.

The public Studio updater requires no license, authentication, D1 enrollment, or
device credential. It must never reuse ACO enrollment state, update credentials,
or Tauri updater code.

The planned Sthang-controlled endpoint is:

```text
https://updates.sthang.app/studio/windows/latest.json
```

The mutable pointer and immutable version manifest are both Ed25519-signed. Version manifests and package objects must live below `/v<version>/`, have no query string or redirect, and bind the exact package byte length, SHA-256, expanded-size ceiling, lockfile hash, Python requirement hashes, setup strategy, minimum broker version, and bounded release notes. A pointer is promotable only from exact verified release evidence after the versioned manifest signature and package bytes match.

`npm run package:ota` creates an unsigned local candidate only. Local protocol tooling can verify manifest/package relationships, but production release signing is performed by the runner-free signing broker described below. Neither local packaging nor source acceptance uploads a public OTA release or advances `latest.json`.

## Runner-free production signing broker

The production signer is a dedicated Cloudflare Worker under `infra/ota-signer/` rather than a GitHub Actions signing job. The owner-controlled private key stays behind a Cloudflare Secrets Store binding. ChatGPT and Codex may invoke signing by posting the exact `/studio-ota-sign` command to an authorized open `release:` issue. GitHub sends the signed `issue_comment` webhook directly to `signer.sthang.app`, so routine signing does not consume GitHub Actions or Blacksmith runner quota.

The signer service and private R2 staging bucket were deployed separately from the 0.8.0 GitHub Release. Provider-specific account/store/secret identifiers remain outside public source and release documentation. Deployment is infrastructure evidence only; it does not establish that an OTA release exists.

The signer does not accept arbitrary messages, manifests, or upload URLs to sign. An owner-controlled local release-preparation step stages an OTA ZIP under a private R2 key bound to the exact current `main` commit. Before using the Studio key, the Worker downloads GitHub's archive for that exact commit, parses both archives, rejects unsafe/protected/unsupported entries, and requires the staged package's complete allowed file set and every file byte to match accepted source. It derives the release manifest itself from accepted source and verified package bytes, signs that canonical manifest plus a provenance attestation, and writes only create-only immutable version objects.

The Worker rechecks accepted `main` immediately before private-key use and again before immutable release-object writes. If `main` changes, the signing request fails rather than signing stale source.

The signing command never promotes `latest.json`. Public update availability still requires the matching immutable objects to be independently verified, the update-serving origin to be verified, clean-Windows release evidence, the matching GitHub recovery release, and deliberate latest-pointer promotion.

## Staging, activation, and rollback

The existing installation root remains `%LOCALAPPDATA%\Sthang Studio\app`. Runtime/user state remains at its existing stable paths. OTA packages are forbidden from containing `data`, `uploads`, `exports`, `node_modules`, `.venv`, `.env`, update state, version directories, or release artifacts.

A verified package is downloaded under `updates/staging/`. Immediately before install, Studio fetches and verifies the latest pointer and manifest again; a changed manifest cancels activation and requires the user to review the new offer.

After Studio closes, the stable broker safely extracts the ZIP beneath the update area, rejects traversal/absolute/alternate-stream paths and expansion beyond the signed ceiling, rechecks package identity and dependency files, runs locked `npm ci`, prepares the version-local Python environment, and typechecks the staged source. Dependency/setup failure happens before the active pointer changes.

Prepared source and dependencies move to immutable `versions/<version>/`. An atomic `updates/active.json` pointer chooses the version; the desktop shortcut continues targeting the stable root `run-windows.bat`, which preserves registered-default-browser behavior. The previous pointer and version are retained. The new API and web service must become healthy, and the API must report the offered version, before the transaction is accepted. Failure restores the prior pointer and relaunches the prior version. A power interruption after pointer change leaves a transaction marker; the next normal launch restores the previous pointer before starting.

The old root installation is retained as the initial rollback/manual-recovery version. No OTA path uses the legacy delete-then-copy installer as its atomicity mechanism.

## Dependency and state policy

Each immutable version owns its `node_modules` and `.venv`. This permits `package-lock.json`, npm packages, Python requirements, local timing setup, or supporting scripts to change without mutating the running version. The signed manifest declares those dependency inputs. Caches and all user state remain preserved; a future incompatible state/cache migration must be signed, staged, rollback-safe, and explicitly documented rather than deleting state during source refresh.

The Windows-protected Gemini key already lives outside source versions. The advanced `apps/server/.env` fallback remains in the stable installation root and is selected through `STHANG_STUDIO_ENV_FILE`. Projects, media, history, correction memory, jobs/checkpoints, proposals, exports, and compatible caches continue using the stable state root.

## OTA production gates

The 0.8.0 GitHub Release provides the bootstrap trust only. Before OTA can be advertised or enabled for a later signed Studio release:

1. Build the ordinary Windows GitHub Release candidate and OTA candidate for that later version from the same exact accepted `main` commit, with committed bounded release notes.
2. Stage and sign the exact OTA candidate through the production signer; independently verify the signature, package bytes, manifest, attestation, dependency declarations, and immutable R2 objects.
3. Verify the public `updates.sthang.app` serving layer and cache behavior without promoting `latest.json` yet.
4. Run clean Windows installation and representative Khmer caption regression tests, plus dependency-change upgrade, failed setup, interrupted download, interruption before/after pointer swap, failed health, rollback, state preservation, shortcut/default-browser, and manual GitHub recovery tests.
5. Publish and verify the matching deliberate GitHub Release for the offered version so users retain a manual recovery path.
6. Advance signed `latest.json` only from matching verified immutable-release, GitHub Release, and clean-Windows evidence.
7. Verify a real installed 0.8.0-or-later bootstrap client offers the intended newer signed version once per session and through the manual check action.
8. Complete approved HQ intake and Distribution synchronization before changing public website/docs claims about OTA availability.

HQ's current product schema can represent `manual-github-release` and
`private-signed-ota`, but not public anonymous signed OTA. A future rollout
therefore requires an approved schema/model extension and an updated Studio
record; this release must not be mislabeled as private OTA. Distribution then
needs matching `/studio/` installation, update, privacy, rollback,
troubleshooting, and GitHub recovery documentation based on exact release and
deployment evidence.

The public verification key in 0.8.0 is not public OTA release evidence. No source branch, local build, signer deployment, private staged package, or successful signature is by itself proof that OTA is publicly available. The verified public distribution remains the matching curated GitHub Release until a later signed latest pointer is deliberately promoted after all required evidence is complete.
