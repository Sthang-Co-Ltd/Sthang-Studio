# Sthang Studio

**Accurate Khmer captions, ready for CapCut.**

Sthang Studio is a Windows-first caption workspace for Cambodian Khmer creators.
It combines AI-assisted Khmer transcription with local timing,
fast review tools, correction memory, and CapCut-compatible SRT export.

The product is designed around one practical workflow:

```text
Upload → generate → review → export SRT
```

Advanced timing, regeneration, history, corrections, and diagnostics stay
available without crowding the main editing flow.

## Highlights

- Khmer-first transcription and text handling.
- Local caption timing with a Khmer forced aligner and local Whisper fallback.
- Sequential Review with context on first listen and tight replay while editing.
- Caption approval, text/timing locks, correction memory, and project history.
- Non-destructive Current/Proposed regeneration review.
- Precision waveform timing for difficult captions.
- UTF-8 SRT export designed for CapCut workflows.
- Local projects, history, caches, proposals, and exports.
- Windows-protected in-app storage for a Gemini API key.

## Distribution status

The Sthang Studio repository is currently private, and its first public release
is pending owner approval. There is no supported public download at this time.
Package version `0.7.11` is an internal development version, not a public
release. Do not use a development checkout or source archive as a release
artifact.

## Authorized contributor development setup

The following setup is for authorized contributors with repository access. It
is development guidance, not a public download or release path.

### Install from source on Windows

1. Clone or otherwise check out this repository into a stable folder. Do not run
   it directly from a temporary ZIP-preview location.
2. Double-click `INSTALL-NEW-PC.bat`.
3. The installer checks/installs Node.js LTS, Python 3.12, FFmpeg, and the
   Microsoft Visual C++ runtime needed by local timing. WinGet is preferred when
   available; clean x64 Windows machines can use the reviewed direct per-user
   fallback instead.
4. Launch **Sthang Studio** from the desktop shortcut or run `run-windows.bat`.
   After the local services are healthy, Studio opens in the registered default
   Windows browser. Chrome is not required; Microsoft Edge is supported.
5. Open **Settings → AI connection** and add your own Gemini API key.
6. Upload media, generate captions, review the uncertain parts, and export SRT.

The first local timing setup can download a Khmer alignment model (roughly a few
hundred MB). The local Whisper fallback downloads its selected model only if it
is needed.

### Requirements

- Windows 10/11 x64.
- WinGet recommended but not required for the one-click installer.
- Internet access for initial dependency/model setup and Gemini transcription.
- A Gemini Developer API key for AI caption wording.
- Enough local disk space for Python/Node dependencies, media, caches, and
  downloaded timing models.

macOS/Linux contributors may run the source with compatible Node/Python/FFmpeg
setups, but the installer, desktop shortcut, and protected in-app key storage are
currently Windows-first.

## What runs locally and what uses Gemini

Sthang Studio is local-first, but it is **not fully offline** when generating AI
caption wording.

**Local on your computer:**

- the Sthang Studio frontend and API (`127.0.0.1`);
- imported media, project state, history, correction memory, caches, proposals,
  jobs, and SRT exports;
- caption timing/alignment;
- KFA processing and the faster-whisper timing fallback.

**Sent to Gemini when you generate/regenerate AI wording:**

- the normalized WAV audio needed for the transcription operation;
- relevant topic context, protected vocabulary, accuracy hints, and accepted or
  proposed wording when those are part of the requested pass.

The application requests `store: false` for Gemini transcription interactions.
Google's own service terms, quotas, retention, and data-handling rules still
apply. See [`PRIVACY.md`](PRIVACY.md) for the full application data-flow summary.

## API-key handling

On Windows, the recommended **Settings → AI connection** flow stores the Gemini
key using Windows user-protected storage under `%LOCALAPPDATA%\Sthang Studio`.
The browser receives only a masked key. An `apps/server/.env` key remains
supported as an advanced fallback and is excluded from Git.

Never commit or publish a real API key.

## Development

Read [`AGENTS.md`](AGENTS.md) before changing the application. Product and UX
behavior are also documented in [`PRODUCT.md`](PRODUCT.md),
[`DESIGN.md`](DESIGN.md), and [`UX-AUDIT.md`](UX-AUDIT.md).

Typical setup:

```text
npm install
npm run check:public
npm run typecheck
npm run build
npm run dev
```

For the full Windows local-timing environment:

```text
setup-local-timing-windows.bat
```

The Python worker can be syntax-checked without downloading models:

```text
python -m py_compile local-timing/worker.py
```

Pull requests are expected to pass the repository CI on both Windows and Linux.
The build/typecheck flow also verifies the owner-approved Studio brand assets
byte-for-byte.

## Repository workflow

`main` is the latest accepted Sthang Studio baseline. Development uses focused,
short-lived branches and pull requests. Please avoid committing directly to
`main` for normal feature work.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution expectations and
[`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## Documentation

- [`PRODUCT.md`](PRODUCT.md) — product purpose and priorities
- [`DESIGN.md`](DESIGN.md) — interface and interaction rules
- [`BRAND.md`](BRAND.md) — approved Sthang Studio identity system
- [`CHANGELOG.md`](CHANGELOG.md) — version history
- [`UX-AUDIT.md`](UX-AUDIT.md) — UX findings and validation targets
- [`PRIVACY.md`](PRIVACY.md) — local/cloud data flow and key handling
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — dependency/model notices
- [`TRADEMARKS.md`](TRADEMARKS.md) — Sthang name and brand-asset terms

## License and brand

The software is licensed under the [MIT License](LICENSE), except where a file
or third-party component states otherwise.

The **Sthang**, **Sthang Studio**, wordmarks, approved Studio marks, icons, and
other Sthang identity assets are not granted for unrestricted trademark use by
the MIT software license. See [`TRADEMARKS.md`](TRADEMARKS.md).

Third-party libraries, downloaded models, hosted APIs, and external tools such
as FFmpeg remain subject to their own terms. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Product relationship

Sthang Studio is a Sthang product. Captions is its current Khmer-first
workspace. CapCut is a third-party product; Google/Gemini is a third-party
service. Their names are used only to describe compatibility or configured
integrations and do not imply sponsorship or endorsement.

---

**Sthang Studio** is developed by Sthang. Product information: https://sthang.app/
