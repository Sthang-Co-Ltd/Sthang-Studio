# Public release requirements and verification record

This document separates maintained release requirements from dated installation
and publication evidence. Historical checkmarks do not verify today's GitHub
settings or authorize another release. Inspect current settings and repeat the
relevant checks for each new release.

The repository and the `v0.8.0` Public Beta release are public. Its exact tag,
curated Windows ZIP, checksum asset, release notes, and GitHub-recorded asset
digest were independently verified on 2026-09-02. HQ intake and Distribution
synchronization remain separately approval-gated.

The historical `v0.7.14` publication record remains below. On 2026-08-28, the
public [Studio page](https://sthang.app/studio/) advertised `v0.7.14`; that dated
observation is preserved as history rather than rewritten as current website
evidence. The owning HQ and Distribution repositories must establish the current
public website/docs state through their separately governed synchronization flow.

## Version 0.8.0 GitHub publication verification

The following checks record the actual v0.8.0 publication rather than an intended
pre-release plan:

- [x] The accepted release source on `main` was
      `ba54570079e9f20516be54cd7c7738a9f4d9745f`.
- [x] `npm run ci` passed locally on that exact release commit, covering the
      public-readiness tests, Contributor/analytics privacy tests, Gemini timeout
      tests, product/public verification, updater tests, typecheck, protected
      brand verification, and production build.
- [x] `npm run test:update-powershell` passed locally on that exact release
      commit.
- [x] `npm run package:windows` passed on that exact release commit and produced
      the curated `Sthang-Studio-Windows-v0.8.0.zip` plus its `.sha256` file. The
      packager verified the intended top-level layout: `Install Sthang Studio.bat`,
      `Read Me.txt`, and `Sthang Studio Files`.
- [x] The locally built curated ZIP SHA-256 was
      `5bad7342e3b3b558d07cd7f2c55e165ec66c2093914fdd16635b32ea95922290`.
- [x] The public GitHub Release is `v0.8.0`, titled **Sthang Studio 0.8.0 Public
      Beta**, non-draft, and marked prerelease/Beta. The tag resolves directly to
      `ba54570079e9f20516be54cd7c7738a9f4d9745f`.
- [x] The release contains `Sthang-Studio-Windows-v0.8.0.zip` and
      `Sthang-Studio-Windows-v0.8.0.zip.sha256`. GitHub records the ZIP digest as
      the same SHA-256 shown above, so the published asset matches the locally
      built release artifact exactly.
- [x] The published release notes include the Windows/Gemini requirements,
      explicit-opt-in Contributor and analytics boundaries, Gemini Files API
      disclosure, current provider retention of up to 48 hours, and checksum
      guidance.
- [x] Before publication, Windows Sandbox testing exercised the v0.8 runtime,
      including the final Gemini resumable-upload compatibility fix, and
      successfully generated captions from representative media.
- [ ] A brand-new clean-Windows installation of the **final curated v0.8.0 ZIP
      bytes** was deliberately not repeated before publication. The earlier
      source/Sandbox runtime validation is useful evidence but is not the same
      check. Do not report this item as passed.
- [ ] HQ intake and Distribution `/studio/` synchronization for the v0.8.0
      public facts remain separately governed and are not established by this
      repository record.
- [ ] No public signed `latest.json` pointer has been promoted. OTA availability
      is not established by the v0.8.0 GitHub Release.

No hosted GitHub Actions or Blacksmith runner was used for the accepted v0.8.0
release validation or publication sequence described above.

## OTA rollout gates — not completed

The source updater described in [`OTA-UPDATES.md`](OTA-UPDATES.md) is included in
the public `0.8.0` bootstrap, but the bootstrap trust is **not evidence that OTA
updates are publicly available**. The curated GitHub Release remains the public
manual download and recovery path until a later signed release completes the
remaining OTA gates.

Setup already completed outside public OTA evidence:

- [x] Studio-specific Ed25519 production signing custody exists outside the
      repository; only the reviewed public verification identity is committed to
      the bootstrap source.
- [x] The runner-free signing Worker, private R2 staging bucket, signing-key
      binding, and GitHub issue-comment webhook were deployed separately. No
      private key, webhook secret, provider credential, or private custody
      coordinate is committed here.

Before OTA can be advertised or enabled for a later signed release:

- [ ] Build and sign a later version from its exact accepted `main` commit so the
      installed bootstrap client has a genuinely newer signed offer to exercise.
- [ ] Test upgrade with changed `package-lock.json`, Node dependencies, and
      Python/local-timing requirements.
- [ ] Test dependency/setup failure before activation, interruption during
      download/preparation, interruption before and after pointer replacement,
      wrong-version/API/web health failure, automatic rollback, and subsequent
      normal launch.
- [ ] Confirm installation is refused during unsaved/text editing, Review,
      Current/Proposed comparison, another busy operation, and queued/running
      caption jobs.
- [ ] Confirm offline/update-host failure leaves the installed version usable.
- [ ] Run a representative Khmer upload → generate → Review → edit/lock/history/
      resume → UTF-8 CapCut SRT export after a successful OTA upgrade.
- [ ] Publish and independently verify the matching deliberate GitHub Release for
      the later offered version so users retain a manual recovery path.
- [ ] Advance the signed `latest.json` pointer only from matching verified
      immutable-release, GitHub Release, and clean-Windows evidence.
- [ ] Verify a real installed client offers the intended newer version once per
      session/startup and through manual **Check for updates**, with explicit
      confirmation for download and installation and no continuous polling.
- [ ] Complete separately approved HQ intake and Distribution `/studio/`
      synchronization before changing public website/docs claims about OTA
      availability. The current HQ update model must not mislabel public anonymous
      signed OTA as private OTA.

Provisioning the public verification key in the bootstrap is expected and safe;
public documentation must still not claim OTA availability until the signed
release objects, clean-Windows evidence, latest-pointer promotion, and governance
gates pass.

## Repository readiness

- [x] Software license added.
- [x] Sthang trademark/brand terms separated from the software license.
- [x] README and public-facing documentation draft added.
- [x] Privacy/data-flow documentation added.
- [x] Security reporting policy added.
- [x] Contribution guide, community code of conduct, support guide, and PR/issue
      templates added.
- [x] Third-party dependency/model notice added.
- [x] Git ignore rules hardened for credentials and runtime/private data.
- [x] Cross-platform Git line-ending rules added.
- [x] Dependabot update configuration added for npm and local Python requirements.
- [x] CI added for public-readiness scanning, typecheck, build, brand verification,
      and Python worker syntax.
- [x] Public-readiness script checks current and historical forbidden paths,
      including deleted files and binary media paths, and scans textual content
      for common secret patterns. It requires a complete clone and covers only
      locally available refs; it does not fetch GitHub state itself.
- [x] `npm run test:public` covers historical-path failures, allowed scaffolding,
      merge changes, other refs, and rejection of shallow clones in disposable
      repositories. The guard does not inspect commit email metadata, arbitrary
      binary contents, GitHub comments, Actions logs, or release assets.
- [x] Windows KFA setup uses the wheel-backed `khmercut==0.0.2` release and
      wheel-first/UTF-8 pip settings. PyPI's newer `khmercut` 0.1.0 release is
      source-only and hit a Windows code-page metadata decode failure during the
      clean Python 3.12 install test; KFA 0.2.0 uses the `tokenize()` API already
      provided by the wheel-backed release.
- [x] Public Node setup uses the committed lockfile through
      `npm ci --include=dev`, keeping the locked build and typecheck toolchain
      available even when the local npm configuration would omit it.
- [x] Curated Windows release packaging keeps the ordinary-user download separate
      from the repository source ZIP and installs into a stable per-user app
      location without exposing developer files at the extracted top level.
- [x] Release checks reject stale private/release-candidate wording in the
      packaged README and require the current Files API retention disclosure.
- [x] The product-owned `.sthang/product-manifest.json` declares public Beta
      identity and release intent without self-referential commits or hashes.

## Historical public-source launch record

The initial public-source launch recorded these owner/admin actions:

- [x] Confirm the accepted public-readiness changes are on `main` and the local
      checks are in an understood/acceptable state.
- [x] Run a final secret scan locally on the full repository clone.
- [x] In GitHub repository Settings, change visibility from **Private** to
      **Public** only after the preceding checks are complete.

## Maintainer settings review

Verify these directly in GitHub when preparing a release. This list is not a
statement that a setting is currently enabled or disabled; changes require the
appropriate owner/admin approval.

- Review `main` branch protection/rules and required CI checks.
- Review Dependabot alerts/security updates and private vulnerability reporting.
- Consider public code scanning/CodeQL.
- Keep only the Discussions/Issues surfaces Sthang intends to maintain.
- Review the repository social-preview image and topics.

## Historical version 0.7.14 distribution verification

These checks record the 2026-08-27 publication. The detailed record below
distinguishes checks run for that ZIP from earlier owner-verified workflows
carried forward. Later documentation or tooling edits do not repeat these tests.

- [x] Test installation from a clean Windows user/machine, not from the
      maintainer's existing development folder.
- [x] Confirm clean-machine Node.js, Python 3.12, FFmpeg, Microsoft Visual C++
      runtime, KFA setup/model preload, ONNX Runtime import, and local Whisper
      fallback readiness. The no-WinGet fallback is the validated clean-Sandbox
      path; WinGet remains preferred when available.
- [x] Confirm the desktop shortcut opens Studio automatically on normal Windows
      after both local services are healthy and respects the registered default
      browser without assuming Chrome. On the maintainer Windows machine this
      correctly opens Chrome. Windows Sandbox lacks a normal `http://` browser
      association, so Sandbox auto-opening is not a release requirement; the
      launcher must avoid the broken protocol dialog and print the local URL for
      manual opening instead.
- [x] Confirm the in-app Gemini key setup stores/retrieves a key correctly and no
      secret is written to tracked files. Clean-Sandbox testing confirmed the
      saved key remains recognized after restart while the browser receives only
      the masked value.
- [x] Run a representative Khmer clip through upload → generate → review →
      export and confirm the exported SRT opens correctly in CapCut.
- [x] Run `npm run check:public`, `npm run verify:brand`, `npm run typecheck`, and
      `npm run build` from the accepted `0.7.14` release commit. The local
      verification record below identifies the checks actually run.
- [x] Run `npm run package:windows` from the accepted `0.7.14` release commit and
      inspect the resulting archive. Its extracted top level should contain only
      `Install Sthang Studio.bat`, `Read Me.txt`, and `Sthang Studio Files`.
- [x] Install once from that curated ZIP into `%LOCALAPPDATA%\Sthang Studio\app`,
      confirm the desktop shortcut works, then delete the extracted setup folder
      and confirm Studio still launches and existing local state remains intact.
- [x] Create the deliberate `v0.7.14` tag and prerelease from the accepted commit.
- [x] Attach `Sthang-Studio-Windows-v0.7.14.zip` and
      `Sthang-Studio-Windows-v0.7.14.zip.sha256` to GitHub Releases. Verify the
      uploaded bytes against the local SHA-256 before announcing them. Do not
      tell ordinary users to download the repository source ZIP or an arbitrary
      branch snapshot.
- [x] Include release notes, Windows requirements, Gemini-key requirement, local
      model download expectations, privacy links, and the verified checksum.
- [x] Confirm the release notes explain that `store: false` does not control the
      Files API upload, Studio does not explicitly delete the remote WAV, and
      Google currently documents storage for up to 48 hours.

The 0.7.14 publication checks used fresh evidence for this release, not the prior
Beta's release assets.

### Local verification record, 2026-08-27

The checked 0.7.14 packaging gates used source commit
`babff6c60b41defc3c936901b5ac4396e0c5b0f5` and the curated ZIP with SHA-256
`e72f240911fb8256375d9728b4ae035eb91701b67386394288c84f0305800a2c`.
All 102 archive entries passed package inspection. The public-readiness,
protected-brand, typecheck, and build checks passed locally; no hosted runner was
used.

A fresh Windows Sandbox completed prerequisite installation, app installation,
and shortcut creation. After the extracted setup folder was deleted, the
installed API reported `0.7.14`, the web service was healthy, and its rendered
setup screen was inspected. Reinstalling the same ZIP preserved synthetic local
data, upload/export markers, and a placeholder environment file. The second
extracted setup folder was also deleted.

The first automated launch failed in a long-running test process that retained
the pre-install environment. The successful retest refreshed the registered
Windows PATH and captured the launcher output. No product defect reproduced and
no product change was needed.
This retest used no real Gemini key or private media. The earlier owner-verified
Gemini and full Khmer-to-CapCut workflow checks are carried forward because this
release does not change those behaviors; they were not repeated in this run.

The release tag resolves to `dfea9961106c6ebf5eb44d3edb7e6ffa208082a4`.
This verification record is excluded from the curated payload. All 102 entries
from a new package of that release commit matched the tested payload byte for
byte. The exact tested ZIP, rather than a recompressed copy, was published.
GitHub's asset digest, the downloaded ZIP, and the downloaded checksum agree.
At publication, the release was non-draft and marked prerelease. This record
describes the tested and published ZIP, not later source-only changes. Future
website changes still require the maintainer coordination described in
[`AGENTS.md`](../AGENTS.md) and the owning repositories.

## Sthang website

Recommended public flow:

```text
https://sthang.app/ → Sthang Studio product page → Download for Windows → latest GitHub Release asset
                                                     ↘ View source on GitHub
```

- [x] Keep https://sthang.app/ as the product-facing front door.
- [x] Make **Download for Windows** the primary action for non-technical users.
- [x] Point that action to the latest reviewed GitHub Release asset rather than
      the source-code ZIP.
- [x] Provide a secondary **View source on GitHub** action for developers and
      contributors.
- [x] Link to privacy, license/brand terms, and system requirements.

## Licensing follow-up

The repository does not commit or redistribute KFA/Whisper model weights or
FFmpeg binaries. The clean Windows installer downloads the reviewed FFmpeg build
at setup time, and model weights are downloaded at runtime; their upstream terms
remain applicable. Before a future packaged installer vendors any third-party
binary or model inside a release asset, perform a separate license review for
the exact artifact/build and update `THIRD_PARTY_NOTICES.md`.

A clean repository check verifies structure and source/build integrity; it does
not replace a clean-Windows installation or a real Khmer caption workflow test.
For v0.8.0 specifically, the publication record above explicitly marks the final
curated-ZIP clean-install check as not run.
