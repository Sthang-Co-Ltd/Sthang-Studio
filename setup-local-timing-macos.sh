#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/macos-common.sh"
studio_macos_host

if [[ ! -e "$ROOT/.venv" && ! -L "$ROOT/.venv" ]]; then
  studio_macos_select_python || { echo "ERROR: Native arm64 Python 3.12 was not found. Run INSTALL-MACOS.sh first."; exit 1; }
  echo "Creating .venv with native Python 3.12..."
  "$STUDIO_PYTHON" -m venv .venv
fi
studio_macos_require_venv
PYTHON="$ROOT/.venv/bin/python"

# Constrain every install, including Whisper, so its transitive dependencies
# cannot silently raise the floor on either newly supported OS generation.
TIMING_REQUIREMENTS=(-r local-timing/requirements-kfa-macos.txt -r local-timing/requirements-whisper.txt)
if [[ "$STUDIO_MACOS_MAJOR" -lt 14 ]]; then
  TIMING_REQUIREMENTS+=(-c "$ROOT/local-timing/constraints-macos-legacy.txt")
else
  # Preserve the original macOS 14+ ONNX requirement, including after an OS upgrade.
  TIMING_REQUIREMENTS+=("onnxruntime>=1.20,<2.0")
fi

echo "Checking the existing local timing environment..."
if "$PYTHON" "$ROOT/scripts/check-macos-timing.py" --ready >/dev/null 2>&1; then
  echo "Local timing environment is already READY."
  exit 0
fi

echo "Updating pip tooling..."
"$PYTHON" -m pip install --only-binary=:all: --upgrade pip setuptools wheel
echo "Installing Apple Silicon timing dependencies (native wheels)..."
# khmernormalizer pins emoji 2.6.0, published only as pure Python source.
# Permit that exact dependency's source package, never native source builds.
"$PYTHON" -m pip install --only-binary=:all: --no-binary=emoji "${TIMING_REQUIREMENTS[@]}"
"$PYTHON" -m pip install --only-binary=:all: --no-deps "khmercut==0.0.2" "kfa==0.2.0"

echo "Verifying native imports and preloading the Khmer timing model..."
echo "The first setup may download about 360 MB once; the Whisper model stays lazy."
"$PYTHON" "$ROOT/scripts/check-macos-timing.py"
echo "Local timing setup complete."
