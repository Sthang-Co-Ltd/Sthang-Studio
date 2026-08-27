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
- caption projects and edits;
- correction memory and profile data;
- project history, proposals, processing-job metadata, and caches;
- SRT exports;
- local timing/alignment using KFA, with faster-whisper as a local fallback.

Runtime data lives under the installation's local directories and is excluded
from Git by `.gitignore`.

## What is sent to Gemini

When you generate or regenerate AI caption wording, Sthang Studio sends the
normalized WAV audio needed for that operation, plus relevant topic context,
protected vocabulary, accuracy hints, and accepted or proposed wording, directly
to Google using your Gemini API key. The request includes only the details that
are relevant to the requested transcription pass.

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

Never commit, paste into issues, or publish a real API key. If a key is exposed,
revoke/rotate it with the provider immediately.

## Downloaded local models

The first local timing setup may download KFA model assets into the user's local
cache. The faster-whisper fallback downloads its selected model when needed.
Those model files are not committed to this repository and remain subject to
their upstream distribution and license terms.

## Telemetry

The application does not include a separate Sthang analytics or
telemetry service. Network access is used for configured Gemini requests,
package/model installation or download, and any links the user chooses to open.

## Deleting local data

Because projects and caches are local files, removing an installation does not
necessarily remove data stored elsewhere on the same computer (for example the
Windows-protected Gemini key under `%LOCALAPPDATA%`). Use the application's
available delete/forget actions and remove local runtime folders deliberately
when you no longer need them.

For security reporting, see `SECURITY.md`.
