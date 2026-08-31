# Security policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability, leaked
credential, or report that contains private media/project data.

Prefer GitHub's private vulnerability reporting / Security Advisory flow when it
is enabled for this repository. If that option is not available, contact Sthang
using the private contact method published on https://sthang.app/ and include
`Sthang-Co-Ltd/Sthang-Studio` in the subject or first line.

A useful report includes:

- affected version, branch, or commit;
- operating system and relevant setup details;
- a minimal reproduction that does not expose other people's data;
- expected versus observed behavior;
- likely impact, if known.

Never send a real Gemini API key as part of a report. If a credential may have
been exposed, revoke/rotate it first and report only a redacted value.

## Security-sensitive areas

Extra care is welcome around:

- local API origin/binding and request validation;
- file upload, media replacement, and path handling;
- API-key storage/redaction;
- project/history/cache isolation;
- command/process execution for FFmpeg and local timing;
- dependency and model-download supply chain behavior;
- signed update manifests, immutable package URLs, ZIP extraction, staged
  dependency preparation, active-version pointers, health validation, and
  rollback/recovery behavior;
- production signer webhook authentication, replay prevention, accepted-source
  verification, archive parsing, Secrets Store isolation, and immutable R2 writes.

## Signed update trust

The updater source uses a Studio-specific Ed25519 public trust root. The
repository contains no production private signing key. The accepted source stays
fail-closed until the approved public key is provisioned in an exact release
source and the serving/release gates are complete. Do not place a production
private key, recovery passphrase, Cloudflare credential, R2 credential, GitHub
webhook secret, or release-signing secret in source, issues, Actions logs,
release notes, or test fixtures.

Production signing is designed so ChatGPT and Codex never receive the private
key. The runner-free Cloudflare signer under `infra/ota-signer/` receives only
HMAC-verified GitHub issue-comment webhooks, reads the Studio key through a
Cloudflare Secrets Store binding, and signs only a release manifest it derives
after the staged package's full file set and every file byte match the exact
accepted `main` source projection. It must never accept a generic arbitrary-byte
or arbitrary-manifest signing operation.

Versioned update manifests and packages are intended to be immutable. Report any
way to bypass webhook authentication/replay checks, make the signer accept bytes
that do not match accepted source, bypass signature/hash verification, overwrite
immutable R2 version objects, redirect outside `updates.sthang.app`, traverse or
overwrite local paths, replace runtime/user state, activate before dependency
preparation succeeds, suppress rollback, or expose raw provider/path/secret
details through the browser UI as a security issue using the private process
above.

## Supported versions

Security fixes target the latest accepted `main` branch and the most recent
published release. Older development ZIPs and historical builds are not treated
as supported releases.

## Public bug reports

Ordinary reproducible bugs that do not expose credentials, private media, or a
security weakness should be filed through the normal GitHub issue template.
