# Public release checklist

This checklist separates repository work that can be automated from owner/admin
settings that must be reviewed deliberately before Sthang Studio is announced
publicly.

The repository and its existing Beta release are public. Version `0.7.14` is the
next release declaration. Its tag, curated ZIP, checksum, and GitHub Release do
not exist until the unchecked release gates below are completed from an accepted
clean commit.

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
- [x] Public-readiness script scans the current tree and full Git history for
      common secret patterns and forbidden runtime paths.
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

## Before changing repository visibility to Public

Owner/admin actions:

- [x] Confirm the accepted public-readiness changes are on `main` and the local
      checks are in an understood/acceptable state.
- [x] Run a final secret scan locally on the full repository clone.
- [x] In GitHub repository Settings, change visibility from **Private** to
      **Public** only after the preceding checks are complete.
- [ ] Enable branch protection/rules for `main` and require the CI validation
      check before merge once the hosted runners are available.
- [ ] Enable Dependabot alerts/security updates and GitHub private vulnerability
      reporting / Security Advisories if they are not already enabled.
- [ ] Consider enabling public code scanning/CodeQL after the repository is
      public.
- [ ] Review repository Discussions/Issues settings and enable only the public
      community surfaces Sthang intends to maintain.
- [ ] Add a repository social-preview image and useful repository topics after
      the public product page/visuals are ready.

## Version 0.7.14 public distribution

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
      `npm run build` from the accepted `0.7.14` release commit. Hosted GitHub
      Actions may remain unavailable while the account's monthly allowance is
      exhausted; record local evidence instead of reporting hosted checks as run.
- [x] Run `npm run package:windows` from the accepted `0.7.14` release commit and
      inspect the resulting archive. Its extracted top level should contain only
      `Install Sthang Studio.bat`, `Read Me.txt`, and `Sthang Studio Files`.
- [x] Install once from that curated ZIP into `%LOCALAPPDATA%\Sthang Studio\app`,
      confirm the desktop shortcut works, then delete the extracted setup folder
      and confirm Studio still launches and existing local state remains intact.
- [ ] Create the deliberate `v0.7.14` tag and prerelease from the accepted commit.
- [ ] Attach `Sthang-Studio-Windows-v0.7.14.zip` and
      `Sthang-Studio-Windows-v0.7.14.zip.sha256` to GitHub Releases. Verify the
      uploaded bytes against the local SHA-256 before announcing them. Do not
      tell ordinary users to download the repository source ZIP or an arbitrary
      branch snapshot.
- [ ] Include release notes, Windows requirements, Gemini-key requirement, local
      model download expectations, privacy links, and the verified checksum.
- [ ] Confirm the release notes explain that `store: false` does not control the
      Files API upload, Studio does not explicitly delete the remote WAV, and
      Google currently documents storage for up to 48 hours.
- [ ] Reconcile the accepted `0.7.14` release through the approval-gated
      product-to-HQ and HQ-to-Distribution workflow before changing website
      version or download claims.

The existing public Beta launch attached its reviewed curated Windows ZIP and
checksum to GitHub Releases. The gates above apply again to `0.7.14`; prior
release evidence does not satisfy them automatically.

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

This verification record is excluded from the curated payload. Before publishing,
verify that the release tag's packaged source paths still match the tested
payload. The remaining unchecked publication and synchronization gates still
require completion.

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
not replace the clean-Windows installation and real Khmer caption workflow tests
above.
