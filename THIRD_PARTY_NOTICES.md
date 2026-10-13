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

The Apple Silicon macOS installer first reuses compatible local runtimes. When
setup needs a managed prerequisite, **Node.js and CPython** are checksum-verified
downloads from their upstream hosts; the **v0.86 managed FFmpeg 8.1.3** contract
instead uses a separate Sthang-hosted GitHub Release with matching complete
corresponding source and license evidence. These are setup-time downloads, not
binaries bundled in the Studio application ZIP. The accepted `v0.85.6` Mac
bootstrap used upstream-hosted FFmpeg under its narrowly approved historical
exception. The maintenance line also provisions app-private CPython on Windows.
No v0.86 FFmpeg binary is represented as publicly available until native binary,
SHA-256, source/license and release verification are complete:

| Component | Setup use | Upstream license / terms |
|---|---|---|
| Node.js 22.23.3 arm64 | JavaScript runtime and npm | MIT for Node.js, with bundled third-party notices in the upstream distribution |
| Node.js 24.21.0 Windows x64 | App-private JavaScript runtime and npm for setup/build/application execution | MIT for Node.js, with bundled third-party notices in the upstream distribution |
| Astral `python-build-standalone` CPython 3.12.15+20261003 arm64 / Windows x64 | Private Python 3.12 runtime used to create Studio's local timing virtual environment | `python-build-standalone` tooling: MPL-2.0; CPython and bundled runtime components retain their upstream licenses |
| `FFmpeg-arm-silicon` 0.5.0 tools archive — historical `v0.85.6` | FFmpeg/ffprobe fallback for local media processing and libass caption rendering | Exact inspected binary reports GPL version 3 or later. The `v0.85.6`-only provenance exception permitted an upstream-hosted, checksum-pinned download without independently reproducible binary-to-source evidence; it does **not** authorize the v0.86 replacement. |
| Sthang source-built FFmpeg 8.1.3 for macOS arm64 — v0.86 release contract, **not yet published** | Managed FFmpeg/ffprobe fallback for local media and ASS subtitles | Combined `--enable-gpl --enable-version3` FFmpeg+x264 executable: GPL-3.0-or-later, with original component licenses, complete corresponding source and independent distribution review required alongside the separately hosted tools. Do not infer an accepted runtime SHA-256 or publication before verified release evidence. |

Every managed archive must have a fixed versioned HTTPS URL and exact SHA-256
digest in `scripts/macos-managed-runtime.sh` or
`scripts/windows-managed-runtime.ps1`. For a public v0.86 Mac package, the FFmpeg
URL and digest must identify the independently verified tools ZIP on the Sthang
Release specified below; setup checks those bytes **before** extraction and
validates both executables and required rendering capabilities before selection.
The release owner adds the actual digest only after matching native and receipt
verification. A source build or committed policy alone is not that evidence.

The accepted `v0.85.6` Mac bootstrap used CPython 3.12.14+20260924. Its acceptance
does not establish native v0.86 runtime acceptance. See
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

The macOS compatibility path has a Monterey/Ventura dependency profile in
`local-timing/constraints-macos-legacy.txt`. It selects older compatible releases of
the existing scientific/audio stack, including the MIT-licensed CTranslate2 and
BSD-licensed PyAV dependencies of faster-whisper. Native packages use upstream
wheels; the pure-Python emoji 2.6.0 dependency is built from its upstream source
distribution. No wheels, model weights or FFmpeg binaries are committed to the
Studio source tree or bundled inside its Mac recovery/OTA packages. The v0.86
managed FFmpeg tools and their complete corresponding source are hosted as
**separate** Sthang GitHub Release assets once approved and published; the setup
installer downloads only the verified tools ZIP when needed. Node.js and CPython
remain upstream-hosted downloads. All selected
managed prerequisites require exact SHA-256 verification before use and stay
under Studio's local application-state folder. See `docs/MACOS-COMPATIBILITY.md`
for the release boundary, exact historical evidence and remaining gates.

The v0.86 Mac release requires native-arm64 `ffmpeg` **and** `ffprobe` reporting
a stable numeric release of **8.1.3 or newer** (a two-component release such as
`8.2` is treated as `8.2.0`); FFmpeg must additionally expose libass complex
shaping and libx264. It can reuse a compatible user-provided build without
demanding Sthang's specific managed-binary hash. Otherwise setup validates or,
when necessary, downloads the exact checksum-pinned v0.86 managed runtime; normal
launch reuses the prepared runtime without downloading. Studio uses the selected
local runtime for audio normalization/range work and, in captioned-video
rendering, for video decoding/encoding, stream mapping, probing, output
verification, and ASS subtitle rendering through FFmpeg's `subtitles`/libass
filter when the installed build exposes it.

FFmpeg licensing depends on the exact build and enabled codecs/components
(commonly LGPL and/or GPL terms). H.264/HEVC encoder availability and licensing
also depend on the exact build and hardware/runtime in use. `libass` is an
ISC-licensed subtitle renderer, but its availability inside FFmpeg still depends
on how that FFmpeg build was configured.

The application probes the installed runtime rather than assuming arbitrary
FFmpeg tools provide these capabilities. Windows runtime selection and its
ordinary-user codec/export acceptance are unchanged by the v0.86 Mac contract.

### v0.86 FFmpeg 8.1.3 corresponding-source and redistribution contract

The **Sthang-hosted** Mac fallback must use the versioned release tag
`runtime-ffmpeg-8.1.3-macos-arm64-r1`, with exact builder output names:

- `Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-tools.zip`
- `Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-corresponding-source.zip`
- `Sthang-Studio-FFmpeg-8.1.3-macOS-arm64.build-receipt.json`

Both ZIPs, their independent `.sha256` files, and the build receipt and its
checksum must be available together on the **same public GitHub Release** before
any binary is distributed. The tools ZIP is designed to carry `ffmpeg`, `ffprobe`,
the license/source README and verbatim runtime license texts; the complete
corresponding-source ZIP must include all **nine hash-locked upstream archives**,
copyright/license notices, exact build scripts, lockfile, patches or no-patches
record, toolchain/compile logs and provenance/receipt. Users must have a clearly
identified, durable source-download route and ability to inspect, modify and
rebuild the LGPL-linked portions; a short-lived Actions artifact or GitHub source
snapshot alone is insufficient. The build receipt must attest the exact binary,
source, runner and toolchain hashes. **These files are release obligations, not
a claim that the native build verification or publication has passed.**

| Component of v0.86 8.1.3 build | Source license / notice obligation |
| --- | --- |
| FFmpeg 8.1.3 with GPL and version3 enabled | Combined executable GPL-3.0-or-later; retain FFmpeg's LGPL/GPL and other file-level texts, source and build configuration |
| x264 (exact pinned VideoLAN commit) | GPL-2.0-or-later, compatible with the chosen GPLv3 build; no separate commercial license is claimed |
| FreeType 2.14.3 | FreeType License alternative (FTL) chosen; retain its required credit and full license text |
| FriBidi 1.0.17, statically linked | LGPL-2.1-or-later; corresponding source, modification/relink rights and any applicable object-file/relink route require review |
| HarfBuzz 14.6.0 | Old MIT plus separately licensed subdirectories, including Microsoft MIT and test-font notices retained in source |
| libass 0.17.5 and pkgconf 2.5.1 | ISC; retain notices |
| Meson 1.9.1 and Ninja 1.13.2 build tools | Apache-2.0; retain source licenses and applicable notices |

FFmpeg upstream also identifies Independent JPEG Group attribution for certain
JPEG-derived source files; the tools README carries that credit. The build must
have no `--enable-nonfree`, OpenSSL or libfdk-aac linkage. Apple-provided
SDK/framework libraries and system zlib are build/runtime system inputs, **not**
redistributed as new archives. Neither GPL compliance nor the source lock asserts
H.264 patent clearance, Apple notarization or legal approval. Sthang Studio's
own MIT license does **not** replace the GPL terms applying to the separate
FFmpeg+x264 executable. See
[`config/macos-ffmpeg-build-lock.json`](config/macos-ffmpeg-build-lock.json) and
[`docs/MACOS-FFMPEG-PROVENANCE.md`](docs/MACOS-FFMPEG-PROVENANCE.md) for the
exact source inventory and checks; native binary inspection, license/distribution
review, public asset/source verification and separate release approval remain gates.

For the historical `0.85.6` Public Beta, the owner explicitly approved a narrow
exception to Studio's strict binary-to-source provenance standard for the exact
upstream `FFmpeg-arm-silicon`
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
