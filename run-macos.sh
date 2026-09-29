#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export STHANG_STUDIO_STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
export STHANG_STUDIO_ENV_FILE="${STHANG_STUDIO_ENV_FILE:-$ROOT/apps/server/.env}"

if [[ -f "$ROOT/.sthang/macos-curated-runtime" && "$ROOT" == "$STHANG_STUDIO_STATE_ROOT/app" && "${STHANG_STUDIO_BROKER_CHILD:-}" != "1" ]]; then
  exec bash "$ROOT/scripts/launch-studio-macos.sh"
fi
unset STHANG_STUDIO_BROKER_CHILD

source "$ROOT/scripts/macos-common.sh"
studio_macos_host

if ! studio_macos_select_node || ! studio_macos_select_ffmpeg || [[ ! -d "$ROOT/node_modules" ]]; then
  echo "ERROR: Setup is incomplete. Run bash ./INSTALL-MACOS.sh first."
  echo "macOS 12.3 through 13.4 needs native Node 22.12+ (22.x), not Node 24."
  exit 1
fi
studio_macos_require_venv

echo "Starting Sthang Studio. Keep this terminal open while using the app."
if [[ -f "$ROOT/.sthang/macos-curated-runtime" ]]; then
  [[ -f "$ROOT/apps/server/dist/index.js" && -f "$ROOT/apps/web/dist/index.html" && -f "$ROOT/packages/shared/dist/index.js" ]] || {
    echo "ERROR: The curated macOS production runtime is incomplete. Re-run the current installer." >&2
    exit 1
  }
  exec node "$ROOT/scripts/dev.mjs" --production
fi
exec npm run dev
