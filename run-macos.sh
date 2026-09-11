#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: The first Sthang Studio macOS beta supports Apple Silicon (arm64) only."
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
NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
fi
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 24 ]] && command -v brew >/dev/null 2>&1; then
  NODE24_PREFIX="$(brew --prefix node@24 2>/dev/null || true)"
  if [[ -x "$NODE24_PREFIX/bin/node" ]]; then
    export PATH="$NODE24_PREFIX/bin:$PATH"
  fi
fi
if command -v brew >/dev/null 2>&1; then
  FFMPEG_FULL_PREFIX="$(brew --prefix ffmpeg-full 2>/dev/null || true)"
  if [[ -x "$FFMPEG_FULL_PREFIX/bin/ffmpeg" ]]; then
    export PATH="$FFMPEG_FULL_PREFIX/bin:$PATH"
  fi
fi
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 24 ]] || [[ ! -x "$ROOT/.venv/bin/python" ]] || [[ ! -d "$ROOT/node_modules" ]] || ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1 || ! ffmpeg -hide_banner -h filter=ass 2>&1 | grep -qi "shaping"; then
  echo "ERROR: Sthang Studio setup is incomplete. Run bash ./INSTALL-MACOS.sh first."
  exit 1
fi

export STHANG_STUDIO_STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
export STHANG_STUDIO_ENV_FILE="${STHANG_STUDIO_ENV_FILE:-$ROOT/apps/server/.env}"

echo "Starting Sthang Studio. Keep this terminal open while using the app."
exec npm run dev
