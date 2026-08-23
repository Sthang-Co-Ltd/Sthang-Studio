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

## Python / local timing

| Component | Use | Upstream license |
|---|---|---|
| KFA (`kfa`) | Khmer forced alignment | Apache-2.0 |
| `sosap` | KFA dependency | MIT |
| `khmercut` | Khmer word segmentation | Apache-2.0 |
| `khmernormalizer` | Khmer text normalization | MIT |
| ONNX Runtime | Local model inference | MIT |
| librosa | Audio loading/processing | ISC |
| SciPy | Numerical/audio dependency | BSD-style |
| tqdm | Progress utility | MPL-2.0 AND MIT |
| Requests | HTTP dependency | Apache-2.0 |
| appdirs | Local cache paths | MIT |
| faster-whisper | Local timing fallback | MIT |
| chardet (when installed by/for KFA) | Encoding detection | version-dependent; KFA-era 5.x is LGPL-2.1+ |

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

## Service terms

Using Gemini also requires accepting the applicable Google Gemini Developer API
terms and privacy/data-handling terms. The open-source license for Sthang Studio
does not grant access to, or modify the terms of, third-party hosted services.

When adding or changing a dependency, update this notice when the change affects
a direct runtime dependency, redistributed binary, downloaded model, or other
material licensing obligation.
