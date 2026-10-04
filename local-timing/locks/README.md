# Reviewed local-timing locks

These locks are the public setup inputs for **native 64-bit CPython 3.12**:

- `windows-py312-x64.txt`: Windows x64
- `macos-legacy-py312-arm64.txt`: Apple Silicon macOS 12.3–13
- `macos-modern-py312-arm64.txt`: Apple Silicon macOS 14+
- `tooling.txt`: the same pinned pip, setuptools, wheel and packaging on all profiles

`versions.json` records the complete reviewed version inventory, including
transitive dependencies. `pypi-metadata.json` records official PyPI release
metadata and the selected compatible wheel/source filenames, URLs and SHA256s.
Only compatible CPython 3.12/platform artifacts are allowed by each lock. The
only source distribution allowed is the existing **pure-Python emoji 2.6.0**
exception; native source builds remain prohibited. `manifest.json` authenticates
the four install lock files inside the signed/hashed update package.

## Installation and readiness

Use the platform setup entrypoint. It installs the tooling lock first and then
the selected runtime lock with `--require-hashes --no-deps`. Runtime installation
also uses `--only-binary=:all: --no-binary=emoji --no-build-isolation`, so emoji's
build uses the pinned installed tooling instead of fetching an unreviewed build
environment. Never substitute a floating requirements install for a lock.

`--no-deps` does **not** mean dependency validation is skipped. The complete
graph is independently resolved, checked against official package metadata,
then checked in the installed environment by `check-timing-dependencies.py`.
Readiness requires every locked runtime/tooling version, no extra distributions,
and successful `pip check` or only these exact reviewed upstream exceptions:

- KFA 0.2.0 declares sosap 0.0.1; the reviewed installed version is sosap 0.4.3
- On macOS only, khmercut 0.0.2 declares python-crfsuite 0.9.9; the reviewed
  Apple Silicon wheel is python-crfsuite 0.9.11

Wrong versions, missing packages, unexpected messages, empty output and crashed
`pip check` are fatal. The metadata exceptions are valid only together with the
native import, Khmer tokenizer and KFA model preload/session checks performed by
setup. The dependency checker alone never declares the timing system READY.

## Retained advisory constraints

An official PyPI version-advisory check of all 66 locked package/version pairs on
2026-10-04 found two affected retained pins. This is not a claim that the graph
is vulnerability-free:

- `tqdm==4.65.0`: CVE-2024-34062, fixed in 4.66.3, requires malicious CLI
  arguments. Studio does not invoke the tqdm CLI; khmercut's supported stack
  requires this exact version
- `setuptools==80.10.2`: CVE-2026-59890, fixed in 83.0.0, concerns macOS Unicode
  `MANIFEST.in` exclusions while producing source distributions. Studio does not
  build or publish sdists from user files. The only permitted source build
  converts hash-pinned emoji 2.6.0 to a wheel. New setuptools removes
  `pkg_resources`, still imported by pinned CTranslate2 4.6.0, so a blind upgrade
  is incompatible

Remove either constraint only through a reviewed, clean-platform-compatible
stack migration. Sources: [tqdm advisory](https://github.com/tqdm/tqdm/security/advisories/GHSA-g7vv-2v7x-gj9p)
and [setuptools advisory](https://github.com/pypa/setuptools/security/advisories/GHSA-h35f-9h28-mq5c).

## Update/review workflow

1. Review new versions and their compatibility/privacy/security impact. Keep
   NumPy below 2 and the KFA/tokenizer invariants. Legacy native versions in
   `constraints-macos-legacy.txt` must not drift without native compatibility
   evidence. Inputs in `requirements-*.txt` describe bounded supported ranges;
   installers consume only the exact locks.
2. Resolve for CPython 3.12 and each target (for example with `uv pip compile
   --python-version 3.12 --python-platform windows` or
   `--python-platform aarch64-apple-darwin`, and macOS deployment floor 12.3/14).
   Override only the exact KFA→sosap edge and, on Mac, khmercut→python-crfsuite.
   Review all transitive changes before updating `versions.json`.
3. Run `python scripts/lock-timing-dependencies.py` to fetch official PyPI
   hashes, select target artifacts and validate every active metadata edge.
   It never chooses or upgrades a version. Commit the changed version inventory,
   four locks, integrity manifest and metadata together.
4. Run `python scripts/lock-timing-dependencies.py --check --download-dir PATH`
   to independently re-fetch metadata and verify actual artifact bytes. Run
   `python -I -B -m unittest discover -s tests -p '*timing*_test.py' -v`.
5. Perform fresh setup, already-ready, failed-update preservation and real
   KFA/Whisper import/model/session/alignment tests on Windows x64/Python 3.12,
   macOS 12.3 and 13 arm64, and macOS 14+ arm64. Cross-resolution, artifact tags,
   metadata checks and Linux smoke tests are not native execution evidence.

## Privacy and compatibility decisions

Modern profiles use ONNX Runtime 1.30.0. Official native builds can initialize
telemetry before the Python disable API is available. Every Studio process
must set `ORT_DISABLE_TELEMETRY=1` **before Python/ONNX initialization** and call
`onnxruntime.disable_telemetry_events()` immediately after import, before KFA or
Whisper initialization. Do not replace this with API-only opt-out. Legacy macOS
retains ONNX Runtime 1.19.2. No telemetry service or new data transfer is approved.
See [upstream ONNX privacy documentation](https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md).

Requests is pinned to the patched 2.34.2 release. Modern librosa 0.11.0 and
SciPy 1.17.1 retain NumPy 1.26.4 compatibility; librosa 1.x/SciPy 1.18.x require
NumPy 2 and are intentionally excluded. Known-compatible AV 14.2.0, CTranslate2
4.6.0, Numba 0.61.2, llvmlite 0.44.0, scikit-learn 1.5.2 and other legacy native
pins are retained. Setuptools is retained at 80.10.2 because CTranslate2 4.6.0 imports
`pkg_resources` on Windows; setuptools 81+ removed that API. Hugging Face Hub
remains on the 0.x HTTP/client API. First
setup may download the existing KFA model; faster-whisper model loading remains
lazy and its graph/library import does not imply a model download.
