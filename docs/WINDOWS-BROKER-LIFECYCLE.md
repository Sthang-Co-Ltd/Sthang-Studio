# Windows broker lifecycle — unreleased implementation

This is source implementation and validation guidance, not a public release or
permission to deploy, sign, upload, publish, or promote anything. The published
v0.85.4 artifacts and their release identity remain unchanged. macOS remains
manual-download only. This implementation does not repair installed copies until
a separately approved transition/recovery release delivers it.

## Two different version identities

`config/studio-broker.json` identifies the bundled Windows broker as **1.0.1**.
Its four executable files are a fixed allowlist: `scripts/launch-studio.ps1`,
`scripts/update-runtime.mjs`, `scripts/update-protocol.mjs`, and
`scripts/prepare-studio-update.ps1`. No signed descriptor may add destinations.
The launcher verifies their byte lengths/hashes before exporting
`STHANG_STUDIO_BROKER_VERSION=1.0.1`. The ampersand-safe relative batch invocation
from PR #49 is retained. Preparation is resolved relative to the selected broker
module, not an obsolete installation-root copy.

The legacy `brokerVersion` field in `config/update-trust-root.json` remains
**1.0.0** in this implementation. The existing production signer already reads
that field as the release's **minimum admission version**. It is not the new
bundled broker's identity. The launcher supplies the actual running broker
identity through the existing environment contract; source/direct launches
without that contract remain conservative. The local OTA packager now derives
its minimum from the same config instead of hard-coding 1.0.0.

Keeping this admission floor at 1.0.0 allows a transition release to reach old
clients. Raising it to 1.0.1 in the first transition would strand those clients
before they could install the transition. Only a later, separately reviewed
release may raise the floor after delivery and recovery are proven.

`npm run verify:broker` verifies the descriptor against the source's **exported**
bytes, including `.gitattributes` CRLF conversion for PowerShell files, and rejects
a minimum newer than the bundled recovery broker. Package and installed checks
compare raw bytes; they do not normalize modified files into acceptance. Once a
broker version is published, its complete bundle/descriptor must remain immutable.
Changes to any of those four files require a new broker version and reviewed
predecessor fingerprints. Never regenerate hashes just to waive an unknown edit.

## Authenticated source, not receipts alone

Self-maintenance runs once during initialization of the update service. All
check/download/install routes share that initialization promise. It is local
bookkeeping for a previously confirmed app OTA, not a new download, background
network poll, or silent app install. Caption processing/editing does not call it.

An eligible app must be running from the exact activated `versions/<app-version>`
directory. Its active marker, preparation receipt, and successful activation
rollback record must agree. App `pending-install.json` and `transaction.json`
must be absent. The service gives an in-flight activation a bounded local settling
window; it never races it or extends the existing 90-second health timeout.

Receipts and markers alone are insufficient. Maintenance re-verifies the retained
`updates/staging/<app-version>/release.json` with the committed Studio Ed25519
public key, verifies the complete package length and SHA-256, safely inspects the
ZIP in memory, and binds the exact broker descriptor/file bytes to that package.
It also checks app identity, expansion bounds, lockfile and Python declarations.
The archive cannot choose filesystem destinations. Unknown fields, unsupported ZIP
entries, traversal, case collisions, links, protected state, altered signatures,
or altered broker bytes stop maintenance before replacement.

No release-manifest schema fields, key custody, hosted services, or signer
endpoints change. Old schema-1 clients continue to understand the transition.
The broker descriptor is authenticated transitively by the existing signed
manifest's package hash and exact accepted-source package verification.

When a release can upgrade an admitted older broker, its signed notes must include this exact bounded plain-text
line, explaining the maintenance in the offer the user accepts:

```text
Includes a verified update-helper upgrade.
```

`stage-ota-candidate.ps1` checks that disclosure and the broker source before any
private staging upload whenever the bundled version exceeds the admission floor.
An ordinary later release with the same broker and matching minimum needs no
false upgrade announcement: authenticated, identical installed bundles are no-ops.
Ordinary unsigned validation packages can still be built
without publishing; they do not authorize real maintenance. Do not add this line
to historical v0.85.4 notes or overwrite its immutable objects. Prepare a new app
release identity only under separate release approval.

## Atomic selection of a complete bundle

The stable installation root and app/user-state locations do not move. Instead
of replacing several live scripts independently, maintenance stages the four
files and descriptor into a private candidate beneath `broker-versions/`, checks
all bytes, Node syntax/imports and the PowerShell non-launching probe, then moves
the complete candidate to immutable `broker-versions/1.0.1/`.

It verifies the existing broker against signed, explicit predecessor fingerprints
(including known 1.0.0 source/export line endings and the reviewed one-line restart
repair). Unknown local modifications, newer unrecognized brokers, hard links and
redirected ancestors are refused; they are not overwritten or called repaired.

A byte-exact backup and prepared audit record are retained under
`updates/broker-maintenance/backups/`. Only then is the stable
`scripts/launch-studio.ps1` atomically replaced on the same filesystem. That one
entrypoint selects the complete broker bundle. Root copies of the other legacy
broker files are retained, and the desktop `run-windows.bat` is unchanged. A fresh
manual installation without a bundle uses and verifies its complete root broker.

There is no multi-file in-place atomicity claim. Before the switch the complete
old broker remains selected; after it the complete new bundle is selected. Every
source/activation snapshot and installed-file hash is rechecked before the switch.
The resulting entrypoint/bundle is reverified. An immediate verification/audit
failure restores the verified previous launcher, unless another writer's changed
bytes make automatic restoration unsafe. Backups and completed slots are retained.

An exclusive maintenance lock prevents cooperating writers from interleaving.
It is never stolen merely because it looks old. After a process/power interruption,
a stale lock may require maintainer review: establish that its owner is gone,
verify the old/new complete selection against signed evidence and the retained
backup, then clear only that stale lock under explicit repair authority. There is
no automatic stale-lock deletion. This affects update maintenance, not stored
projects; physical power-loss recovery remains a native acceptance gate.

The running old PowerShell launcher still has its old code loaded after the file
switch. The update panel therefore requests a **normal Studio restart** before
another download/install; it must not spoof 1.0.1 in the old process environment.
A subsequent launch verifies and reports the new broker. The app is not forcibly
closed by maintenance, so unsaved caption work can be saved before restarting.

Maintenance does not modify app activation pointers, app preparation receipts,
source versions, packages/manifests, trust roots, credentials, `.env`, projects,
media, captions/locks/history, corrections, jobs/checkpoints, proposals, exports,
fonts, or caches. New bundle and maintenance-audit paths are local runtime state,
not telemetry, and are excluded from public source. The existing cloud/provider
and privacy-consent boundaries are unchanged.

## Recovery and later admission gating

The existing manifest validator rejects a signed `minBrokerVersion: 1.0.1` offer
when the actual loaded broker is 1.0.0, before package download or installation.
The existing `manualInstallerRequired` rejection remains in force. The minimum
is deliberately **not raised** by this implementation or by a source merge.

This is the intended separately validated transition:

```text
old 1.0.0 -> compatible app OTA -> verified 1.0.1 bundle -> normal restart
          -> later app OTA may require 1.0.1
```

Self-maintenance after successful activation cannot repair an old broker that
cannot launch the transition at all. In particular, an unrepaired 1.0.0 broker
under a path containing `&` may still need the digest-checked maintainer repair
in `OTA-UPDATES.md`, or a newly published manual recovery package that actually
contains 1.0.1. The general installer targets `%LOCALAPPDATA%\Sthang Studio\app`;
it is not an in-place repair for arbitrary custom/source installation roots.
Do not edit `active.json`, fabricate receipts, silently move a custom install,
patch signed immutable versions, or weaken signature/health checks to bypass this.

## Verification and release gates

Use local commands; this feature does not add or dispatch hosted workflows:

```text
npm run verify:broker
npm run test:broker
npm run test:updater
npm run test:update-powershell
npm run typecheck
npm run build
npm run test:public
npm run check:public
npm run ci
```

The broker suite uses ephemeral in-memory Ed25519 keys, synthetic app metadata,
disposable filesystems and real `git archive` fixtures. It verifies signatures,
allowlists, unknown-file refusal, links, admission floors, unchanged app/user
state, idempotency, concurrency, changed evidence, immediate failure rollback,
and runtime-path exclusion from current/history public checks. The native
PowerShell probe explicitly skips off Windows; a skipped probe is not a pass.

Before merge/release acceptance, a Windows maintainer must record exact revisions
and run the entire repository suite plus these native integration gates:

- [ ] Unmodified 1.0.0 broker, synthetic transition app, real app health, broker
      bundle staging/switch, explicit restart, and actual reported 1.0.1.
- [ ] Later signed synthetic offer requiring 1.0.1: 1.0.0 rejected before any
      download; repaired/restarted client completes the full update normally.
- [ ] Failed app activation leaves the previous app/broker usable; a failed broker
      switch restores its previous launcher and leaves app/user state unchanged.
- [ ] Interrupt before bundle completion, before launcher switch, and after
      switch; validate complete old/new selection, retained evidence and stale-lock
      recovery. No pointer or receipt is fabricated to make the test pass.
- [ ] Fresh manual Windows package and custom-root recovery, ordinary/spaced/`&`/
      parentheses/Khmer paths, real launcher, prior-version restart and state/key
      preservation. Recovery may not depend on the broken old restart command.
- [ ] Recheck exact accepted main after source acceptance; build/verify deliberate
      recovery assets and a new signed transition only under release approval.

## Public-impact handoff

**Public impact: required.** Proposed change identity:
`studio-windows-broker-lifecycle-20260917` (not an executed HQ intake).
This document and `config/studio-broker.json` are implementation evidence only.
The existing product manifest remains the v0.85.4 public-release proposal rather
than falsely declaring a new broker release verified. During approved release
preparation, update that manifest's change ID, documentation-impact summary and
installation evidence using its existing strict schema/verifier, preserving the
separation between source version and externally verified public release.

HQ's Studio release/download and Windows update/recovery representation, then
Distribution's `/studio/` website and docs installation/update/troubleshooting
surfaces, need exact transition/recovery release evidence before new public
claims. No HQ/Distribution record, approval digest, website, signing service,
release object, or public pointer is changed by this implementation. Their
separate governed intake/synchronization approvals still apply.
