# Public release checklist

This checklist separates repository work that can be automated from owner/admin
settings that must be reviewed deliberately before Sthang Studio is announced
publicly.

## Repository readiness

- [x] Software license added.
- [x] Sthang trademark/brand terms separated from the software license.
- [x] Public-facing README added.
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

## Before changing repository visibility to Public

Owner/admin actions:

- [ ] Confirm the public-readiness PR is merged and the repository checks are in
      an understood/acceptable state.
- [ ] Run a final secret scan locally on the full repository clone.
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

- [ ] Test installation from a clean Windows user/machine, not from the
      maintainer's existing development folder.
- [ ] Confirm WinGet setup, Node installation, Python 3.12, FFmpeg, KFA setup,
      and local Whisper fallback behavior.
- [ ] Confirm the in-app Gemini key setup stores/retrieves a key correctly and no
      secret is written to tracked files.
- [ ] Run a representative Khmer clip through upload → generate → review →
      export and confirm the exported SRT opens correctly in CapCut.
- [ ] Create a deliberate Git tag/release for the accepted public version.
- [ ] Attach a reviewed release archive/installer to GitHub Releases. Do not tell
      ordinary users to download an arbitrary branch snapshot.
- [ ] Include release notes, Windows requirements, Gemini-key requirement,
      local model download expectations, privacy link, and checksum(s).

## Sthang website

Recommended public flow:

```text
sthang.com → Sthang Studio product page → Download for Windows → latest GitHub Release asset
                                         ↘ View source on GitHub
```

- [ ] Keep Sthang.com as the product-facing front door.
- [ ] Make **Download for Windows** the primary action for non-technical users.
- [ ] Point that action to the latest reviewed GitHub Release asset rather than
      the source-code ZIP.
- [ ] Provide a secondary **View source on GitHub** action for developers and
      contributors.
- [ ] Link to privacy, license/brand terms, and system requirements.

## Licensing follow-up

The repository does not redistribute KFA/Whisper model weights or FFmpeg
binaries. Their upstream terms remain applicable when downloaded/installed.
Before a future packaged installer vendors any third-party binary or model,
perform a separate license review for the exact artifact/build and update
`THIRD_PARTY_NOTICES.md`.

A clean repository check verifies structure and source/build integrity; it does
not replace the clean-Windows installation and real Khmer caption workflow tests
above.
