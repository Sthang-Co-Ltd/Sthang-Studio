# Privacy and data flow

Sthang Studio is designed as a local-first desktop-style workspace served from
your own computer. Caption wording currently uses Google's Gemini service;
caption timing and project editing are handled locally.

This document describes the behavior of the application itself. It
is not a substitute for the privacy terms of third-party services you choose to
use.

## What stays on your computer

The application runs its frontend and local API on loopback (`127.0.0.1`).
Projects, source media, timing data, caches, and exports persist locally on your
computer unless you explicitly export or otherwise share them:

- imported source media and normalized working audio;
- reusable selected-range PCM WAVs created from that normalized audio;
- caption projects and edits;
- correction memory and profile data;
- project history, proposals, processing-job metadata, and resumable job checkpoints;
- project-scoped KFA acoustic-emission caches and deterministic local timing-result caches;
- browser-memory waveform/spectrum data while Studio remains open;
- SRT exports;
- local timing/alignment using KFA, with faster-whisper as a local fallback.

Performance caches are derived from media already owned by the local project. They
are bounded and are kept under the project's existing cache/runtime locations so
normal project/media invalidation can remove them. Browser waveform caches are
memory-only and disappear when the browser page/process is closed.

Runtime data lives under the installation's local directories and is excluded
from Git by `.gitignore`.

## Local preparation before Generate

After new or replacement media is saved, Studio may begin local-only preparation
shortly afterward: normalizing the audio and warming the local timing runtime.
This is intended to reduce the delay after you later choose Generate or Improve.
This prewarming does **not** upload audio to Gemini. A cloud transcription request
still begins only after you explicitly request caption generation/regeneration.

## What is sent to Gemini

When you generate or regenerate AI caption wording, Sthang Studio sends the
normalized WAV audio needed for that operation, plus relevant topic context,
protected vocabulary, accuracy hints, and accepted or proposed wording, directly
to Google using your Gemini API key. The request includes only the details that
are relevant to the requested transcription pass.

When more than one AI listen uses the same immutable audio range, Studio may reuse
the same Gemini Files API upload instead of uploading duplicate copies of that
range. This reduces repeated transfer but does not change the category of data sent
to Google. Model/context/guidance settings are still resolved for each requested
listen, and a new user-requested Alternative/Deep Verify pass remains a new model
request rather than a cached old answer.

If an interrupted processing job is resumed, Studio may reuse a completed Gemini
candidate saved locally for that **same job ID** when its audio, context, guidance,
model settings, API-key fingerprint, vocabulary mode, and thinking configuration
still match. Fresh jobs do not inherit those AI candidate checkpoints.

Sthang Studio requests `store: false` for Gemini transcription interactions.
This opts out of the Interactions API's default state storage, but it does not
control files uploaded through the separate Gemini Files API.

Studio uploads the normalized WAV through the Gemini Files API and does not
explicitly delete that remote file after processing. Google currently documents
that Files API uploads are stored under provider control for up to 48 hours and
that Files API storage is independent of interaction zero-data-retention
controls. As a result, `store: false` does not make Studio's current Gemini flow
a zero-data-footprint workflow. See Google's
[Files API guide](https://ai.google.dev/gemini-api/docs/files) and
[zero-data-retention guidance](https://ai.google.dev/gemini-api/docs/zdr).
Google's Gemini Developer API terms, quotas, and privacy policies also apply.

Sthang Studio does not use Gemini for final local timing alignment. Timing and
project editing remain on-device after the transcript is returned.

## API keys

On Windows, the preferred in-app setup stores the Gemini API key using
Windows user-protected storage (DPAPI) under `%LOCALAPPDATA%\Sthang Studio`.
The browser receives only a masked representation. An `apps/server/.env`
`GEMINI_API_KEY` remains supported as an advanced fallback and is ignored by
Git.

To avoid repeatedly starting PowerShell/DPAPI for every AI pass, Studio may keep
the already-resolved key and model settings in server process memory for a short
period. The plaintext key is not written to an unencrypted cache or returned to
the browser; in-app Save/Forget actions invalidate that memory cache immediately.

Never commit, paste into issues, or publish a real API key. If a key is exposed,
revoke/rotate it with the provider immediately.

## Downloaded local models

The first local timing setup may download KFA model assets into the user's local
cache. The faster-whisper fallback downloads its selected model when needed.
Those model files are not committed to this repository and remain subject to
their upstream distribution and license terms.

The local timing worker may remain running while Studio is open so the KFA ONNX
session does not need to be loaded for every caption range. faster-whisper remains
lazy and is loaded only when the KFA fallback is actually needed.

## Local project/history storage migration

Current Studio builds may migrate the former monolithic project/history JSON
layout into per-project atomic files to reduce repeated disk I/O. Existing project
data is preserved during migration; the legacy project source/history files are
not silently discarded as part of the migration itself.

## Telemetry

The application does not include a separate Sthang analytics or
telemetry service. Processing-stage timing measurements are stored only as local
job diagnostics; they are not sent to Sthang or another analytics provider.
Network access is used for configured Gemini requests, package/model installation
or download, and any links the user chooses to open.

## Deleting local data

Because projects and caches are local files, removing an installation does not
necessarily remove data stored elsewhere on the same computer (for example the
Windows-protected Gemini key under `%LOCALAPPDATA%`). Use the application's
available delete/forget actions and remove local runtime folders deliberately
when you no longer need them.

For security reporting, see `SECURITY.md`.
