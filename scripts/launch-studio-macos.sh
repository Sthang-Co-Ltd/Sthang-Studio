#!/usr/bin/env bash
set -euo pipefail

BROKER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
export STHANG_STUDIO_STATE_ROOT="$STATE_ROOT"

source "$BROKER_ROOT/scripts/macos-common.sh"
studio_macos_host
if ! studio_macos_select_node; then
  echo "ERROR: Sthang Studio's Node runtime is unavailable. Re-run the current Sthang Studio installer." >&2
  exit 1
fi

TRUST_ROOT="$BROKER_ROOT/config/update-trust-root-macos.json"
if [[ ! -f "$TRUST_ROOT" ]]; then
  echo "ERROR: Sthang Studio's macOS update trust root is missing. Re-run the current installer." >&2
  exit 1
fi
export STHANG_STUDIO_UPDATE_TRUST_ROOT_FILE="$TRUST_ROOT"
export STHANG_STUDIO_BROKER_VERSION="1.0.0"

exec node "$BROKER_ROOT/scripts/update-runtime.mjs" broker-macos "$STATE_ROOT"
