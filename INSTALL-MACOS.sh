#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
source "$ROOT/scripts/macos-common.sh"
studio_macos_host

if ! studio_macos_select_node; then
  studio_macos_install_managed_node
  studio_macos_select_node || { echo "ERROR: Native Node 22.23.3+ (22.x), or Node 24.21+ (24.x) on macOS 13.5+, and npm are required."; exit 1; }
fi

if ! studio_macos_select_python; then
  studio_macos_install_managed_python
  studio_macos_select_python || { echo "ERROR: Native arm64 Python 3.12.15 was not found."; exit 1; }
fi

if ! studio_macos_select_ffmpeg; then
  studio_macos_install_managed_ffmpeg
  studio_macos_select_ffmpeg || { echo "ERROR: FFmpeg/ffprobe must run locally and expose ASS/libass complex shaping."; exit 1; }
fi

echo "Installing reviewed Node dependencies..."
if [[ -f "$ROOT/.sthang/macos-curated-runtime" ]]; then
  for required in "$ROOT/apps/server/dist/index.js" "$ROOT/apps/web/dist/index.html" "$ROOT/packages/shared/dist/index.js"; do
    [[ -f "$required" ]] || { echo "ERROR: The curated macOS package is missing a production build artifact: $required" >&2; exit 1; }
  done
  npm ci --omit=dev --ignore-scripts --workspace @kcs/server --workspace @kcs/shared --include-workspace-root
else
  npm ci --include=dev
fi
bash "$ROOT/setup-local-timing-macos.sh"

echo
echo "Sthang Studio macOS source setup is complete."
echo "Start it with: bash ./run-macos.sh"
echo "Compatibility target: native Apple Silicon, macOS 12.3 Monterey or newer."
echo "Use Safari 17+ or a maintained browser version compatible with your macOS."
