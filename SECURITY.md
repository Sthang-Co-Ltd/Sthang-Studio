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

Never send a real Gemini API key, Contributor withdrawal token, analytics relay
project key, Cloudflare credential, or private corpus sample as part of a report.
If a credential may have been exposed, revoke/rotate it where possible and report
only a redacted value.

## Security-sensitive areas

Extra care is welcome around:

- local API origin/binding and request validation;
- file upload, media replacement, and path handling;
- API-key storage/redaction;
- project/history/cache isolation;
- command/process execution for FFmpeg and local timing;
- dependency and model-download supply chain behavior;
- optional analytics allow-list enforcement, Sthang relay validation, and consent checks;
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

## Caption-data import boundary

Portable caption data is untrusted local input. Accept only the exact supported
schema/version, bounded UTF-8 size and caption/word counts, finite source-relative
timing, valid Unicode, known fields and grapheme-safe exact-text word spans. Do not
evaluate markup, import filesystem paths, reuse external caption identities, or
treat unknown fields/future versions as trusted metadata. The ZIP handoff is an
export only; restoring it does not extract arbitrary archive entries.

Restore requires preview, exact saved media/revision and candidate-digest checks,
explicit confirmation, and a local History checkpoint. Existing locked captions
and active processing block replacement. No ordinary correction-memory or
Contributor capture runs for imported content. Download names and ZIP entries are
fixed/safe and exclude media, font binaries, credentials and project context.

## Contributor and analytics trust boundaries

The public v0.85.x line keeps Khmer Caption Contributor and optional product
analytics **off unless the user explicitly enables each choice**. Both cloud
paths also fail closed if their production configuration is missing.

The local Contributor credential is a high-entropy pseudonymous withdrawal/upload
token. Production corpus storage must persist only its SHA-256, never the raw
token. The Contributor id/token must remain separate from the random product-
analytics installation id. Report any path that links those identities without a
new explicit product/privacy decision.

The contribution client must never send a full video, project title, source
filename, local path, unrelated caption text, topic/context text, correction
memory, SRT contents, Gemini key, or product-analytics id. The Sthang intake
Worker also fails closed if private project/API fields appear in a contribution
payload. Audio is bounded to the short correction range plus small context and is
hash-checked before intake.

Submitted corpus samples are not trusted training truth. Only the maintainer-
controlled corpus QA path may mark them verified. Rejected sample audio is
removed, unverified submitted samples are retention-bounded, and contributor-wide
withdrawal deletes the Contributor's private R2 objects and blanks contributed
text in D1. Report any way to bypass those states, access another Contributor's
samples, overwrite another candidate id, avoid deletion/retention cleanup, or
make the public app expose the corpus admin secret.

The contribution admin token, analytics relay project key, D1/R2 identifiers that
are private operational coordinates, production Cloudflare API tokens, and corpus
samples must not be committed to the public repository or placed in public
logs/issues. Public Worker templates may contain only non-secret placeholders.

Optional product analytics is sent from Studio only to the Sthang-owned
`analytics.sthang.app` relay through a fixed event/property allow-list. The relay
revalidates event names, property keys/types, request size, and the random UUID
before adding any downstream processor-specific fields. Studio must not contain
the downstream analytics project key/protocol or browser autocapture/session
replay. Report any way for browser/project-supplied values to inject caption/media
content, filenames, project names, paths, context/vocabulary, SRT contents, API
keys, names/email addresses, or Contributor ids into analytics.

## macOS managed FFmpeg source and download integrity (v0.86 contract)

For **v0.86**, the managed Apple Silicon fallback is a separately distributed
FFmpeg 8.1.3/ffprobe build from nine fixed, SHA-256-verified upstream source
archives. The Sthang GitHub Release tag is
`runtime-ffmpeg-8.1.3-macos-arm64-r1`; its required immutable assets are
`Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-tools.zip`,
`Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-corresponding-source.zip` and
`Sthang-Studio-FFmpeg-8.1.3-macOS-arm64.build-receipt.json`, each with an exact
`.sha256` sidecar. The tools and source are not bundled into the Studio app ZIP;
the installer selects the verified tools separately when necessary. **This is
the required release contract, not proof of a verified runtime hash, completed
native acceptance, uploaded assets or an available download.** The historical
`v0.85.6` upstream fallback and its owner-approved exception remain strictly
limited to that release, not authority for the v0.86 binary.

The v0.86 Mac runtime selector requires both `ffmpeg` and `ffprobe` to identify
stable numeric versions **8.1.3 or newer** in native arm64 executables; FFmpeg
must also expose libass complex shaping and libx264 support. It rejects older,
nightly and unparseable versions. Compatible user-installed newer runtimes do not require a
Sthang-specific checksum; the **managed v0.86 tools** must instead be bound to
the exact versioned Sthang-hosted tools URL and independently reviewed SHA-256
in `scripts/macos-managed-runtime.sh`, checked before extraction or execution.
If the verified runtime/URL/hash is unavailable, setup must fail safely, not
fall back to an unreviewed old binary or bypass the version requirement. End-user
setup does not compile FFmpeg or install Homebrew/`sudo` prerequisites.

Before Sthang distributes the runtime, the native build and third-party source
chain must match `config/macos-ffmpeg-build-lock.json` and the audited
builder, including FFmpeg's GPL/version3/libass/libx264 configuration without
nonfree/OpenSSL components, Apple Silicon Mach-O deployment floor **12.3**,
system-only dynamic links and Khmer rendering/export checks. The FFmpeg GitHub
Release must make the exact original source, build instructions, notices,
checksum sidecars and provenance receipt durably available alongside the binary.
The installer must preserve existing state and fail closed on download, checksum,
capability or setup failure; an untrusted ZIP, mutable tag or local build alone is
not sufficient release evidence. Do not place user media, credentials, project
files, internal account identifiers, or private build-environment secrets in
build logs, receipts or release assets. The combined FFmpeg+x264 executable is
subject to GPL-3.0-or-later distribution terms separate from Sthang Studio's
MIT-licensed application source; full corresponding source and independent legal
review are required. Neither source publication nor a GPL notice establishes
H.264 patent clearance, Apple code signing, or notarization.

**Managed runtime SHA-256 validation is not the Studio Ed25519 OTA signature.**
The FFmpeg prerequisite download is a separate setup-time supply-chain boundary;
it does not create, authorize or promote a signed macOS application update offer.
See `docs/MACOS-FFMPEG-PROVENANCE.md` and `THIRD_PARTY_NOTICES.md` for the
source/license obligations and outstanding review gates.

## Signed update trust

The updater uses a Studio-specific Ed25519 public trust root. The published
`0.8.0` bootstrap provisioned the reviewed **public** verification key so later
signed Studio updates can be verified. The repository contains no production
private signing key and no private provider custody coordinates. A committed
public key or signed immutable release does not by itself establish that a new
`latest.json` offer has been promoted.

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
as supported releases. The current `v0.86` source is **prepublication**; it does
not replace the published `v0.85.6` release or validate a new Mac runtime.
Signed-update availability still depends on the matching separately
verified and deliberately promoted platform `latest.json` pointer; publication of
the recovery package alone does not make a Mac OTA offer live.

## Public bug reports

Ordinary reproducible bugs that do not expose credentials, private media,
contribution samples, or a security weakness should be filed through the normal
GitHub issue template.
