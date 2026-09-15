#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/macos-common.sh"
studio_macos_host

if ! studio_macos_select_node; then
  studio_macos_brew_install "$STUDIO_NODE_FORMULA"
  studio_macos_select_node || { echo "ERROR: Native Node 22.12+ (22.x), or Node 24+ on macOS 13.5+, and npm are required."; exit 1; }
fi

if [[ -e "$ROOT/.venv" || -L "$ROOT/.venv" ]]; then
  studio_macos_require_venv
elif ! studio_macos_select_python; then
  studio_macos_brew_install python@3.12
  studio_macos_select_python || { echo "ERROR: Native arm64 Python 3.12 was not found."; exit 1; }
fi

if ! studio_macos_select_ffmpeg; then
  studio_macos_brew_install ffmpeg-full
  studio_macos_select_ffmpeg || { echo "ERROR: FFmpeg/ffprobe must run locally and expose ASS/libass complex shaping."; exit 1; }
fi

echo "Installing reviewed Node dependencies..."
npm ci --include=dev
bash "$ROOT/setup-local-timing-macos.sh"

echo
echo "Sthang Studio macOS source setup is complete."
echo "Start it with: bash ./run-macos.sh"
echo "Compatibility target: native Apple Silicon, macOS 12.3 Monterey or newer."
echo "Use Safari 17+ or a maintained browser version compatible with your macOS."
