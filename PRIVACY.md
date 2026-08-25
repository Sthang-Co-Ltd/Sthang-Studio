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

The application requests `store: false` for Gemini transcription interactions.
Google's own Gemini Developer API terms, data handling, retention, quotas, and
privacy policies still apply to that service.

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
