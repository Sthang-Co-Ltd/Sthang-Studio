# Public release checklist

This checklist separates repository work that can be automated from owner/admin
settings that must be reviewed deliberately before Sthang Studio is announced
publicly.

Current status: version 0.7.12 is the public-beta release candidate. The
repository remains private and no public source or download has been published.
Owner/admin visibility and release gates below are still required before public
announcement; until then, do not advertise a public source or download path.

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
- [x] Public Node setup uses the committed lockfile through `npm ci`.
- [x] Curated Windows release packaging keeps the ordinary-user download separate
      from the repository source ZIP and installs into a stable per-user app
      location without exposing developer files at the extracted top level.

## Before changing repository visibility to Public

Owner/admin actions:

- [ ] Confirm the public-readiness PR is merged and the repository checks are in
      an understood/acceptable state.
- [x] Run a final secret scan locally on the full repository clone.
- [ ] In GitHub repository Settings, change visibility from **Private** to
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

## First public distribution

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
- [x] Run `npm run check:public`, `npm run typecheck`, and `npm run build` locally
      on the PR branch. All passed on Windows; hosted GitHub Actions could not run
      because the account's monthly Actions allowance was exhausted.
- [ ] Run `npm run package:windows` from the accepted release commit and inspect
      the resulting archive. Its extracted top level should contain only
      `Install Sthang Studio.bat`, `Read Me.txt`, and `Sthang Studio Files`.
- [ ] Install once from that curated ZIP into `%LOCALAPPDATA%\Sthang Studio\app`,
      confirm the desktop shortcut works, then delete the extracted setup folder
      and confirm Studio still launches and existing local state remains intact.
- [ ] Create a deliberate Git tag/release for the accepted public version.
- [ ] Attach the reviewed curated Windows ZIP and its `.sha256` file to GitHub
      Releases. Do not tell ordinary users to download the repository source ZIP
      or an arbitrary branch snapshot.
- [ ] Include release notes, Windows requirements, Gemini-key requirement,
      local model download expectations, privacy link, and checksum(s).

## Sthang website

Recommended public flow:

```text
https://sthang.app/ → Sthang Studio product page → Download for Windows → latest GitHub Release asset
                                                     ↘ View source on GitHub
```

- [ ] Keep https://sthang.app/ as the product-facing front door.
- [ ] Make **Download for Windows** the primary action for non-technical users.
- [ ] Point that action to the latest reviewed GitHub Release asset rather than
      the source-code ZIP.
- [ ] Provide a secondary **View source on GitHub** action for developers and
      contributors.
- [ ] Link to privacy, license/brand terms, and system requirements.

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
