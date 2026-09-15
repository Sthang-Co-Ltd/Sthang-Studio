# Apple Silicon macOS source compatibility

## Target and release boundary

The source beta targets **macOS 12.3 Monterey or newer, native arm64**. The prior
source gate was macOS 14, not 15. All three entrypoints now use
`scripts/macos-common.sh`; neither installation nor launch may independently
raise or lower that floor. The shell code stays within Apple's Bash 3.2 syntax.

This change is not a public Mac installer, notarized app, or native-Mac acceptance
record. Public curated downloads and the signed updater remain Windows-only.
The source may be tested on any Apple Silicon generation without a chip-name
allow-list, but a new Mac can only boot macOS versions supported by that hardware.
Intel and Rosetta execution are rejected rather than mixing x64 and arm64 Python
extensions. Do not interpret future version-number acceptance as future hardware
or OS certification.

| macOS | Node runtime | Python timing profile | Dependency provisioning |
| --- | --- | --- | --- |
| 11 Big Sur and older; Monterey 12.0–12.2 | Rejected | No claimed compatible native stack | Not supported by this implementation |
| 12.3+ Monterey | Latest patched Node 22.x, at least 22.12.0 | Python 3.12 + `constraints-macos-legacy.txt` | Existing/manual dependencies; no automatic Homebrew installation |
| 13.0–13.4 Ventura | Latest patched Node 22.x, at least 22.12.0 | Python 3.12 + legacy profile | Existing/manual dependencies |
| 13.5+ Ventura | Node 22.12+ within 22.x, or compatible Node 24+ | Python 3.12 + legacy profile | Existing/manual dependencies |
| 14 Sonoma | Node 22.12+ within 22.x, or compatible Node 24+ | Python 3.12, normal macOS requirements | Existing/manual dependencies |
| 15+ | Node 22.12+ within 22.x, or compatible Node 24+ | Python 3.12, normal macOS requirements | Existing dependencies first; optional existing Homebrew |

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

## Manual setup, including older macOS

Use a normal native Terminal session, not one opened with **Open using Rosetta**.
Put the checkout in a stable folder and close an already-running Studio before
repairing its dependencies. These are contributor/source instructions, not an
ordinary-user download substitute.

Install an official **arm64 Node 22 LTS** distribution and put its `bin` directory
on `PATH` before any incompatible Node installation. Use the latest security
patch of Node 22, not 22.12.0 merely because it is the feature minimum. Verify:

```sh
node -p 'process.versions.node + " " + process.arch'
npm --version
```

Install native Python 3.12 and FFmpeg/ffprobe built for your OS with libass complex
shaping. Compatible existing installations are accepted; Homebrew is not
mandatory. The official Python universal2 distribution or a Python 3.12 package
from MacPorts can provide Python. Choose a maintained Python build, not an old
installer solely for convenience.

MacPorts publishes installers for Monterey and earlier systems. After installing
the matching MacPorts version and its required Apple developer tools, a manual
dependency route is:

```sh
sudo port install python312 ffmpeg
export PATH="/opt/local/bin:$PATH"
python3.12 -c 'import platform, sys; print(sys.version); print(platform.machine())'
ffmpeg -hide_banner -h filter=ass
ffprobe -version
```

MacPorts installation may build some components and is not performed automatically
by Studio. The chosen FFmpeg must actually expose `shaping` and `complex`; the
command name alone is insufficient. No third-party binaries or model weights are
bundled or redistributed in this change. Upstream licenses remain applicable.
Keep the native Node 22 directory ahead of any incompatible Node on `PATH`.

Then run:

```sh
bash ./INSTALL-MACOS.sh
bash ./run-macos.sh
```

The installer reuses compatible PATH dependencies and can rediscover installed
Homebrew `node@22`, `node@24`, Python 3.12 and `ffmpeg-full` locations. Only macOS
15+ attempts installation with an already-installed Homebrew. It never installs
a package manager or invokes `sudo` for you. The launcher never installs anything.

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
boundaries, Rosetta/wrong-runtime rejection, Homebrew policy, dependency profile
selection, paths with spaces, non-destructive venv failures, and metadata checks.
Windows uses Git for Windows Bash; `STHANG_TEST_BASH` can name an explicit Bash
executable. These are policy regressions, not execution on the simulated OS.

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

Raw local logs and downloaded binaries remain in ignored `release-artifacts/`;
they are not release assets. The runtime dependency graph in `package-lock.json`
is unchanged apart from the root Node engine declaration. Windows installation,
timing pins, protected artwork, release assets and workflow files are unchanged.

Before accepting a Mac release, run this checklist on real Apple Silicon:

- [ ] Clean Monterey install using Node 22 and Python 3.12; repeat setup and
      launch from a fresh Terminal so runtime PATH discovery is exercised.
- [ ] Native imports and actual Khmer alignment through both persistent and
      one-shot workers; exercise the lazy Whisper fallback with consented media.
- [ ] Keychain save/read/forget, source state-root overrides, existing project
      preservation, source replacement, and restart/recovery.
- [ ] Default-browser startup, supported-browser editing/playback/Review,
      Khmer SRT export, native preview and real mixed Khmer/English MP4 rendering.
- [ ] Repeat the representative workflow on Ventura, Sonoma and a current macOS;
      verify macOS 14+ dependency resolution was not forced onto old pins, including
      after upgrading a machine from Monterey/Ventura.

Record the exact commit, macOS, chip, Node/Python/package versions, FFmpeg build,
browser version and results. Wheel tags or native deployment-target inspection
alone do not prove that a library loads or captions are correct on that Mac.

## Public impact and maintainer handoff

**Public impact: required.** The source minimum, runtime prerequisites, browser
requirements and legacy installation instructions change. Product-owned evidence
is `README.md`, this file, the three shell entrypoints, the legacy constraints,
and `.sthang/product-manifest.json` change ID
`studio-macos-monterey-compatibility-20260916`.

Proposed HQ intake: source platform/installation/limitation fields, with native
Mac acceptance explicitly pending. Proposed Distribution follow-up: `/studio/`
system requirements and source-install documentation. Keep the Windows download
action, public release version, OTA availability and privacy/provider claims
unchanged. HQ intake and Distribution synchronization each need their own plan
digest and approval; this source change does not authorize cross-repository
writes, a Mac release, a website deployment or an OTA promotion.

## Upstream compatibility evidence

- [Node 22 build/platform requirements](https://github.com/nodejs/node/blob/v22.x/BUILDING.md)
- [Node 24 build/platform requirements](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
- [Node LTS lifecycle](https://nodejs.org/en/about/previous-releases)
- [ONNX Runtime 1.19.2 wheels](https://pypi.org/project/onnxruntime/1.19.2/#files)
- [SciPy 1.15.3 wheels](https://pypi.org/project/scipy/1.15.3/#files)
- [SciPy 1.10.1 wheels](https://pypi.org/project/scipy/1.10.1/#files)
- [PyAV 14.2.0 wheels](https://pypi.org/project/av/14.2.0/#files)
- [Homebrew installation/support requirements](https://docs.brew.sh/Installation)
- [MacPorts legacy installers](https://www.macports.org/install.php)
- [MacPorts Python 3.12](https://ports.macports.org/port/python312/)
- [MacPorts FFmpeg](https://ports.macports.org/port/ffmpeg/)
- [Firefox macOS requirements](https://www.firefox.com/firefox/155.0.1/system-requirements/)
