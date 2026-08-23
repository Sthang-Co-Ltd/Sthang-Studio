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
- [x] Contribution guide and PR/issue templates added.
- [x] Third-party dependency/model notice added.
- [x] Git ignore rules hardened for credentials and runtime/private data.
- [x] CI added for public-readiness scanning, typecheck, build, brand verification,
      and Python worker syntax.
- [x] Public-readiness script scans the current tree and full Git history for
      common secret patterns and forbidden runtime paths.
- [x] Broken public-install `khmercut==0.2.0` pin replaced with a range matching
      published `khmercut` releases; KFA's direct runtime requirements are kept
      explicit because KFA itself is installed with `--no-deps`.

## Before changing repository visibility to Public

Owner/admin actions:

- [ ] Confirm the public-readiness PR is merged and CI is green on `main`.
- [ ] Run a final secret scan locally on the full repository clone.
- [ ] In GitHub repository Settings, change visibility from **Private** to
      **Public** only after the preceding checks are complete.
- [ ] Enable branch protection/rules for `main` and require the CI validation
      check before merge.
- [ ] Enable GitHub private vulnerability reporting / Security Advisories if it
      is not already enabled.
- [ ] Review repository Discussions/Issues settings and enable only the public
      community surfaces Sthang intends to maintain.

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

A clean CI run verifies repository structure and source/build integrity; it does
not replace the clean-Windows installation and real Khmer caption workflow tests
above.
