#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This installer is for macOS."
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
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

install_with_brew() {
  local formula="$1"
  if ! command -v brew >/dev/null 2>&1; then
    echo "ERROR: Missing $formula. Install Homebrew from https://brew.sh or install the dependency yourself, then run this script again."
    exit 1
  fi
  echo "Installing $formula with Homebrew..."
  brew install "$formula"
}

NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
fi
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 24 ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "ERROR: Missing Node.js 24+. Install Homebrew from https://brew.sh or install Node.js 24+ yourself, then run this script again."
    exit 1
  fi
  echo "Installing Node.js 24 with Homebrew..."
  brew install node@24
  export PATH="$(brew --prefix node@24)/bin:$PATH"
fi
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "ERROR: Node.js 24 or newer is required. Current version: $(node --version)"
  exit 1
fi

if ! command -v python3.12 >/dev/null 2>&1; then install_with_brew python@3.12; fi

if command -v brew >/dev/null 2>&1; then
  FFMPEG_FULL_PREFIX="$(brew --prefix ffmpeg-full 2>/dev/null || true)"
  if [[ -x "$FFMPEG_FULL_PREFIX/bin/ffmpeg" ]]; then
    export PATH="$FFMPEG_FULL_PREFIX/bin:$PATH"
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1 || ! ffmpeg -hide_banner -h filter=ass 2>&1 | grep -qi "shaping"; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing FFmpeg with libass using Homebrew's ffmpeg-full formula..."
    brew install ffmpeg-full
    export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1 || ! ffmpeg -hide_banner -h filter=ass 2>&1 | grep -qi "shaping"; then
  echo "ERROR: This FFmpeg build does not expose the ASS/libass shaping support Sthang Studio requires."
  echo "Install a complete FFmpeg build with libass (Homebrew: brew install ffmpeg-full), then run this script again."
  exit 1
fi

echo "Installing reviewed Node dependencies..."
npm ci --include=dev

bash "$ROOT/setup-local-timing-macos.sh"

mkdir -p "$HOME/Library/Application Support/Sthang Studio"

echo
echo "Sthang Studio macOS setup is complete."
echo "Start it with: bash ./run-macos.sh"
echo "The first macOS beta supports Apple Silicon on macOS 14 Sonoma or newer."
