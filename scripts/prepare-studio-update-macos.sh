#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "ERROR: Expected the verified pending-update file." >&2
  exit 2
fi

BROKER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
LOCK_FILE="$STATE_ROOT/.manual-install.lock"
SHLOCK_BIN="${STHANG_STUDIO_SHLOCK:-/usr/bin/shlock}"
LOCK_HELD=0

release_lock() {
  local owner=""
  if [[ "$LOCK_HELD" -eq 1 && -f "$LOCK_FILE" ]]; then
    owner="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ "$owner" == "$$" ]]; then rm -f -- "$LOCK_FILE"; fi
  fi
  LOCK_HELD=0
}
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

mkdir -p "$STATE_ROOT"
if [[ "${STHANG_STUDIO_INSTALL_LOCK_HELD:-}" != "1" ]]; then
  if [[ ! -x "$SHLOCK_BIN" ]] || ! "$SHLOCK_BIN" -p "$$" -f "$LOCK_FILE"; then
    echo "ERROR: Another Sthang Studio installation/update is running. Close it before retrying." >&2
    exit 1
  fi
  LOCK_HELD=1
fi

ROOT="$BROKER_ROOT"
export STHANG_STUDIO_STATE_ROOT="$STATE_ROOT"
source "$BROKER_ROOT/scripts/macos-common.sh"
studio_macos_host

PYTHON=""
if [[ -x "$BROKER_ROOT/.venv/bin/python" ]] && studio_macos_python_ok "$BROKER_ROOT/.venv/bin/python"; then
  PYTHON="$BROKER_ROOT/.venv/bin/python"
else
  if ! studio_macos_select_python; then
    studio_macos_install_managed_python
    studio_macos_select_python || {
      echo "ERROR: Native arm64 Python 3.12 is unavailable for update preparation." >&2
      exit 1
    }
  fi
  PYTHON="$STUDIO_PYTHON"
fi

"$PYTHON" "$BROKER_ROOT/scripts/prepare-studio-update-macos.py" "$1"
