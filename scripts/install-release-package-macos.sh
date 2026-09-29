#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "ERROR: Expected the packaged Sthang Studio Files folder." >&2
  exit 1
fi

SOURCE_ROOT="$(cd "$1" && pwd)"
STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}"
INSTALL_ROOT="$STATE_ROOT/app"
BACKUP_ROOT="$STATE_ROOT/.manual-install-backup"
DISCARD_ROOT="$STATE_ROOT/.manual-install-discard"
STAGE_ROOT="$STATE_ROOT/.manual-install-stage"
FRESH_MARKER="$STATE_ROOT/.manual-install-fresh"
UPDATE_CONTROL_BACKUP="$STATE_ROOT/.manual-update-control-backup"
UPDATE_ROOT="$STATE_ROOT/updates"
LOCK_FILE="$STATE_ROOT/.manual-install.lock"
SHLOCK_BIN="${STHANG_STUDIO_SHLOCK:-/usr/bin/shlock}"
LAUNCHER_DIR="$HOME/Applications"
LAUNCHER="$LAUNCHER_DIR/Sthang Studio.command"
LAUNCHER_TMP="$LAUNCHER_DIR/.Sthang Studio.command.tmp"
LAUNCHER_BACKUP="$LAUNCHER_DIR/.Sthang Studio.command.backup"
APP_BUNDLE="$LAUNCHER_DIR/Sthang Studio.app"
APP_BUNDLE_TMP="$LAUNCHER_DIR/.Sthang Studio.app.tmp"
APP_BUNDLE_BACKUP="$LAUNCHER_DIR/.Sthang Studio.app.backup"
SIPS_BIN="${STHANG_STUDIO_SIPS:-/usr/bin/sips}"
ICONUTIL_BIN="${STHANG_STUDIO_ICONUTIL:-/usr/bin/iconutil}"
PLUTIL_BIN="${STHANG_STUDIO_PLUTIL:-/usr/bin/plutil}"
MV_BIN="${STHANG_STUDIO_MV:-/bin/mv}"
STATE_ROOT_QUOTED="$(printf '%q' "$STATE_ROOT")"
OLD_ENV="$INSTALL_ROOT/apps/server/.env"
HAD_OLD_ENV=0
LOCK_HELD=0
LAUNCHERS_PUBLISHED=0
HAD_LAUNCHER=0
HAD_APP_BUNDLE=0
UPDATE_CONTROL_RESET=0

cleanup_stage() {
  if [[ -d "$STAGE_ROOT" ]]; then
    rm -rf -- "$STAGE_ROOT"
  fi
}

rollback_install() {
  if [[ -d "$BACKUP_ROOT" ]]; then
    if [[ -d "$INSTALL_ROOT" ]]; then
      rm -rf -- "$INSTALL_ROOT"
    fi
    mv "$BACKUP_ROOT" "$INSTALL_ROOT"
  elif [[ -f "$FRESH_MARKER" ]]; then
    if [[ -d "$INSTALL_ROOT" ]]; then
      rm -rf -- "$INSTALL_ROOT"
    fi
    rm -f -- "$FRESH_MARKER"
  fi
}

restore_update_control() {
  if [[ ! -d "$UPDATE_CONTROL_BACKUP" ]]; then
    UPDATE_CONTROL_RESET=0
    return 0
  fi
  mkdir -p "$UPDATE_ROOT"
  local file=""
  for file in active.json transaction.json pending-install.json rollback.json last-failure.json high-water.json; do
    if [[ -f "$UPDATE_CONTROL_BACKUP/$file" ]]; then
      rm -f -- "$UPDATE_ROOT/$file"
      mv "$UPDATE_CONTROL_BACKUP/$file" "$UPDATE_ROOT/$file"
    fi
  done
  rmdir "$UPDATE_CONTROL_BACKUP" 2>/dev/null || rm -rf -- "$UPDATE_CONTROL_BACKUP"
  UPDATE_CONTROL_RESET=0
}

reset_update_control() {
  rm -rf -- "$UPDATE_CONTROL_BACKUP"
  mkdir -p "$UPDATE_CONTROL_BACKUP"
  local file=""
  local moved=0
  if [[ -d "$UPDATE_ROOT" ]]; then
    for file in active.json transaction.json pending-install.json rollback.json last-failure.json high-water.json; do
      if [[ -f "$UPDATE_ROOT/$file" ]]; then
        mv "$UPDATE_ROOT/$file" "$UPDATE_CONTROL_BACKUP/$file"
        moved=1
      fi
    done
  fi
  if [[ "$moved" -eq 0 ]]; then
    rmdir "$UPDATE_CONTROL_BACKUP"
  fi
  UPDATE_CONTROL_RESET=1
}

rollback_launchers() {
  if [[ "$LAUNCHERS_PUBLISHED" -ne 1 ]]; then return 0; fi
  if [[ "$HAD_LAUNCHER" -eq 1 && -f "$LAUNCHER_BACKUP" ]]; then
    rm -f -- "$LAUNCHER"
    "$MV_BIN" "$LAUNCHER_BACKUP" "$LAUNCHER"
  elif [[ "$HAD_LAUNCHER" -eq 0 ]]; then
    rm -f -- "$LAUNCHER"
  fi
  if [[ "$HAD_APP_BUNDLE" -eq 1 && -d "$APP_BUNDLE_BACKUP" ]]; then
    rm -rf -- "$APP_BUNDLE"
    "$MV_BIN" "$APP_BUNDLE_BACKUP" "$APP_BUNDLE"
  elif [[ "$HAD_APP_BUNDLE" -eq 0 ]]; then
    rm -rf -- "$APP_BUNDLE"
  fi
}

release_lock() {
  local owner=""
  if [[ "$LOCK_HELD" -eq 1 && -f "$LOCK_FILE" ]]; then
    owner="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ "$owner" == "$$" ]]; then
      rm -f -- "$LOCK_FILE"
    fi
  fi
  LOCK_HELD=0
}

finish_install_process() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ "$status" -ne 0 ]]; then
    rollback_launchers || true
    rollback_install || true
    restore_update_control || true
  fi
  cleanup_stage || true
  cleanup_launcher_temp || true
  release_lock || true
  exit "$status"
}

acquire_lock() {
  local prior_pid=""
  if [[ ! -x "$SHLOCK_BIN" ]]; then
    echo "ERROR: macOS installation locking is unavailable at $SHLOCK_BIN." >&2
    return 1
  fi
  if "$SHLOCK_BIN" -p "$$" -f "$LOCK_FILE"; then
    LOCK_HELD=1
    return 0
  fi
  if [[ -f "$LOCK_FILE" ]]; then
    prior_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  fi
  if [[ "$prior_pid" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Another Sthang Studio installation is still running (PID $prior_pid). Close it before retrying." >&2
  else
    echo "ERROR: Could not acquire the Sthang Studio installation lock. Close any other installer and retry." >&2
  fi
  return 1
}

cleanup_discard() {
  if [[ -d "$DISCARD_ROOT" ]]; then
    rm -rf -- "$DISCARD_ROOT"
  fi
}

cleanup_launcher_temp() {
  if [[ -f "$LAUNCHER_TMP" || -L "$LAUNCHER_TMP" ]]; then
    rm -f -- "$LAUNCHER_TMP"
  fi
  if [[ -d "$APP_BUNDLE_TMP" || -L "$APP_BUNDLE_TMP" ]]; then
    rm -rf -- "$APP_BUNDLE_TMP"
  fi
}

recover_launcher_transaction() {
  cleanup_launcher_temp
  if [[ -f "$LAUNCHER_BACKUP" ]]; then
    rm -f -- "$LAUNCHER"
    "$MV_BIN" "$LAUNCHER_BACKUP" "$LAUNCHER"
  fi
  if [[ -d "$APP_BUNDLE_BACKUP" ]]; then
    rm -rf -- "$APP_BUNDLE"
    "$MV_BIN" "$APP_BUNDLE_BACKUP" "$APP_BUNDLE"
  fi
}

recover_interrupted_install() {
  cleanup_stage
  local restore_prior_update_control=0
  if [[ -d "$BACKUP_ROOT" ]]; then
    restore_prior_update_control=1
    echo "Recovering the previous app from an interrupted installation..."
    if [[ -d "$INSTALL_ROOT" ]]; then
      rm -rf -- "$INSTALL_ROOT"
    fi
    mv "$BACKUP_ROOT" "$INSTALL_ROOT"
  elif [[ -f "$FRESH_MARKER" ]]; then
    restore_prior_update_control=1
    echo "Removing an incomplete interrupted installation before retrying..."
    if [[ -d "$INSTALL_ROOT" ]]; then
      rm -rf -- "$INSTALL_ROOT"
    fi
  fi
  rm -f -- "$FRESH_MARKER"
  if [[ "$restore_prior_update_control" -eq 1 ]]; then
    restore_update_control
  else
    rm -rf -- "$UPDATE_CONTROL_BACKUP"
  fi
  recover_launcher_transaction
  cleanup_discard
}

if [[ "$SOURCE_ROOT" == "$INSTALL_ROOT" ]]; then
  echo "ERROR: Run this installer from the extracted release package, not from the installed app folder." >&2
  exit 1
fi

if [[
  ! -f "$SOURCE_ROOT/INSTALL-MACOS.sh"
  || ! -f "$SOURCE_ROOT/run-macos.sh"
  || ! -f "$SOURCE_ROOT/package.json"
  || ! -f "$SOURCE_ROOT/config/update-trust-root-macos.json"
  || ! -f "$SOURCE_ROOT/scripts/launch-studio-macos.sh"
  || ! -f "$SOURCE_ROOT/scripts/prepare-studio-update-macos.sh"
  || ! -f "$SOURCE_ROOT/scripts/prepare-studio-update-macos.py"
]]; then
  echo "ERROR: The packaged Sthang Studio files are incomplete." >&2
  exit 1
fi

mkdir -p "$STATE_ROOT"
acquire_lock
trap finish_install_process EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
recover_interrupted_install
mkdir -p "$STAGE_ROOT"

echo
echo "Installing Sthang Studio into your macOS user profile..."
echo "$INSTALL_ROOT"

cp -R "$SOURCE_ROOT"/. "$STAGE_ROOT"/

if [[ -f "$OLD_ENV" ]]; then
  HAD_OLD_ENV=1
  mkdir -p "$STAGE_ROOT/apps/server"
  cp "$OLD_ENV" "$STAGE_ROOT/apps/server/.env"
fi

if [[ -d "$INSTALL_ROOT" ]]; then
  mv "$INSTALL_ROOT" "$BACKUP_ROOT"
else
  printf '%s\n' "$$" > "$FRESH_MARKER"
fi

mv "$STAGE_ROOT" "$INSTALL_ROOT"

if ! bash "$INSTALL_ROOT/INSTALL-MACOS.sh"; then
  echo "ERROR: macOS dependency setup did not complete. Restoring the previous installed application." >&2
  exit 1
fi

if [[ "$HAD_OLD_ENV" -eq 1 && ! -f "$INSTALL_ROOT/apps/server/.env" ]]; then
  echo "ERROR: The existing advanced .env fallback was not preserved. Restoring the previous installed application." >&2
  exit 1
fi

mkdir -p "$LAUNCHER_DIR"
rm -f -- "$LAUNCHER_TMP" "$LAUNCHER_BACKUP"
rm -rf -- "$APP_BUNDLE_TMP" "$APP_BUNDLE_BACKUP"
{
  cat <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF
  printf 'DEFAULT_STATE_ROOT=%s\n' "$STATE_ROOT_QUOTED"
  cat <<'EOF'
export STHANG_STUDIO_STATE_ROOT="${STHANG_STUDIO_STATE_ROOT:-$DEFAULT_STATE_ROOT}"
APP_ROOT="$STHANG_STUDIO_STATE_ROOT/app"
if [[ ! -f "$APP_ROOT/run-macos.sh" ]]; then
  echo "Sthang Studio is not installed correctly. Re-run the downloaded installer."
  read -r -p "Press Return to close..." _
  exit 1
fi
exec bash "$APP_ROOT/run-macos.sh"
EOF
} > "$LAUNCHER_TMP"
chmod 755 "$LAUNCHER_TMP"

ICON_SOURCE="$INSTALL_ROOT/apps/web/public/brand/sthang-studio-icon.png"
if [[ ! -f "$ICON_SOURCE" ]]; then
  echo "ERROR: The approved Sthang Studio application icon is missing." >&2
  exit 1
fi
mkdir -p "$APP_BUNDLE_TMP/Contents/MacOS" "$APP_BUNDLE_TMP/Contents/Resources/SthangStudio.iconset"
cat > "$APP_BUNDLE_TMP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Sthang Studio</string>
  <key>CFBundleExecutable</key><string>Sthang Studio</string>
  <key>CFBundleIconFile</key><string>SthangStudio</string>
  <key>CFBundleIdentifier</key><string>com.sthang.studio</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Sthang Studio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.3</string>
  <key>LSArchitecturePriority</key>
  <array><string>arm64</string></array>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
cat > "$APP_BUNDLE_TMP/Contents/MacOS/Sthang Studio" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LAUNCHER="$HOME/Applications/Sthang Studio.command"
if [[ ! -f "$LAUNCHER" ]]; then
  /usr/bin/osascript -e 'display alert "Sthang Studio needs repair" message "Re-run the current Sthang Studio installer, then try again." as critical' >/dev/null 2>&1 || true
  exit 1
fi
exec /usr/bin/open -a Terminal "$LAUNCHER"
EOF
chmod 755 "$APP_BUNDLE_TMP/Contents/MacOS/Sthang Studio"

ICONSET="$APP_BUNDLE_TMP/Contents/Resources/SthangStudio.iconset"
while read -r icon_size icon_name; do
  "$SIPS_BIN" -z "$icon_size" "$icon_size" "$ICON_SOURCE" --out "$ICONSET/$icon_name" >/dev/null
done <<'EOF'
16 icon_16x16.png
32 icon_16x16@2x.png
32 icon_32x32.png
64 icon_32x32@2x.png
128 icon_128x128.png
256 icon_128x128@2x.png
256 icon_256x256.png
512 icon_256x256@2x.png
512 icon_512x512.png
1024 icon_512x512@2x.png
EOF
"$ICONUTIL_BIN" -c icns "$ICONSET" -o "$APP_BUNDLE_TMP/Contents/Resources/SthangStudio.icns"
rm -rf -- "$ICONSET"
"$PLUTIL_BIN" -lint "$APP_BUNDLE_TMP/Contents/Info.plist" >/dev/null
[[ -s "$APP_BUNDLE_TMP/Contents/Resources/SthangStudio.icns" ]] || {
  echo "ERROR: Sthang Studio's Finder icon could not be prepared." >&2
  exit 1
}

LAUNCHERS_PUBLISHED=1
if [[ -f "$LAUNCHER" ]]; then
  HAD_LAUNCHER=1
  "$MV_BIN" "$LAUNCHER" "$LAUNCHER_BACKUP"
fi
if [[ -d "$APP_BUNDLE" ]]; then
  HAD_APP_BUNDLE=1
  "$MV_BIN" "$APP_BUNDLE" "$APP_BUNDLE_BACKUP"
fi
"$MV_BIN" "$LAUNCHER_TMP" "$LAUNCHER"
"$MV_BIN" "$APP_BUNDLE_TMP" "$APP_BUNDLE"

# A manual recovery/bootstrap install becomes the baseline authority. Keep the
# old OTA control pointers rollback-capable until the app/launcher transaction
# commits below, then discard them without deleting immutable versions/receipts.
reset_update_control

if [[ -d "$DISCARD_ROOT" ]]; then
  rm -rf -- "$DISCARD_ROOT"
fi
if [[ -d "$BACKUP_ROOT" ]]; then
  mv "$BACKUP_ROOT" "$DISCARD_ROOT"
else
  rm -f -- "$FRESH_MARKER"
fi
cleanup_discard || true
rm -rf -- "$UPDATE_CONTROL_BACKUP"
UPDATE_CONTROL_RESET=0
rm -f -- "$LAUNCHER_BACKUP"
rm -rf -- "$APP_BUNDLE_BACKUP"
LAUNCHERS_PUBLISHED=0

echo
echo "Sthang Studio is installed."
echo "Open Sthang Studio from your Applications folder."
echo "Finder app: $APP_BUNDLE"
echo "Terminal fallback: $LAUNCHER"
echo "You can delete the downloaded setup folder now."
