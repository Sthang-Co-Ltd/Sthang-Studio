# Security policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability, leaked
credential, or report that contains private media/project/contribution data.

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

Never send a real Gemini API key, Contributor withdrawal token, Cloudflare
credential, or private corpus sample as part of a report. If a credential may
have been exposed, revoke/rotate it where possible and report only a redacted
value.

## Security-sensitive areas

Extra care is welcome around:

- local API origin/binding and request validation;
- file upload, media replacement, and path handling;
- API-key storage/redaction;
- project/history/cache isolation;
- command/process execution for FFmpeg and local timing;
- dependency and model-download supply chain behavior;
- optional analytics allow-list enforcement and consent checks;
- Contributor consent boundaries, local queue isolation, short-audio extraction,
  contributor-token handling, retry/withdrawal state, and corpus payload
  minimization;
- contribution Worker request bounds, pseudonymous authentication, D1/R2
  isolation, idempotency, rejection/retention cleanup, and contributor-wide
  deletion;
- signed update manifests, immutable package URLs, ZIP extraction, staged
  dependency preparation, active-version pointers, health validation, and
  rollback/recovery behavior;
- production signer webhook authentication, replay prevention, accepted-source
  verification, archive parsing, Secrets Store isolation, and immutable R2 writes.

## Contributor and analytics trust boundaries

The unreleased v0.8 source keeps Khmer Caption Contributor and optional product
analytics **off unless the user explicitly enables each choice**. Both cloud
paths also fail closed if their production configuration is missing.

The local Contributor credential is a high-entropy pseudonymous withdrawal/upload
token. Production corpus storage must persist only its SHA-256, never the raw
token. The Contributor id/token must remain separate from the random PostHog
analytics installation id. Report any path that links those identities without a
new explicit product/privacy decision.

The contribution client must never send a full video, project title, source
filename, local path, unrelated caption text, topic/context text, correction
memory, SRT contents, Gemini key, or PostHog id. The Sthang intake Worker also
fails closed if private project/API fields appear in a contribution payload.
Audio is bounded to the short correction range plus small context and is hash-
checked before intake.

Submitted corpus samples are not trusted training truth. Only the maintainer-
controlled corpus QA path may mark them verified. Rejected sample audio is
removed, unverified submitted samples are retention-bounded, and contributor-wide
withdrawal deletes the Contributor's private R2 objects and blanks contributed
text in D1. Report any way to bypass those states, access another Contributor's
samples, overwrite another candidate id, avoid deletion/retention cleanup, or
make the public app expose the corpus admin secret.

The contribution admin token, D1/R2 identifiers that are private operational
coordinates, production Cloudflare API tokens, and corpus samples must not be
committed to the public repository or placed in public logs/issues. The public
Worker template may contain only non-secret placeholder configuration.

Optional product analytics is sent server-side through a fixed event/property
allow-list. Studio does not include PostHog browser autocapture or session replay.
Report any way for browser/project-supplied values to inject caption/media content,
filenames, project names, paths, context/vocabulary, SRT contents, API keys, or
Contributor ids into analytics.

## Signed update trust

The updater uses a Studio-specific Ed25519 public trust root. The unreleased
`0.8.0` bootstrap source provisions the reviewed **public** verification key so a
later deliberately published bootstrap build can verify signed Studio updates.
The repository contains no production private signing key and no private
provider custody coordinates. Provisioning public trust does not establish that
`0.8.0`, a signed update, or `latest.json` is publicly available.

Do not place a production private key, recovery passphrase, Cloudflare
credential, R2 credential, GitHub webhook secret, release-signing secret, or
private account/store/secret identifier in source, issues, Actions logs, release
notes, or test fixtures.

Production signing is designed so ChatGPT and Codex never receive the private
key. The separately deployed runner-free Cloudflare signer under
`infra/ota-signer/` receives only HMAC-verified GitHub issue-comment webhooks,
reads the Studio key through a Cloudflare Secrets Store binding, and signs only a
release manifest it derives after the staged package's full file set and every
file byte match the exact accepted `main` source projection. It must never accept
a generic arbitrary-byte or arbitrary-manifest signing operation.

The signer rechecks accepted `main` immediately before private-key use and again
before immutable version-object writes. Staged packages remain private until a
deliberate release flow verifies and publishes matching public objects. The
signing command never promotes the mutable latest pointer.

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
as supported releases. Until `0.8.0` is deliberately published, the verified
public Beta remains `v0.7.14` even if `main` contains unreleased bootstrap and
Contributor/analytics source.

## Public bug reports

Ordinary reproducible bugs that do not expose credentials, private media,
contribution samples, or a security weakness should be filed through the normal
GitHub issue template.
