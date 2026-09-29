#!/usr/bin/env bash
# Shared by all macOS entrypoints. Keep compatible with Apple's Bash 3.2.

STUDIO_MACOS_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$STUDIO_MACOS_COMMON_DIR/macos-managed-runtime.sh"

studio_macos_host() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "ERROR: This entrypoint is for macOS." >&2
    return 1
  fi
  if [[ "$(uname -m)" != "arm64" ]]; then
    echo "ERROR: Use a native Apple Silicon terminal (arm64), not Rosetta. Intel Macs are not supported." >&2
    return 1
  fi
  STUDIO_MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || true)"
  if [[ ! "$STUDIO_MACOS_VERSION" =~ ^([0-9]{1,3})(\.([0-9]{1,3}))?(\.([0-9]{1,3}))?$ ]]; then
    echo "ERROR: Could not determine a valid macOS version." >&2
    return 1
  fi
  STUDIO_MACOS_MAJOR=$((10#${BASH_REMATCH[1]}))
  STUDIO_MACOS_MINOR=$((10#${BASH_REMATCH[3]:-0}))
  if [[ "$STUDIO_MACOS_MAJOR" -lt 12 ]] || { [[ "$STUDIO_MACOS_MAJOR" -eq 12 ]] && [[ "$STUDIO_MACOS_MINOR" -lt 3 ]]; }; then
    echo "ERROR: This source beta requires macOS 12.3 Monterey or newer. Current version: $STUDIO_MACOS_VERSION" >&2
    return 1
  fi
  STUDIO_NODE_FORMULA="node@24"
  if [[ "$STUDIO_MACOS_MAJOR" -lt 13 ]] || { [[ "$STUDIO_MACOS_MAJOR" -eq 13 ]] && [[ "$STUDIO_MACOS_MINOR" -lt 5 ]]; }; then
    STUDIO_NODE_FORMULA="node@22"
  fi
}

studio_macos_node_ok() {
  local info major minor
  info="$("$1" -p 'process.versions.node + " " + process.arch' 2>/dev/null)" || return 1
  [[ "$info" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\ arm64$ ]] || return 1
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  if [[ "$major" -eq 22 && "$minor" -ge 12 ]]; then return 0; fi
  [[ "$major" -ge 24 && "$STUDIO_NODE_FORMULA" != "node@22" ]]
}

studio_macos_select_node() {
  local formula prefix
  if studio_macos_node_ok node && command -v npm >/dev/null 2>&1; then return 0; fi
  studio_macos_managed_paths
  if [[ -x "$STUDIO_MANAGED_NODE_ROOT/bin/npm" ]] && studio_macos_node_ok "$STUDIO_MANAGED_NODE_ROOT/bin/node"; then
    export PATH="$STUDIO_MANAGED_NODE_ROOT/bin:$PATH"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    for formula in "$STUDIO_NODE_FORMULA" node@22; do
      prefix="$(brew --prefix "$formula" 2>/dev/null || true)"
      if [[ -n "$prefix" && -x "$prefix/bin/npm" ]] && studio_macos_node_ok "$prefix/bin/node"; then
        export PATH="$prefix/bin:$PATH"
        return 0
      fi
    done
  fi
  return 1
}

studio_macos_python_ok() {
  "$1" -c 'import ensurepip, platform, ssl, sys, venv; sys.exit(0 if sys.version_info[:2] == (3, 12) and platform.machine() == "arm64" else 1)' >/dev/null 2>&1
}

studio_macos_select_python() {
  local candidate prefix
  for candidate in python3.12 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 /opt/local/bin/python3.12; do
    if studio_macos_python_ok "$candidate"; then
      STUDIO_PYTHON="$candidate"
      return 0
    fi
  done
  studio_macos_managed_paths
  if studio_macos_python_ok "$STUDIO_MANAGED_PYTHON_ROOT/bin/python3.12"; then
    STUDIO_PYTHON="$STUDIO_MANAGED_PYTHON_ROOT/bin/python3.12"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    prefix="$(brew --prefix python@3.12 2>/dev/null || true)"
    if [[ -n "$prefix" ]] && studio_macos_python_ok "$prefix/bin/python3.12"; then
      STUDIO_PYTHON="$prefix/bin/python3.12"
      return 0
    fi
  fi
  return 1
}

studio_macos_ffmpeg_ok() {
  local ffmpeg_command="${1:-ffmpeg}"
  local ffprobe_command="${2:-ffprobe}"
  local ffmpeg_path ffprobe_path file_bin ffmpeg_info ffprobe_info help encoders
  file_bin="${STHANG_STUDIO_FILE:-/usr/bin/file}"
  if [[ "$ffmpeg_command" == */* ]]; then ffmpeg_path="$ffmpeg_command"; else ffmpeg_path="$(command -v "$ffmpeg_command" 2>/dev/null || true)"; fi
  if [[ "$ffprobe_command" == */* ]]; then ffprobe_path="$ffprobe_command"; else ffprobe_path="$(command -v "$ffprobe_command" 2>/dev/null || true)"; fi
  [[ -x "$ffmpeg_path" && -x "$ffprobe_path" ]] || return 1
  ffmpeg_info="$("$file_bin" -b "$ffmpeg_path" 2>/dev/null || true)"
  ffprobe_info="$("$file_bin" -b "$ffprobe_path" 2>/dev/null || true)"
  [[ "$ffmpeg_info" == *arm64* && "$ffprobe_info" == *arm64* ]] || return 1
  "$ffmpeg_path" -version >/dev/null 2>&1 && "$ffprobe_path" -version >/dev/null 2>&1 || return 1
  help="$("$ffmpeg_path" -hide_banner -h filter=ass 2>&1)" || return 1
  # Capture first: grep -q in a producer pipeline can spuriously fail with pipefail.
  [[ "$help" == *shaping* && "$help" == *complex* ]] || return 1
  encoders="$("$ffmpeg_path" -hide_banner -encoders 2>&1)" || return 1
  [[ "$encoders" == *libx264* ]]
}

studio_macos_select_ffmpeg() {
  local prefix old_path
  if studio_macos_ffmpeg_ok; then
    STUDIO_FFMPEG_PATH="$(command -v ffmpeg)"
    STUDIO_FFPROBE_PATH="$(command -v ffprobe)"
    export FFMPEG_PATH="$STUDIO_FFMPEG_PATH"
    export FFPROBE_PATH="$STUDIO_FFPROBE_PATH"
    return 0
  fi
  studio_macos_managed_paths
  if studio_macos_ffmpeg_ok "$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffmpeg" "$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffprobe"; then
    export PATH="$STUDIO_MANAGED_FFMPEG_ROOT/bin:$PATH"
    STUDIO_FFMPEG_PATH="$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffmpeg"
    STUDIO_FFPROBE_PATH="$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffprobe"
    export FFMPEG_PATH="$STUDIO_FFMPEG_PATH"
    export FFPROBE_PATH="$STUDIO_FFPROBE_PATH"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    prefix="$(brew --prefix ffmpeg-full 2>/dev/null || true)"
    if [[ -n "$prefix" && -x "$prefix/bin/ffmpeg" ]]; then
      old_path="$PATH"
      export PATH="$prefix/bin:$PATH"
      if studio_macos_ffmpeg_ok; then
        STUDIO_FFMPEG_PATH="$(command -v ffmpeg)"
        STUDIO_FFPROBE_PATH="$(command -v ffprobe)"
        export FFMPEG_PATH="$STUDIO_FFMPEG_PATH"
        export FFPROBE_PATH="$STUDIO_FFPROBE_PATH"
        return 0
      fi
      export PATH="$old_path"
    fi
  fi
  return 1
}

studio_macos_require_venv() {
  if ! studio_macos_python_ok "$ROOT/.venv/bin/python"; then
    echo "ERROR: .venv must use native arm64 Python 3.12. Existing files have not been removed." >&2
    echo "Close Studio, move an incompatible .venv aside, and rerun bash ./INSTALL-MACOS.sh." >&2
    return 1
  fi
}
