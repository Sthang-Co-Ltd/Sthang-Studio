# Studio update-signing custody and agent invocation

This document defines the production boundary for signing Sthang Studio OTA
metadata. It is an implementation and operations contract, not evidence that a
production key, signing broker, R2 namespace, release, or public OTA service
exists.

## Decision

Studio agents never receive the Ed25519 private key.

ChatGPT chat mode and Codex invoke one repository-owned GitHub Actions workflow.
GitHub supplies that job with a short-lived OpenID Connect (OIDC) identity. A
dedicated Sthang signing broker verifies the identity, independently verifies the
candidate package in immutable storage, and returns only the signed manifest and
a verification receipt. The private key remains behind the broker's custody
boundary.

This avoids all of the following:

- pasting a private key into a ChatGPT or Codex prompt;
- placing a private key in the public Studio repository;
- exposing a private key to a development checkout or agent sandbox;
- storing the key as a reusable Studio Actions secret available to arbitrary
  workflow code;
- issuing a long-lived Cloudflare or signing token to an agent;
- copying signing material into release artifacts, logs, issues, or comments.

## Invocation paths

The workflow is `.github/workflows/studio-ota-sign.yml` and remains manually
initiated.

- ChatGPT chat mode can comment exactly `/studio-ota-sign` on an open issue whose
  title starts with `release:`. The workflow accepts only comments created by a
  repository owner, organization member, or collaborator.
- Codex may use the same issue-comment path or GitHub's manual workflow dispatch
  path.
- Both paths run the exact accepted `main` commit. The job fails if `main` moves
  after the request begins.
- A future release commit must include bounded release notes at
  `release-notes/v<version>.txt`. The workflow does not accept ad hoc release
  notes from an untrusted comment or shell interpolation.

The workflow validates source, tests, builds the ordinary Windows recovery
candidate and unsigned OTA candidate, obtains a short-lived GitHub OIDC token,
invokes the broker, verifies the returned signature against Studio's committed
public trust root, and retains review artifacts. It does not publish a GitHub
Release, deploy a Worker, upload `latest.json`, or advertise the release.

## Production private-key custody

Generate one Studio-specific Ed25519 key outside every repository and agent
sandbox. The key must never be reused by ACO or another product.

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

## Signing broker trust policy

The broker must verify the GitHub OIDC JWT against GitHub's published issuer and
JWKS and require all of these claims:

- issuer: `https://token.actions.githubusercontent.com`;
- audience: `https://signer.sthang.app/studio-ota`;
- repository: `Sthang-Co-Ltd/Sthang-Studio`;
- repository id: the stable Studio repository id;
- repository visibility: `public`;
- subject/environment: the `studio-release-signing` environment;
- ref: `refs/heads/main`;
- event name: `workflow_dispatch` or `issue_comment`;
- workflow ref: the exact Studio signing workflow on `main`;
- source commit and workflow SHA matching the request;
- an unexpired token with a previously unused JWT id.

The broker must additionally fetch the workflow file at the token's workflow SHA
and compare its bytes or SHA-256 with an allowlisted reviewed workflow revision.
Changing the workflow therefore requires a separate broker allowlist update; a
repository write alone cannot silently expand signing authority.

The broker must reject retries that reuse a completed signing session or would
overwrite an immutable object. Run id, run attempt, source commit, version,
manifest digest, package digest, and session id belong in its audit record.

## Broker release protocol

The repository client uses a two-stage upload so GitHub never receives a
Cloudflare API token and the Worker does not need to accept a large package in a
single signing request.

### 1. Prepare

The workflow sends the unsigned manifest, exact unsigned-manifest digest, package
SHA-256, package size, source commit, and GitHub run identity with its OIDC token.
The broker validates the manifest and returns a short-lived, single-object upload
URL for the exact package identity.

The URL may point only to `uploads.sthang.app` or the account's R2 S3 endpoint.
The client does not print it. It permits only a small allowlist of upload headers.

### 2. Upload and finalize

The workflow streams the already verified package to the short-lived URL, then
asks the broker to finalize the same session.

Before signing, the broker must read the uploaded R2 object itself and verify:

- object creation was create-only and the immutable key did not previously
  exist;
- package byte count and SHA-256 match the unsigned manifest and request;
- product, platform, channel, version, immutable URL, setup declarations,
  compatibility, and bounded release notes satisfy Studio's protocol;
- source commit and GitHub OIDC identity still match the prepared session.

The broker signs the canonical unsigned manifest, writes the signed manifest and
verification receipt as immutable versioned objects, then returns the exact
signed-manifest bytes and receipt. The repository client independently verifies
the signature, package identity, and receipt before retaining any output.

## Latest-pointer signing

The same private key may later sign `latest.json`, but the broker must expose a
separate, non-generic promotion operation. It must never accept arbitrary bytes
to sign.

Promotion requires the exact immutable-release receipt, verified public object
bytes, a newer version than the current pointer, and the separately approved
clean-Windows/release evidence. The signer creates the pointer; a separate
release operation advances the mutable object. The release-signing workflow in
this source change does not promote `latest.json`.

## GitHub environment and repository settings

Create a GitHub environment named `studio-release-signing` before enabling the
workflow. Configure it to allow only `main`. It does not hold the private key.
Set the non-secret environment variable `STHANG_STUDIO_SIGNER_URL` to the exact
broker base URL:

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
is intentional. No production key or provider credential is added by this
architecture.
