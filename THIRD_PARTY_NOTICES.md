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

The unreleased v0.8 optional product-analytics implementation adds no PostHog
browser/runtime SDK. Studio sends its narrow analytics payload only to the
Sthang-owned analytics relay; that relay uses its Worker-held project ingestion
key to forward accepted events to PostHog. No PostHog npm dependency, browser
autocapture, or session-replay library is introduced by this architecture.

The unreleased Sthang contribution and analytics relay Workers use Cloudflare's
Worker/D1/R2 capabilities directly and add no Studio application npm runtime
dependency.

## Managed prerequisite runtimes

The Apple Silicon macOS installer may download prerequisite runtimes at setup time
when an already-compatible local installation is unavailable. Sthang does not
bundle or rehost these archives. The source maintenance candidate also provisions
app-private CPython on Windows. The source download pins below are checksum
verified; the new Python candidate still requires native release acceptance:

| Component | Setup use | Upstream license / terms |
|---|---|---|
| Node.js 22.23.3 arm64 | JavaScript runtime and npm | MIT for Node.js, with bundled third-party notices in the upstream distribution |
| Node.js 24.21.0 Windows x64 | App-private JavaScript runtime and npm for setup/build/application execution | MIT for Node.js, with bundled third-party notices in the upstream distribution |
| Astral `python-build-standalone` CPython 3.12.15+20261003 arm64 / Windows x64 | Private Python 3.12 runtime used to create Studio's local timing virtual environment | `python-build-standalone` tooling: MPL-2.0; CPython and bundled runtime components retain their upstream licenses |
| `FFmpeg-arm-silicon` 0.5.0 tools archive | FFmpeg/ffprobe fallback for local media processing and libass caption rendering | Exact inspected binary reports GPL version 3 or later. For v0.85.6, the owner approved a documented provenance exception: Sthang downloads the exact checksum-pinned upstream asset directly and does not bundle or rehost it, while the upstream binary-to-source chain is not independently reproducible to Sthang's stricter internal provenance standard. |

Each managed archive is addressed by a fixed versioned HTTPS URL and exact SHA-256
digest in `scripts/macos-managed-runtime.sh` or `scripts/windows-managed-runtime.ps1`. The installer validates the expected
native architecture and required runtime capabilities before selecting it.

The accepted `v0.85.6` Mac bootstrap used CPython 3.12.14+20260924. Its acceptance
does not validate the new source candidate automatically. See
`docs/DEPENDENCY-RUNTIME-MAINTENANCE.md` for exact hashes and remaining gates.

## Python / local timing

| Component | Use | Upstream license |
|---|---|---|
| KFA (`kfa`) | Khmer forced alignment | Apache-2.0 |
| NumPy | Numerical runtime dependency | BSD-3-Clause |
| `sosap` | KFA dependency | MIT |
| `khmercut` | Khmer word segmentation | Apache-2.0 |
| `khmernormalizer` | Khmer text normalization | Apache-2.0 |
| `chardet` | Encoding detection required by KFA | LGPL-2.1-or-later for the pinned 5.x line |
| ONNX Runtime | Local model inference | MIT |
| librosa | Audio loading/processing | ISC |
| SciPy | Numerical/audio dependency | BSD-style |
| tqdm | Progress utility | MPL-2.0 AND MIT |
| Requests | HTTP dependency | Apache-2.0 |
| appdirs | Local cache paths | MIT |
| faster-whisper | Local timing fallback | MIT |

The source maintenance profile pins full platform-specific Python graphs and
artifact hashes under `local-timing/locks/`; the downloaded upstream distributions
retain their license files. ONNX Runtime's supported telemetry opt-outs are applied
before initialization, including startup environment flags. No telemetry-enabled
service or new data-transfer category is authorized by updating a dependency.

Studio's `local-timing/worker.py` adapts portions of KFA 0.2.0's Apache-2.0
`forced_alignment.py` acoustic-emission and transcript-alignment flow so the
transcript-independent ONNX emissions can be cached and reused. The adaptation
keeps KFA's alignment math and KFA remains the timing authority; this repository
does not relicense that adapted KFA-derived portion under more restrictive
terms.

## FFmpeg and subtitle rendering

The macOS source compatibility path has a Monterey/Ventura dependency profile in
`local-timing/constraints-macos-legacy.txt`. It selects older compatible releases of
the existing scientific/audio stack, including the MIT-licensed CTranslate2 and
BSD-licensed PyAV dependencies of faster-whisper. Native packages use upstream
wheels; the pure-Python emoji 2.6.0 dependency is built from its upstream source
distribution. No wheels, model weights or FFmpeg binaries are committed or
redistributed by this source change. On Apple Silicon macOS, setup may download
pinned Node.js, CPython and FFmpeg prerequisite archives directly from their
upstream hosts when a compatible local runtime is unavailable. Each managed
prerequisite is verified by an exact SHA-256 digest before use and stays under
Studio's local application-state folder. See `docs/MACOS-COMPATIBILITY.md` for the
version boundary, exact release evidence and validation requirements.

Sthang Studio prefers an already compatible local `ffmpeg`/`ffprobe` and does not
commit or rehost FFmpeg binaries in this repository. The macOS installer can fall
back to a checksum-pinned upstream Apple Silicon runtime downloaded at setup time.
Studio uses the selected local runtime
for audio normalization/range work and, in the captioned-video source
implementation, for video decoding/encoding, stream mapping, probing, output
verification, and ASS subtitle rendering through FFmpeg's `subtitles`/libass
filter when the installed build exposes it.

FFmpeg licensing depends on the exact build and enabled codecs/components
(commonly LGPL and/or GPL terms). H.264/HEVC encoder availability and licensing
also depend on the exact build and hardware/runtime in use. `libass` is an
ISC-licensed subtitle renderer, but its availability inside FFmpeg still depends
on how that FFmpeg build was configured.

The application therefore probes the installed runtime rather than assuming that
an arbitrary `ffmpeg.exe` provides libass, H.264, HEVC, or hardware encoders. The
captioned-video feature does not add or vendor a new FFmpeg/libass binary in this
source change. Before a public release claims finished-video export, Sthang must
review and validate the exact ordinary-user Windows FFmpeg path/build and any
redistribution/licensing implications of the release package.

Anyone redistributing or rehosting an installer that conveys FFmpeg must review the
license of that exact build separately. Sthang's managed macOS approach downloads
the selected upstream archive at install time and invokes it as a separate process;
Sthang does not bundle or rehost that binary. A development or system-installed
FFmpeg capability is not evidence that the managed public path has the same
codec/filter configuration or sufficient upstream source provenance.

For the `0.85.6` Public Beta, the owner explicitly approved a narrow exception to
that internal provenance standard for the exact upstream `FFmpeg-arm-silicon`
0.5.0 asset pinned in `scripts/macos-managed-runtime.sh`. The upstream release and
Sthang pin agree on SHA-256
`7262b3ff400c0e88235647d99ab79067010694f059c4aa8af0bb0c43a951b2fc`, and the
accepted real-Mac bootstrap validated those exact downloaded bytes. The exception
does not assert reproducible binary provenance: the tagged upstream build scripts
still contain floating dependency refs, so a future runtime replacement must close
that provenance gap rather than treating this exception as precedent.

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

The unreleased v0.8 source can optionally send a narrow allow-listed set of
product analytics events to the Sthang-controlled `analytics.sthang.app` relay
after explicit user opt-in and production configuration. The relay revalidates
the payload and forwards accepted events to Sthang's configured PostHog EU
project. PostHog's service/privacy terms apply to data processed by that service.
Studio does not include the PostHog browser SDK, session replay, or autocapture.
Cloudflare's applicable service/data-processing terms also govern Sthang's use of
the relay infrastructure.

The Khmer Caption Contributor production service is Sthang-operated
infrastructure implemented on Cloudflare Workers, private R2, and D1.
Cloudflare's applicable service/data-processing terms govern Sthang's use of that
infrastructure. The Contributor program's user-facing data contract, retention,
and withdrawal rules are defined by Sthang Studio's `PRIVACY.md` and
`docs/KHMER-CAPTION-CONTRIBUTOR.md`, not by the software license.

The contribution service and analytics relay have been provisioned and passed
synthetic production validation under separate approval. That provisioning does
not make the unreleased v0.8 privacy choices part of the verified public Beta;
public release, OTA promotion, and portfolio synchronization remain separately
gated.

When adding or changing a dependency or hosted service, update this notice when
the change affects a direct runtime dependency, redistributed binary, downloaded
model, or other material licensing/data-processing obligation.
