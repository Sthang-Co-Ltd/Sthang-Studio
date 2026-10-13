# Apple Silicon macOS compatibility and public Beta package

## v0.86 Apple Silicon runtime requirements and release boundary

The **v0.86** Mac runtime contract retains **macOS 12.3 or newer on native
Apple Silicon arm64**. It requires **Node 22.23.3+ within 22.x**, or **Node
24.21.0+ within 24.x on macOS 13.5+**, and **Python 3.12.15+ within 3.12**.
The reviewed managed CPython archive is Astral 3.12.15+20261003. These rules
apply to a verified v0.86 installation, not retroactively to the accepted public
`v0.85.6` package.

The v0.86 runtime requires **both `ffmpeg` and `ffprobe` 8.1.3 or newer**,
as native arm64 executables; FFmpeg must expose libass complex subtitle shaping
and libx264.
Stable two-component release identifiers (for example `8.2` or `9.0`) are treated
as `8.2.0`/`9.0.0`; `8.1`, nightly, unparseable or older tools fail validation.
A compatible user-provided FFmpeg/ffprobe installation is accepted without
requiring Sthang's managed-binary hash. Otherwise, setup uses the v0.86 managed
FFmpeg 8.1.3 fallback from a **fixed, checksum-verified Sthang GitHub Release
URL**; the launcher only reuses a runtime prepared at setup. Release packages
must include that exact reviewed URL/SHA-256 contract and must fail closed if the
verified managed asset or required capabilities are unavailable. The ordinary
installer does **not** compile FFmpeg, install Homebrew, or invoke `sudo`.

The managed FFmpeg is built from nine exactly pinned upstream archives and,
subject to successful build verification, licensing review and publication,
distributed separately from Studio's app ZIP under the GitHub Release tag
`runtime-ffmpeg-8.1.3-macos-arm64-r1`. The exact builder output names are
`Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-tools.zip` and
`Sthang-Studio-FFmpeg-8.1.3-macOS-arm64-corresponding-source.zip`, with their
`.sha256` sidecars and the accompanying
`Sthang-Studio-FFmpeg-8.1.3-macOS-arm64.build-receipt.json` and checksum.
The tools ZIP carries both binaries and license/source directions. The complete
corresponding-source ZIP carries all nine original source archives, build scripts,
lock, logs, license texts and provenance. The combined FFmpeg+x264 binary is
GPL-3.0-or-later; its source publication obligations are distinct from the MIT
license for Studio's application source. GPL distribution does not assert H.264
patent clearance or Apple notarization.

The prerequisite runtime passed native build and independent artifact review and
is published with its complete corresponding source and checksum receipt. Exact
hashes and the build run are recorded in [v0.86 release evidence](V086-RELEASE.md).
Native Studio installation/upgrade/rollback and signed public OTA verification
are separate application release gates. See
[`MACOS-FFMPEG-PROVENANCE.md`](MACOS-FFMPEG-PROVENANCE.md) for the build-source
review and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for the
GPL/runtime and corresponding-source publication obligations.

Monterey/Ventura and macOS 14+ now use separate exact version/hash locks. Native
source builds of **Python timing dependencies on user Macs** remain prohibited
except for the documented pure-Python emoji source package; the separate
maintainer-controlled FFmpeg provenance build is not a timing-wheel exception.
Reviewed timing environments live at stable private paths
outside the relocatable OTA source tree; `.venv` selects one only after validation
and preserves the old environment for rollback. Telemetry opt-outs are applied
before ONNX/model-library initialization. The Safari 17 build target is unchanged.

Native v0.86 installation, inference, interruption/rollback and network acceptance
are required before publication. The historical release evidence and FFmpeg
exception below apply only to their stated versions. See
[Reviewed dependency and runtime maintenance](DEPENDENCY-RUNTIME-MAINTENANCE.md)
for the inventory and release gates.

## Historical v0.85.0 target and release boundary

The `v0.85.0` public Beta targets **macOS 12.3 Monterey or newer, native arm64**.
The prior source gate was macOS 14, not 15. All three runtime entrypoints use
`scripts/macos-common.sh`; neither installation nor launch may independently
raise or lower that floor. The shell code stays within Apple's Bash 3.2 syntax.

The public GitHub Release now includes a curated Apple Silicon ZIP with a
double-click `Install Sthang Studio.command` entrypoint. It is a command-based
Beta installer, not a signed/notarized `.app` or `.dmg`, and it does not implement
the Windows signed OTA updater. The compatibility target is backed by local policy,
wheel/deployment-target inspection, and package validation; it is not a claim that
every supported macOS/hardware combination has completed native acceptance.
Intel and Rosetta execution are rejected rather than mixing x64 and arm64 Python
extensions.

| macOS | Node runtime | Python timing profile | Dependency provisioning |
| --- | --- | --- | --- |
| 11 Big Sur and older; Monterey 12.0–12.2 | Rejected | No claimed compatible native stack | Not supported by this implementation |
| 12.3+ Monterey | Node 22.12+ within 22.x | Python 3.12 + `constraints-macos-legacy.txt` | Existing compatible runtime first; otherwise checksum-verified Studio-managed arm64 fallback |
| 13.0–13.4 Ventura | Node 22.12+ within 22.x | Python 3.12 + legacy profile | Existing compatible runtime first; otherwise checksum-verified Studio-managed arm64 fallback |
| 13.5+ Ventura | Node 22.12+ within 22.x, or compatible Node 24+ | Python 3.12 + legacy profile | Existing compatible runtime first; otherwise checksum-verified Studio-managed arm64 fallback |
| 14 Sonoma | Node 22.12+ within 22.x, or compatible Node 24+ | Python 3.12, normal macOS requirements | Existing compatible runtime first; otherwise checksum-verified Studio-managed arm64 fallback |
| 15+ | Node 22.12+ within 22.x, or compatible Node 24+ | Python 3.12, normal macOS requirements | Existing compatible runtime first; otherwise checksum-verified Studio-managed arm64 fallback |

The table records the historical `v0.85.0` boundary, not the tightened v0.86
Node/Python/FFmpeg security-patch requirements above. Both generations retain
the **macOS 12.3** native-arm64 floor and **Safari 17** build target.

Use a maintained browser that still supports your OS. The production syntax/CSS
target includes Safari 17; Monterey's original Safari 15 is not the browser
target. A current Firefox build supporting Monterey is another option. Browser
support, media codec support, and OS security support are separate from Studio's
version gate; a lower app minimum does not restore vendor security updates.

## Why Monterey, rather than changing one number to Big Sur?

Node 24's official macOS binary floor is 13.5. Node 22 targets macOS 11 and meets
the locked Vite/Rolldown requirement starting at 22.12.0, so the JavaScript runtime
is not a reason to require Sonoma or Sequoia. Windows still installs Node 24;
only the root engine declaration and matching lock metadata are broadened.

The scientific native stack is the next boundary. ONNX Runtime 1.20+ publishes
macOS 13+ wheels; 1.19.2 provides the required Python 3.12 universal2 wheel with
a macOS 11 target. SciPy 1.15.3 and scikit-learn 1.5.2 provide Python 3.12 arm64
wheels tagged macOS 12, and PyAV 14.2.0 provides the macOS 12 arm64 wheel.
However, inspecting SciPy's actual arm64 Mach-O load commands reveals a **12.3**
deployment target. The same hidden 12.3 minimum appears in inspected SciPy
1.14.1, 1.13.1 and 1.11.4 Python 3.12 wheels. This is why the entrypoint checks
the minor version and does not advertise 12.0 solely from the wheel filename.
Older SciPy 1.10.1 Python 3.11 arm64 wheels also target macOS 12: simply changing
Python versions does not establish a Big Sur installation.

`constraints-macos-legacy.txt` constrains the combined KFA/Whisper installation
on Monterey and Ventura, the two newly supported OS generations. It constrains
the other inspected native transitive wheels too, preventing a later dependency
resolution from silently raising the native floor. macOS 14+ retains the original
ONNX 1.20+ requirement and is not forced onto those legacy versions, and
the Windows timing files are unchanged. These are compatibility pins, not a
claim that old libraries receive indefinite security fixes.

Native packages must install from wheels. The sole source-package exception is
the pure-Python `emoji==2.6.0` required by `khmernormalizer==0.0.4`, because that
release has no PyPI wheel; it requires no native compiler. KFA and khmercut remain
separate `--no-deps` wheel installs. Validation accepts only their two exact known
metadata discrepancies (sosap 0.4.3 and python-crfsuite 0.9.11), checks installed
versions, loads the native extensions, smoke-tests Khmer tokenization and opens
the actual Khmer ONNX model on CPU during setup (not normal launch). Whisper
weights are not preloaded. KFA's model/alignment math and one-shot recovery path
are unchanged.

Big Sur could be a separate source-build/custom-distribution investigation, but
would need a reviewed native scientific stack and its own real-Mac evidence.
This change deliberately does not promise it from a relaxed version check.

## Curated v0.85.0 package

The GitHub release asset `Sthang-Studio-macOS-Apple-Silicon-v0.85.0.zip` keeps its
extracted top level to three items: **Install Sthang Studio.command**,
**Read Me.txt**, and **Sthang Studio Files**. The installer copies the application
into `~/Library/Application Support/Sthang Studio/app`, runs the same reviewed
macOS dependency/timing setup used by source builds, preserves an existing advanced
`apps/server/.env` fallback during upgrades, and creates
`~/Applications/Sthang Studio.command` for normal launches. User projects, media,
history, exports, privacy identities, and Keychain credentials remain in the stable
macOS state locations rather than being replaced with the app source. The manual
installer keeps a recoverable previous-app backup while the replacement is being
prepared; a failed setup rolls back immediately, and a later retry recovers a
backup left by an interrupted swap before attempting another replacement. Manual
installers are serialized with the macOS system lock helper, the Applications
launcher is replaced atomically, and a successful swap retires the old backup from
recovery state before deleting it so an interrupted cleanup cannot displace the
newly committed app.

The installer also creates `~/Applications/Sthang Studio.app` with the approved
Studio icon and retains `Sthang Studio.command` beside it as the Terminal recovery
launcher. This Beta still uses a command-based, non-notarized installation; the
Finder bundle is a locally generated launcher wrapper rather than a signed/notarized
native app distribution.

The release ZIP preserves executable permission bits for `.command` and shell
entrypoints. Because the package is not Apple-notarized, Gatekeeper may require a
first-run Control-click → **Open** confirmation on the downloaded installer. Setup
does not silently bypass macOS security controls.

Existing compatible native dependencies are reused. When a prerequisite is missing,
setup downloads a pinned Apple Silicon runtime into the Studio state root, verifies
the exact SHA-256 digest before extraction, validates the native architecture and
runtime capabilities, and exposes it only to Studio's setup/launch process. The
installer does not install Homebrew, invoke `sudo`, change the user's global PATH,
or edit shell startup files.

The curated release carries the already-built server, shared package and web
application output from the accepted release build. Its Mac-side npm step installs
only the server/shared production workspace closure with development dependencies
omitted and lifecycle scripts disabled, and launch serves the production web build
from the local backend origin. Vite, esbuild, tsx and TypeScript remain source/build
tools and are not installed or executed in the ordinary curated macOS runtime.
Source checkouts continue to use the development dependency workflow.

Release packaging rebuilds those production files in a temporary source projection
created from the exact captured Git commit, then performs a fresh development
dependency install from that commit's `package-lock.json`. Ignored/untracked
checkout files (including Vite `.env*` files), stale local `node_modules`, and
stale `dist` output therefore cannot become release build inputs. The
derived-runtime manifest records the exact source commit, source tree and
package-lock SHA-256 plus every generated file's size/hash; the package gate
re-verifies those values from the final ZIP.

Installed curated builds additionally carry the stable `macos-arm64` signed-update
broker. `~/Library/Application Support/Sthang Studio/app` remains the manual
bootstrap/recovery baseline. Verified future versions prepare under
`versions/<version>`; an atomic update pointer selects one only after runtime-only
Node/local-timing preparation succeeds. Exact-version API plus same-origin UI health
must pass after activation or the prior pointer is restored. The updater uses a
platform-specific signed namespace and never enables itself in a normal source
checkout. Its presence does not establish that a public Mac OTA offer exists.

For the published **`v0.85.6` historical Mac bootstrap**, the managed prerequisite
pins were Node.js 22.23.3 from nodejs.org and CPython 3.12.14+20260924 from
Astral's python-build-standalone. That release's managed FFmpeg was the Apple
Silicon `FFmpeg-arm-silicon` 0.5.0 tools
archive, pinned by exact SHA-256 and separately validated for arm64, libass complex
shaping, libx264, GPL/version3 configuration, and absence of nonfree/OpenSSL build
flags. Those historical files were downloaded at setup time from their upstream
projects and were not bundled or rehosted by Sthang Studio. For the `0.85.6` Public
Beta, native-Mac acceptance of the pinned bytes passed and the owner explicitly
approved a narrow exception to the stricter exact-source-provenance requirement.
The exception is limited to the exact upstream 0.5.0 asset and SHA-256 recorded in
`scripts/macos-managed-runtime.sh`; the upstream build still contains floating
x264/LAME source refs, so this is not represented as reproducible binary provenance
and must not silently carry forward to a future FFmpeg replacement.

## Manual/source setup, including older macOS

Use a normal native Terminal session, not one opened with **Open using Rosetta**.
Put the checkout in a stable folder and close an already-running Studio before
repairing its dependencies. These instructions are the recovery/source path when
the curated package cannot provision a required dependency automatically.

Install an official **arm64 Node 22 LTS** distribution and put its `bin` directory
on `PATH` before any incompatible Node installation. Use the latest security
patch of Node 22, not 22.12.0 merely because it is the feature minimum. Verify:

```sh
node -p 'process.versions.node + " " + process.arch'
npm --version
```

For a v0.86 **manual source installation**, use native Python **3.12.15 or newer within 3.12** and
**both FFmpeg and ffprobe 8.1.3 or newer** for arm64, with libass complex shaping
and libx264 available. Compatible newer local builds are accepted; Homebrew is
not mandatory and a custom FFmpeg binary need not match Sthang's future managed
archive checksum. The official Python universal2 distribution or a Python 3.12
package from MacPorts can provide Python. Choose a maintained Python build, not
an old installer solely for convenience.

**Optional advanced/manual setup only:** MacPorts publishes installers for
Monterey and earlier systems. Maintainers who deliberately manage their own
system prerequisites may use the matching MacPorts version and Apple developer
tools; this is **not** part of the ordinary v0.86 installation, which downloads
approved runtimes without Homebrew, source compilation or `sudo`. An advanced
manual route is:

```sh
sudo port install python312 ffmpeg
export PATH="/opt/local/bin:$PATH"
python3.12 -c 'import platform, sys; print(sys.version); print(platform.machine())'
ffmpeg -version
ffmpeg -hide_banner -h filter=ass
ffprobe -version
```

MacPorts installation may build some components and is not performed automatically
by Studio. Check that **both** tools meet the 8.1.3 minimum and that FFmpeg exposes
`shaping` and `complex` and a `libx264` encoder; the command name alone is
insufficient. The source checkout does not embed FFmpeg binaries or model weights
in its Mac application ZIP. The v0.86 managed fallback, when released and
verified, is hosted separately on a Sthang GitHub Release alongside its complete
corresponding source, exact checksums and license notices. Upstream licenses
remain applicable.
Keep the native Node 22 directory ahead of any incompatible Node on `PATH`.

Then run:

```sh
bash ./INSTALL-MACOS.sh
bash ./run-macos.sh
```

The installer reuses compatible PATH dependencies and can rediscover installed
Homebrew `node@22`, `node@24`, Python 3.12 and `ffmpeg-full` locations. If those are
unavailable, the installer uses the verified Studio-managed fallback described
above. It never installs a package manager or invokes `sudo`. The launcher only
selects an already-prepared managed runtime; it does not download prerequisites.

An existing `.venv` must really run native arm64 Python 3.12. An incompatible or
broken environment is rejected without deletion: close Studio, move that `.venv`
aside deliberately, then rerun setup. Projects, media, keys and settings are not
migrated, reset or deleted. State and Keychain behavior remain as documented in
`README.md` and `PRIVACY.md`, including existing state-root/`.env` overrides.

## Local validation and native acceptance

Run on the developer's computer, not a GitHub Actions/Blacksmith runner:

```sh
npm ci --include=dev
npm run test:macos
npm run typecheck
npm run build
npm run check:public
```

`test:macos` uses synthetic shell commands and disposable folders. It tests OS
boundaries, Rosetta/wrong-runtime rejection, clean-machine managed provisioning,
fixed-hash failure, runtime reuse, dependency profile selection, paths with spaces,
non-destructive venv failures, release-install rollback/retry, and metadata checks.
Windows uses Git for Windows Bash; `STHANG_TEST_BASH` can name an explicit Bash
executable. These are policy regressions, not execution on the simulated OS.

### v0.86 FFmpeg selector regression record — October 13, 2026

The `test:macos` suite passed **137 of 137** tests using the reviewed Windows
Node 24.21.0 validation runtime. Its **21 focused FFmpeg cases** covered 8.1.3,
stable `8.2`/`9.0` acceptance, old `8.1`/`ffprobe` rejection, nightly/malformed
versions, simulated managed fallback and newer custom PATH runtimes. These are
Windows-hosted synthetic Bash fixtures, **not** native Apple Silicon evidence,
not verification of a published tools ZIP and not a substitute for the pending
Mac runtime acceptance.

### Implementation validation record — September 16, 2026

The implementation starts from accepted `main` commit
`f409ab823101fa9583e0758be529d9f6dac08a55`. All validation runs use an isolated
worktree on the developer's Windows computer; no hosted runner is used.

- Node 22.23.2 and Node 24.13.0: `npm run ci` passed on each runtime, including
  262 Node tests per run (79 macOS policy
  regressions), typecheck, build, brand verification and public-readiness checks.
  No Node tests were skipped. The macOS suite also runs seven Python verifier
  regressions; timing-cache tests run separately within the same local CI command.
- The final Monterey/Ventura profile resolved successfully for CPython 3.12
  Apple Silicon wheels. Emoji's pure-Python wheel was built locally for the
  cross-platform resolution check, matching the documented source exception.
- Inspected 325 arm64 native binaries from 66 resolved wheel/npm archives,
  including the locked Darwin compiler/bundler binaries. None declares a macOS
  deployment target above 12.3. These checks inspect binary metadata; they do
  not run those binaries on Windows or establish real-Mac compatibility.
- Two test-only portability issues were corrected without changing caption
  behavior: synthetic media replacements now cancel scheduled preparation even
  after committed-error responses, and the QA snapshot test keeps separate
  frozen Unicode 16/17 expectations. Both expectations were checked/generated
  from the same unmodified pre-optimization source at
  `5f9670b98a7783962c0f9b693ae701b58b5f1864`, not from this candidate.

Raw local logs and downloaded validation binaries remain in ignored
`release-artifacts/`; they are not bundled dependencies. The runtime dependency
graph in `package-lock.json` is unchanged apart from the root Node engine
declaration. Windows installation, timing pins, and protected artwork remain
unchanged by the macOS compatibility layer.

The following real-Apple-Silicon acceptance coverage remains useful evidence and
must not be reported as completed unless it is actually run:

- [ ] Clean Monterey install using Node 22 and Python 3.12; repeat setup and
      launch from a fresh Terminal so runtime PATH discovery is exercised.
- [ ] Native imports and actual Khmer alignment through both persistent and
      one-shot workers; exercise the lazy Whisper fallback with consented media.
- [ ] Keychain save/read/forget, source state-root overrides, existing project
      preservation, source replacement, and restart/recovery.
- [ ] Default-browser startup, supported-browser editing/playback/Review,
      Khmer SRT export, native preview and real mixed Khmer/English MP4 rendering.
- [ ] Verify the **exact v0.86 8.1.3 managed archive** against its source
      receipt, SHA-256, runtime license notices and complete corresponding source
      on the same public GitHub Release; ensure the source remains accessible.
      Test old 8.1 rejection, both-tool version checking, compatible newer user
      builds, checksum failure, managed fallback and FFmpeg/ffprobe arm64/libass/
      libx264 capabilities without changing the 12.3 deployment floor.
- [ ] Finder shows `Sthang Studio.app` with the approved icon; double-click launch
      reaches the same stable broker, while `Sthang Studio.command` still works as
      the recovery launcher.
- [ ] From an installed bootstrap, verify the Mac update check is platform-bound
      and source checkouts remain disabled. With a deliberately staged signed test
      release, exercise Download & verify, Install & restart, exact-version health,
      failed preparation, failed health, interrupted activation, pointer rollback,
      fresh-terminal relaunch and preservation of projects/Keychain/.env/tools.
- [ ] Repeat the representative workflow on Ventura, Sonoma and a current macOS;
      verify macOS 14+ dependency resolution was not forced onto old pins, including
      after upgrading a machine from Monterey/Ventura.

Record the exact commit, macOS, chip, Node/Python/package versions, FFmpeg build,
browser version and results. Wheel tags or native deployment-target inspection
alone do not prove that a library loads or captions are correct on that Mac.

## Public impact and maintainer handoff

**Public impact: required.** Version `0.85.0` adds a curated Apple Silicon macOS
GitHub download and changes the public installation/platform contract. Product-owned
evidence is `README.md`, this file, the macOS shell entrypoints and package templates,
the legacy dependency constraints, `PRIVACY.md`, and `.sthang/product-manifest.json`
change ID `studio-v0-85-public-release-20260916`.

HQ/Distribution synchronization must carry the new public version, Apple Silicon
availability and installation limitation into `/studio/` and its documentation.
The Windows direct-download action remains the HQ primary action; the website may
also expose the matching macOS asset from the same verified `v0.85.0` GitHub
Release. Signed OTA availability remains unchanged and must not be inferred from
the Mac package or this release.

The unreleased managed-prerequisite/OTA bootstrap correction also has **Public impact: required**
because it changes first-run network/setup behavior on supported Macs. Public
installation guidance must describe the app-private checksum-verified fallback only
after a provenance-aligned release is accepted. It also adds a Finder launcher and
an installed Mac signed-update bootstrap, but does not make a public Mac OTA offer
without separately promoted signed release evidence. It does not change the
platform floor or caption/media cloud processing. The corresponding
source evidence is `scripts/macos-managed-runtime.sh`, `INSTALL-MACOS.sh`,
`scripts/update-runtime.mjs`, the Mac trust/OTA packaging and signer files,
`README.md`, `PRIVACY.md`, `THIRD_PARTY_NOTICES.md`, and the macOS release package
tests. For `0.85.6`, the exact pinned managed FFmpeg fallback is accepted only under
the owner-approved provenance exception recorded above; future FFmpeg replacements
must close that provenance gap. Mac OTA availability remains separately gated until
a later signed release completes the required native upgrade/rollback acceptance and
latest-pointer promotion.

The **v0.86 FFmpeg 8.1.3 release contract** additionally requires truthful
public GPL and corresponding-source notices, exact binary/source/receipt hashes,
real native compatibility evidence, a separately reviewed managed download pin,
and consent-independent setup-network disclosure. Neither an Actions artifact
nor this source documentation establishes public availability. The accepted
`v0.85.6` exception cannot be reused. Prime/maintainers separately own the
release publication, product manifest, HQ intake and Distribution `/studio/` sync.

## Upstream compatibility evidence

- [Node 22 build/platform requirements](https://github.com/nodejs/node/blob/v22.x/BUILDING.md)
- [Node 24 build/platform requirements](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
- [Node LTS lifecycle](https://nodejs.org/en/about/previous-releases)
- [Node.js 22.23.3 distribution directory](https://nodejs.org/dist/v22.23.3/)
- [python-build-standalone releases](https://github.com/astral-sh/python-build-standalone/releases)
- [FFmpeg-arm-silicon 0.5.0 release](https://github.com/kiimelon/FFmpeg-arm-silicon/releases/tag/0.5.0)
- [FFmpeg 8.1.3 upstream source archive](https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz)
- [FFmpeg licensing and redistribution guidance](https://ffmpeg.org/legal.html)
- [ONNX Runtime 1.19.2 wheels](https://pypi.org/project/onnxruntime/1.19.2/#files)
- [SciPy 1.15.3 wheels](https://pypi.org/project/scipy/1.15.3/#files)
- [SciPy 1.10.1 wheels](https://pypi.org/project/scipy/1.10.1/#files)
- [PyAV 14.2.0 wheels](https://pypi.org/project/av/14.2.0/#files)
- [Homebrew installation/support requirements](https://docs.brew.sh/Installation)
- [MacPorts legacy installers](https://www.macports.org/install.php)
- [MacPorts Python 3.12](https://ports.macports.org/port/python312/)
- [MacPorts FFmpeg](https://ports.macports.org/port/ffmpeg/)
- [Firefox macOS requirements](https://www.firefox.com/firefox/155.0.1/system-requirements/)
