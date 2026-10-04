#!/usr/bin/env bash
# App-private prerequisite provisioning for Apple Silicon macOS.
# Keep compatible with Apple's Bash 3.2. All URLs and digests are deliberately
# fixed so a release review covers the exact runtime bytes users can receive.

STUDIO_MANAGED_NODE_VERSION="22.23.3"
STUDIO_MANAGED_NODE_ARCHIVE="node-v22.23.3-darwin-arm64.tar.gz"
STUDIO_MANAGED_NODE_URL="https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz"
STUDIO_MANAGED_NODE_SHA256="23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53"

STUDIO_MANAGED_PYTHON_VERSION="3.12.15"
STUDIO_MANAGED_PYTHON_RELEASE="20261003"
STUDIO_MANAGED_PYTHON_ARCHIVE="cpython-3.12.15+20261003-aarch64-apple-darwin-install_only.tar.gz"
STUDIO_MANAGED_PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-aarch64-apple-darwin-install_only.tar.gz"
STUDIO_MANAGED_PYTHON_SHA256="316a463172740e71d8dca1f2730784e325f3f720941137b5d674d5801a632213"

STUDIO_MANAGED_FFMPEG_VERSION="8.1-20260424"
STUDIO_MANAGED_FFMPEG_ARCHIVE="FFmpeg-arm-silicon-Tools-20260424.zip"
STUDIO_MANAGED_FFMPEG_URL="https://github.com/kiimelon/FFmpeg-arm-silicon/releases/download/0.5.0/FFmpeg-arm-silicon-Tools-20260424.zip"
STUDIO_MANAGED_FFMPEG_SHA256="7262b3ff400c0e88235647d99ab79067010694f059c4aa8af0bb0c43a951b2fc"

studio_macos_managed_paths() {
  STUDIO_MACOS_STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
  STUDIO_MACOS_TOOLS_ROOT="$STUDIO_MACOS_STATE_ROOT/tools/macos-arm64"
  STUDIO_MANAGED_NODE_ROOT="$STUDIO_MACOS_TOOLS_ROOT/node-v$STUDIO_MANAGED_NODE_VERSION"
  STUDIO_MANAGED_PYTHON_ROOT="$STUDIO_MACOS_TOOLS_ROOT/python-$STUDIO_MANAGED_PYTHON_VERSION-$STUDIO_MANAGED_PYTHON_RELEASE"
  STUDIO_MANAGED_FFMPEG_ROOT="$STUDIO_MACOS_TOOLS_ROOT/ffmpeg-$STUDIO_MANAGED_FFMPEG_VERSION"
}

studio_macos_download_verified() {
  local url="$1"
  local destination="$2"
  local expected_sha="$3"
  local label="$4"
  local curl_bin="${STHANG_STUDIO_CURL:-/usr/bin/curl}"
  local shasum_bin="${STHANG_STUDIO_SHASUM:-/usr/bin/shasum}"
  local partial="${destination}.part.$$"
  local digest_line actual_sha

  rm -f -- "$partial"
  echo "Downloading $label..."
  if ! "$curl_bin" --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 --output "$partial" "$url"; then
    rm -f -- "$partial"
    echo "ERROR: Could not download $label. Check the internet connection and retry setup." >&2
    return 1
  fi

  digest_line="$("$shasum_bin" -a 256 "$partial" 2>/dev/null)" || {
    rm -f -- "$partial"
    echo "ERROR: Could not verify the $label SHA-256 digest." >&2
    return 1
  }
  set -- $digest_line
  actual_sha="${1:-}"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    rm -f -- "$partial"
    echo "ERROR: $label failed SHA-256 verification. The downloaded file was removed." >&2
    return 1
  fi

  mv -- "$partial" "$destination"
}

studio_macos_install_managed_node() {
  studio_macos_managed_paths
  local tar_bin="${STHANG_STUDIO_TAR:-/usr/bin/tar}"
  local work="$STUDIO_MACOS_TOOLS_ROOT/.install-node-$$"
  local archive="$work/$STUDIO_MANAGED_NODE_ARCHIVE"
  local extract="$work/extract"
  local candidate="$extract/node-v$STUDIO_MANAGED_NODE_VERSION-darwin-arm64"

  mkdir -p "$STUDIO_MACOS_TOOLS_ROOT"
  if [[ -x "$STUDIO_MANAGED_NODE_ROOT/bin/node" && -x "$STUDIO_MANAGED_NODE_ROOT/bin/npm" ]] && studio_macos_node_ok "$STUDIO_MANAGED_NODE_ROOT/bin/node"; then
    return 0
  fi

  rm -rf -- "$work"
  mkdir -p "$extract"
  if ! studio_macos_download_verified "$STUDIO_MANAGED_NODE_URL" "$archive" "$STUDIO_MANAGED_NODE_SHA256" "Node.js $STUDIO_MANAGED_NODE_VERSION for Apple Silicon"; then
    rm -rf -- "$work"
    return 1
  fi
  if ! "$tar_bin" -xzf "$archive" -C "$extract"; then
    rm -rf -- "$work"
    echo "ERROR: The verified Node.js archive could not be extracted." >&2
    return 1
  fi
  if [[ ! -x "$candidate/bin/node" || ! -x "$candidate/bin/npm" ]] || ! studio_macos_node_ok "$candidate/bin/node"; then
    rm -rf -- "$work"
    echo "ERROR: The verified Node.js archive did not contain the required native arm64 runtime." >&2
    return 1
  fi

  studio_macos_promote_runtime "$candidate" "$STUDIO_MANAGED_NODE_ROOT" node || { rm -rf -- "$work"; return 1; }
  rm -rf -- "$work"
  echo "Node.js $STUDIO_MANAGED_NODE_VERSION is ready in Sthang Studio's private tools folder."
}

studio_macos_install_managed_python() {
  studio_macos_managed_paths
  local tar_bin="${STHANG_STUDIO_TAR:-/usr/bin/tar}"
  local work="$STUDIO_MACOS_TOOLS_ROOT/.install-python-$$"
  local archive="$work/$STUDIO_MANAGED_PYTHON_ARCHIVE"
  local extract="$work/extract"
  local candidate="$extract/python"

  mkdir -p "$STUDIO_MACOS_TOOLS_ROOT"
  if [[ -x "$STUDIO_MANAGED_PYTHON_ROOT/bin/python3.12" ]] && studio_macos_python_ok "$STUDIO_MANAGED_PYTHON_ROOT/bin/python3.12"; then
    return 0
  fi

  rm -rf -- "$work"
  mkdir -p "$extract"
  if ! studio_macos_download_verified "$STUDIO_MANAGED_PYTHON_URL" "$archive" "$STUDIO_MANAGED_PYTHON_SHA256" "Python $STUDIO_MANAGED_PYTHON_VERSION for Apple Silicon"; then
    rm -rf -- "$work"
    return 1
  fi
  if ! "$tar_bin" -xzf "$archive" -C "$extract"; then
    rm -rf -- "$work"
    echo "ERROR: The verified Python archive could not be extracted." >&2
    return 1
  fi
  if [[ ! -x "$candidate/bin/python3.12" ]] || ! studio_macos_python_ok "$candidate/bin/python3.12"; then
    rm -rf -- "$work"
    echo "ERROR: The verified Python archive did not contain a usable native arm64 Python 3.12 runtime." >&2
    return 1
  fi

  studio_macos_promote_runtime "$candidate" "$STUDIO_MANAGED_PYTHON_ROOT" python || { rm -rf -- "$work"; return 1; }
  rm -rf -- "$work"
  echo "Python $STUDIO_MANAGED_PYTHON_VERSION is ready in Sthang Studio's private tools folder."
}

studio_macos_install_managed_ffmpeg() {
  studio_macos_managed_paths
  local unzip_bin="${STHANG_STUDIO_UNZIP:-/usr/bin/unzip}"
  local work="$STUDIO_MACOS_TOOLS_ROOT/.install-ffmpeg-$$"
  local archive="$work/$STUDIO_MANAGED_FFMPEG_ARCHIVE"
  local extract="$work/extract"
  local candidate="$work/runtime"

  mkdir -p "$STUDIO_MACOS_TOOLS_ROOT"
  if [[ -x "$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffmpeg" && -x "$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffprobe" ]] && studio_macos_ffmpeg_ok "$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffmpeg" "$STUDIO_MANAGED_FFMPEG_ROOT/bin/ffprobe"; then
    return 0
  fi

  rm -rf -- "$work"
  mkdir -p "$extract" "$candidate/bin"
  if ! studio_macos_download_verified "$STUDIO_MANAGED_FFMPEG_URL" "$archive" "$STUDIO_MANAGED_FFMPEG_SHA256" "FFmpeg $STUDIO_MANAGED_FFMPEG_VERSION for Apple Silicon"; then
    rm -rf -- "$work"
    return 1
  fi
  if ! "$unzip_bin" -q "$archive" -d "$extract"; then
    rm -rf -- "$work"
    echo "ERROR: The verified FFmpeg runtime archives could not be extracted." >&2
    return 1
  fi
  if [[ ! -f "$extract/Tools/ffmpeg" || ! -f "$extract/Tools/ffprobe" ]]; then
    rm -rf -- "$work"
    echo "ERROR: The verified FFmpeg archives did not contain ffmpeg and ffprobe." >&2
    return 1
  fi
  cp "$extract/Tools/ffmpeg" "$candidate/bin/ffmpeg"
  cp "$extract/Tools/ffprobe" "$candidate/bin/ffprobe"
  chmod 755 "$candidate/bin/ffmpeg" "$candidate/bin/ffprobe"
  if ! studio_macos_managed_ffmpeg_build_ok "$candidate/bin/ffmpeg"; then
    rm -rf -- "$work"
    echo "ERROR: The verified FFmpeg runtime did not match the reviewed GPL/libass/libx264 build contract." >&2
    return 1
  fi
  if ! studio_macos_ffmpeg_ok "$candidate/bin/ffmpeg" "$candidate/bin/ffprobe"; then
    rm -rf -- "$work"
    echo "ERROR: The verified FFmpeg runtime failed native-arm64, libass shaping, or H.264 encoder validation." >&2
    return 1
  fi

  studio_macos_promote_runtime "$candidate" "$STUDIO_MANAGED_FFMPEG_ROOT" ffmpeg || { rm -rf -- "$work"; return 1; }
  rm -rf -- "$work"
  echo "FFmpeg $STUDIO_MANAGED_FFMPEG_VERSION is ready in Sthang Studio's private tools folder."
}

studio_macos_managed_ffmpeg_build_ok() {
  local ffmpeg_command="$1"
  local buildconf
  buildconf="$("$ffmpeg_command" -hide_banner -buildconf 2>&1)" || return 1
  [[ "$buildconf" == *--enable-gpl* ]] || return 1
  [[ "$buildconf" == *--enable-version3* ]] || return 1
  [[ "$buildconf" == *--enable-libass* ]] || return 1
  [[ "$buildconf" == *--enable-libharfbuzz* ]] || return 1
  [[ "$buildconf" == *--enable-libx264* ]] || return 1
  [[ "$buildconf" != *--enable-nonfree* ]] || return 1
  [[ "$buildconf" != *--enable-openssl* ]]
}

# Preserve an existing installation if final-path validation fails. A versioned
# previous directory is retained after success for manual recovery.
studio_macos_promote_runtime() {
  local candidate="$1" target="$2" kind="$3"
  local backup="${target}.previous-$$" had_previous=0
  if [[ -e "$backup" || -L "$backup" ]]; then
    echo "ERROR: Runtime recovery directory already exists; preserve it before retrying." >&2
    return 1
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    mv -- "$target" "$backup" || return 1
    had_previous=1
  fi
  if ! mv -- "$candidate" "$target"; then
    if [[ "$had_previous" -eq 1 ]]; then mv -- "$backup" "$target"; fi
    return 1
  fi
  local ok=1
  case "$kind" in
    node) studio_macos_node_ok "$target/bin/node" && [[ -x "$target/bin/npm" ]] && ok=0 ;;
    python) studio_macos_python_ok "$target/bin/python3.12" && ok=0 ;;
    ffmpeg) studio_macos_ffmpeg_ok "$target/bin/ffmpeg" "$target/bin/ffprobe" && ok=0 ;;
  esac
  if [[ "$ok" -ne 0 ]]; then
    mv -- "$target" "$candidate"
    if [[ "$had_previous" -eq 1 ]]; then mv -- "$backup" "$target"; fi
    echo "ERROR: Runtime validation failed after placement; previous runtime restored." >&2
    return 1
  fi
}
