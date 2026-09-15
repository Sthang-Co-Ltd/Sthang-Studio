#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/macos-common.sh"
studio_macos_host

if ! studio_macos_select_node || ! studio_macos_select_ffmpeg || [[ ! -d "$ROOT/node_modules" ]]; then
  echo "ERROR: Setup is incomplete. Run bash ./INSTALL-MACOS.sh first."
  echo "macOS 12.3 through 13.4 needs native Node 22.12+ (22.x), not Node 24."
  exit 1
fi
studio_macos_require_venv

export STHANG_STUDIO_STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
export STHANG_STUDIO_ENV_FILE="${STHANG_STUDIO_ENV_FILE:-$ROOT/apps/server/.env}"

echo "Starting Sthang Studio. Keep this terminal open while using the app."
exec npm run dev
