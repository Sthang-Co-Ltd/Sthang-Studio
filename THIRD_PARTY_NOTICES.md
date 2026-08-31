# Third-party notices

Sthang Studio is built with open-source libraries and optional/runtime-downloaded
models. The upstream license files and package metadata are authoritative. This
summary is provided to make the major direct dependencies easy to audit; it is
not a replacement for their license texts or an exhaustive list of transitive
dependencies.

## JavaScript / TypeScript

| Component | Use | Upstream license |
|---|---|---|
| `@google/genai` | Gemini Developer API client | Apache-2.0 |
| React / React DOM | Web UI | MIT |
| Express | Local HTTP API | MIT |
| `cors` | Local browser-origin middleware | MIT |
| Multer | Local upload handling | MIT |
| Nano ID | Local identifiers | MIT |
| `dotenv` | Optional local environment configuration | BSD-2-Clause |
| Lucide / `lucide-react` | UI icons | ISC |
| Vite | Web development/build tooling | MIT |
| TypeScript | Type checking/build tooling | Apache-2.0 |

The unreleased v0.8 optional product-analytics implementation deliberately uses
Node's built-in `fetch` against PostHog's ingestion API rather than adding the
PostHog browser/runtime SDK. No new PostHog npm dependency, browser autocapture,
or session-replay library is introduced by that source architecture.

The unreleased Sthang contribution Worker uses Cloudflare's Worker/D1/R2 runtime
APIs directly and likewise adds no application npm runtime dependency.

## Python / local timing

| Component | Use | Upstream license |
|---|---|---|
| KFA (`kfa`) | Khmer forced alignment | Apache-2.0 |
| NumPy | Numerical runtime dependency | BSD-3-Clause |
| `sosap` | KFA dependency | MIT |
| `khmercut` | Khmer word segmentation | Apache-2.0 |
| `khmernormalizer` | Khmer text normalization | MIT |
| `chardet` | Encoding detection required by KFA | LGPL-2.1-or-later for the pinned 5.x line |
| ONNX Runtime | Local model inference | MIT |
| librosa | Audio loading/processing | ISC |
| SciPy | Numerical/audio dependency | BSD-style |
| tqdm | Progress utility | MPL-2.0 AND MIT |
| Requests | HTTP dependency | Apache-2.0 |
| appdirs | Local cache paths | MIT |
| faster-whisper | Local timing fallback | MIT |

Studio's `local-timing/worker.py` adapts portions of KFA 0.2.0's Apache-2.0
`forced_alignment.py` acoustic-emission and transcript-alignment flow so the
transcript-independent ONNX emissions can be cached and reused. The adaptation
keeps KFA's alignment math and KFA remains the timing authority; this repository
does not relicense that adapted KFA-derived portion under more restrictive
terms.

## FFmpeg

Sthang Studio expects `ffmpeg`/`ffprobe` to be installed on the user's system and
does not commit FFmpeg binaries to this repository. FFmpeg licensing depends on
the specific build and enabled codecs (commonly LGPL and/or GPL terms). Anyone
redistributing an installer that bundles FFmpeg must review the license of that
exact build separately.

## Runtime-downloaded model assets

Sthang Studio does not commit KFA or faster-whisper model weights to this
repository.

- KFA downloads/caches its Khmer ONNX model through the upstream KFA package.
- faster-whisper downloads the configured Whisper/CTranslate2 model when the
  fallback is first needed.

Those files remain subject to the license and distribution terms published by
the upstream package/model host. Do not vendor model weights into Sthang Studio
without a separate license review and attribution update.

## Hosted-service terms

Using Gemini requires accepting the applicable Google Gemini Developer API terms
and privacy/data-handling terms. The open-source license for Sthang Studio does
not grant access to, or modify the terms of, third-party hosted services.

The unreleased v0.8 source can optionally send an allow-listed set of product
analytics events to PostHog after explicit user opt-in and production project
configuration. PostHog's service/privacy terms apply to data processed by that
service. Studio does not include the PostHog browser SDK, session replay, or
autocapture in this architecture.

The planned Khmer Caption Contributor service is Sthang-operated infrastructure
implemented on Cloudflare Workers, private R2, and D1. Cloudflare's applicable
service/data-processing terms govern Sthang's use of that infrastructure. The
Contributor program's user-facing data contract, retention, and withdrawal rules
are defined by Sthang Studio's `PRIVACY.md` and
`docs/KHMER-CAPTION-CONTRIBUTOR.md`, not by the software license.

Neither PostHog analytics nor the Contributor service is established as publicly
enabled merely because the unreleased source contains integration code. Their
production provisioning/release remains separately gated.

When adding or changing a dependency or hosted service, update this notice when
the change affects a direct runtime dependency, redistributed binary, downloaded
model, or other material licensing/data-processing obligation.
