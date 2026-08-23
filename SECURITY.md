# Security policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability, leaked
credential, or report that contains private media/project data.

Prefer GitHub's private vulnerability reporting / Security Advisory flow when it
is enabled for this repository. If that option is not available, contact Sthang
using the private contact method published on https://sthang.com/ and include
`Sthang-Co-Ltd/Sthang-Studio` in the subject or first line.

A useful report includes:

- affected version, branch, or commit;
- operating system and relevant setup details;
- a minimal reproduction that does not expose other people's data;
- expected versus observed behavior;
- likely impact, if known.

Never send a real Gemini API key as part of a report. If a credential may have
been exposed, revoke/rotate it first and report only a redacted value.

## Security-sensitive areas

Extra care is welcome around:

- local API origin/binding and request validation;
- file upload, media replacement, and path handling;
- API-key storage/redaction;
- project/history/cache isolation;
- command/process execution for FFmpeg and local timing;
- dependency and model-download supply chain behavior.

## Supported versions

Security fixes target the latest accepted `main` branch and the most recent
published release. Older development ZIPs and historical builds are not treated
as supported releases.

## Public bug reports

Ordinary reproducible bugs that do not expose credentials, private media, or a
security weakness should be filed through the normal GitHub issue template.
