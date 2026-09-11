#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This setup is for macOS."
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: The first macOS beta supports Apple Silicon (arm64) only."
  exit 1
fi
MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || true)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
if [[ -z "$MACOS_VERSION" || ! "$MACOS_MAJOR" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Could not determine the macOS version."
  exit 1
fi
if [[ "$MACOS_MAJOR" -lt 14 ]]; then
  echo "ERROR: The first Sthang Studio macOS beta requires macOS 14 Sonoma or newer. Current version: $MACOS_VERSION"
  exit 1
fi
if ! command -v python3.12 >/dev/null 2>&1; then
  echo "ERROR: Python 3.12 was not found. Run INSTALL-MACOS.sh first."
  exit 1
fi

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Creating .venv with Python 3.12..."
  python3.12 -m venv .venv
fi

PYTHON="$ROOT/.venv/bin/python"

echo "Checking the existing local timing environment..."
if "$PYTHON" -c "import importlib.util, os; from appdirs import user_cache_dir; from importlib.metadata import version; model=os.path.join(user_cache_dir(),'kfa','wav2vec2-km-base-1500.onnx'); assert all(importlib.util.find_spec(x) for x in ['kfa','khmercut','faster_whisper','onnxruntime','khmernormalizer']); assert version('khmercut')=='0.0.2'; assert version('python-crfsuite')=='0.9.11'; assert version('tqdm')=='4.65.0'; assert version('sosap')=='0.4.3'; assert os.path.exists(model)" >/dev/null 2>&1; then
  echo "Local timing environment is already READY."
  exit 0
fi

echo "Updating pip tooling..."
"$PYTHON" -m pip install --upgrade pip setuptools wheel

echo "Installing Apple Silicon KFA dependencies..."
"$PYTHON" -m pip install --prefer-binary -r local-timing/requirements-kfa-macos.txt
"$PYTHON" -m pip install --prefer-binary --no-deps "khmercut==0.0.2" "kfa==0.2.0"

echo "Installing local Whisper fallback..."
"$PYTHON" -m pip install --prefer-binary -r local-timing/requirements-whisper.txt

echo "Checking dependency metadata..."
"$PYTHON" -c "import subprocess,sys; p=subprocess.run([sys.executable,'-m','pip','check'],capture_output=True,text=True); lines=[x.strip() for x in (p.stdout+'\n'+p.stderr).splitlines() if x.strip()]; allowed=lambda x: ('kfa 0.2.0 has requirement sosap==0.0.1' in x.lower() and 'sosap 0.4.3' in x.lower()) or ('khmercut 0.0.2 has requirement python-crfsuite==0.9.9' in x.lower() and 'python-crfsuite 0.9.11' in x.lower()); unexpected=[x for x in lines if not allowed(x)]; print('Dependency check: OK (known KFA/khmercut metadata mismatches accepted).') if not unexpected else print('\n'.join(unexpected)); sys.exit(1 if unexpected else 0)"

echo "Verifying KFA and preloading its Khmer ONNX model..."
echo "The first setup may download about 360 MB once."
"$PYTHON" -c "from importlib.metadata import version; import kfa, khmercut, khmernormalizer, onnxruntime; from khmercut import tokenize; from sosap import Model; import faster_whisper; assert version('khmercut')=='0.0.2'; assert version('python-crfsuite')=='0.9.11'; assert version('tqdm')=='4.65.0'; assert version('sosap')=='0.4.3'; assert callable(tokenize); assert Model is not None; print('KFA + Whisper timing environment: READY')"

echo "Local timing setup complete."
