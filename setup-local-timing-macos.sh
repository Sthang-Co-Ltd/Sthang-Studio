#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export STHANG_STUDIO_STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
export ORT_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_TELEMETRY=1
export DO_NOT_TRACK=1
source "$ROOT/scripts/macos-common.sh"
studio_macos_host

if ! studio_macos_select_python; then
  studio_macos_install_managed_python
  studio_macos_select_python || { echo "ERROR: Reviewed native arm64 Python 3.12.15 is unavailable." >&2; exit 1; }
fi
PROFILE="macos-modern-py312-arm64"
if [[ "$STUDIO_MACOS_MAJOR" -lt 14 ]]; then PROFILE="macos-legacy-py312-arm64"; fi
"$STUDIO_PYTHON" "$ROOT/scripts/provision-timing.py" --profile "$PROFILE"
