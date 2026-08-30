# Studio update-signing custody and agent invocation

This document defines the production boundary for signing Sthang Studio OTA
metadata. It is an implementation and operations contract, not evidence that a
production key, signing broker, R2 namespace, release, or public OTA service
exists.

## Decision

Studio agents never receive the Ed25519 private key.

ChatGPT chat mode and Codex invoke one repository-owned GitHub Actions workflow.
GitHub supplies only the isolated signing job with a short-lived OpenID Connect
(OIDC) identity. A dedicated Sthang signing broker verifies that identity,
verifies the immutable release package itself, and returns a signed manifest plus
a Studio-key-signed provenance attestation. The private key remains behind the
broker's custody boundary.

This avoids all of the following:

- pasting a private key into a ChatGPT or Codex prompt;
- placing a private key in the public Studio repository;
- exposing a private key to a development checkout or agent sandbox;
- storing the key as a reusable Studio Actions secret available to arbitrary
  workflow code;
- issuing a long-lived Cloudflare, R2, or signing token to an agent;
- copying signing material into release artifacts, logs, issues, or comments.

## Invocation paths

The workflow is `.github/workflows/studio-ota-sign.yml` and remains manually
initiated.

- ChatGPT chat mode can comment exactly `/studio-ota-sign` on an open issue whose
  title starts with `release:`.
- Codex may use the same issue-comment path or GitHub's manual workflow dispatch
  path.
- Issue comments are limited to repository owners or organization members, and
  the workflow independently queries GitHub's calculated repository permission.
  The requester must have `write` or `admin` access.
- Both paths run the exact accepted `main` commit. The workflow checks `main`
  before and after packaging, immediately before signing, and again after the
  broker returns.
- A future release commit must include bounded release notes at
  `release-notes/v<version>.txt`. The version is validated as SemVer before it is
  used in a path or PowerShell expression. The workflow does not accept ad hoc
  release notes from an issue comment or shell input.

## Privilege separation inside GitHub Actions

The workflow has two jobs with different trust boundaries.

### Build job — no OIDC permission

The build job checks requester permission and accepted-main identity, installs
the reviewed dependency graph, runs Studio's release validation, and creates the
ordinary Windows recovery package plus the unsigned OTA package. It receives no
`id-token: write` permission and cannot request a signing identity.

It copies only five fixed files into a short-lived Actions artifact:

```text
manual-windows.zip
manual-windows.zip.sha256
package.zip
package.zip.sha256
release.unsigned.json
```

### Signing job — OIDC, no product build code

The signing job receives `id-token: write` and the `studio-release-signing`
environment. It does not run `npm ci`, package scripts, Studio source, local
caption code, setup scripts, Python, or release build tools.

It checks out only:

- the signing workflow;
- the committed public trust root;
- `scripts/update-protocol.mjs`;
- `scripts/update-signer-client.mjs`.

The two executable repository files are verified against reviewed immutable Git
blob identifiers before Node executes them. Every third-party action in this job
is pinned to a full commit SHA. The job downloads the fixed build artifact into a
separate directory, rejects unexpected files, and only hashes or reads those
files; it never executes or extracts the release package.

The production broker must independently allowlist the exact workflow bytes,
signer-client SHA-256, and update-protocol SHA-256 carried in the request. A
source or workflow change therefore cannot silently expand signing authority.

## Production private-key custody

Generate one Studio-specific Ed25519 key outside every repository, GitHub runner,
and agent sandbox. The key must never be reused by ACO or another product.

Keep two controlled forms:

1. **Working copy:** an encrypted account-level Cloudflare Secrets Store secret
   bound only to the dedicated Studio signing Worker. The Worker may retrieve the
   secret at runtime but must never return, log, export, or include it in an
   exception.
2. **Recovery copy:** an encrypted offline backup held separately from
   Cloudflare, with documented owner access, recovery, and rotation procedure.

The public key and a non-secret key identifier are the only key values committed
to `config/update-trust-root.json`. A focused reviewed Studio PR provisions that
public trust root. Deleting or losing the recovery copy must be treated as a
release-blocking incident even if the Worker still has its working secret.

Do not use a Studio repository or organization Actions secret for the production
private key. A secret injected into a GitHub runner is readable by trusted
workflow code and creates a larger exfiltration boundary than a purpose-built
signing broker.

## Signing broker OIDC policy

The broker must verify the GitHub OIDC JWT against GitHub's published issuer and
JWKS and require all of these claims:

- issuer: `https://token.actions.githubusercontent.com`;
- audience: `https://signer.sthang.app/studio-ota`;
- repository: `Sthang-Co-Ltd/Sthang-Studio`;
- the stable Studio repository id;
- repository visibility: `public`;
- subject/environment: `studio-release-signing`;
- ref: `refs/heads/main`;
- event name: `workflow_dispatch` or `issue_comment`;
- workflow ref: the exact Studio signing workflow on `main`;
- workflow SHA and source commit matching the request;
- actor and actor id matching the request;
- run id and run attempt matching the request;
- an unexpired token with a previously unused JWT id;
- a GitHub-hosted runner environment.

The broker must fetch the workflow at the token's workflow SHA, compare its bytes
with an allowlisted reviewed revision, and verify the signer-client and protocol
hashes declared in the request. It must also query GitHub to confirm the source
commit is still the current accepted `main` commit during prepare and again
during finalize.

The broker must reject retries that reuse a completed session or would overwrite
an immutable object. Run id, run attempt, actor, source commit, workflow SHA,
workflow/client/protocol hashes, version, manifest digest, package digest, and
session id belong in its audit record.

## Broker release protocol

The repository client uses a two-stage upload so GitHub never receives a
Cloudflare API token and the signing Worker does not accept an arbitrary document
to sign.

### 1. Prepare

The signing job sends:

- the normalized unsigned Studio manifest;
- its canonical SHA-256;
- package SHA-256 and byte count;
- source commit and ref;
- repository, workflow, environment, actor, and run identity;
- exact workflow, signer-client, and update-protocol hashes.

The broker validates the request and returns a short-lived single-session upload
URL below `https://uploads.sthang.app/v1/studio/sessions/`. The URL is never
printed. The client accepts only a small upload-header allowlist and requires
`If-None-Match: *` so the upload is create-only.

### 2. Upload and finalize

The signing job streams the already verified package to the one-time upload URL,
then obtains a fresh OIDC token for finalization.

Before signing, the broker must read the uploaded R2 object itself and verify:

- the session is unexpired, unused, and bound to the same OIDC identity;
- the immutable object did not previously exist;
- package byte count and SHA-256 match the request and manifest;
- product, platform, channel, version, immutable URL, dependency declarations,
  compatibility, and bounded release notes satisfy Studio's protocol;
- source commit remains the current accepted `main` commit;
- workflow and executable-client hashes still match the allowlist.

The broker signs the canonical unsigned manifest without changing any reviewed
field. It then creates a separate signed `release-attestation` document binding:

- session id;
- complete source, actor, workflow, and run identity;
- workflow, signer-client, and protocol hashes;
- version and canonical unsigned-manifest digest;
- exact signed-manifest digest;
- package digest and size;
- verification time.

The repository client independently verifies both signatures, every unsigned
manifest field, every attested provenance field, package identity, and the local
receipt before retaining output. An unsigned generic receipt is not accepted as
broker provenance.

## Latest-pointer signing

The same Studio key may later sign `latest.json`, but the broker must expose a
separate, non-generic promotion operation. It must never accept arbitrary bytes
to sign.

Promotion requires the exact immutable-release attestation and local receipt,
verified public object bytes, a newer version than the current pointer, and the
separately approved clean-Windows/release evidence. The signer creates the
pointer; a separate release operation advances the mutable object. The workflow
in this source change does not promote `latest.json`.

## GitHub environment and repository settings

Create a GitHub environment named `studio-release-signing` before enabling the
workflow. Restrict it to `main`. It does not hold the private key. Set the
non-secret environment variable `STHANG_STUDIO_SIGNER_URL` to:

```text
https://signer.sthang.app/v1/studio
```

Environment creation, protection rules, repository variables, signer deployment,
Cloudflare secrets, R2 bindings, DNS, and production access are settings or
production actions and remain separately approval-gated.

## Rotation and incident response

A new key uses a new key id and a deliberate transition release. Never overwrite
the meaning of an existing key id.

If the working key, recovery copy, signing Worker, GitHub workflow trust, or R2
immutability may be compromised:

1. stop signing and latest promotion;
2. disable the signing Worker route or key binding;
3. preserve broker, GitHub run, and object audit evidence;
4. keep the existing GitHub Release recovery path available;
5. rotate to a newly generated Studio key through reviewed source and release
   procedures;
6. do not claim an OTA recovery until installed-client trust transition has been
   tested.

## Current state

The Studio trust root remains unprovisioned, the signing broker is not deployed,
and the workflow cannot successfully request a signature. This fail-closed state
is intentional. No production key, provider credential, repository setting,
release, upload, deployment, or latest-pointer promotion is added by this
architecture.
