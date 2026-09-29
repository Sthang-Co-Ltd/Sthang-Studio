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
STAGE_ROOT="$STATE_ROOT/.manual-install-stage"
LOCK_ROOT="$STATE_ROOT/.manual-install-lock"
LAUNCHER_DIR="$HOME/Applications"
LAUNCHER="$LAUNCHER_DIR/Sthang Studio.command"
OLD_ENV="$INSTALL_ROOT/apps/server/.env"
HAD_OLD_ENV=0
INSTALLED_NEW_ROOT=0
BACKED_UP_OLD_ROOT=0
LOCK_HELD=0

cleanup_stage() {
  if [[ -d "$STAGE_ROOT" ]]; then
    rm -rf -- "$STAGE_ROOT"
  fi
}

rollback_install() {
  if [[ "$INSTALLED_NEW_ROOT" -eq 1 && -d "$INSTALL_ROOT" ]]; then
    rm -rf -- "$INSTALL_ROOT"
  fi
  if [[ "$BACKED_UP_OLD_ROOT" -eq 1 && -d "$BACKUP_ROOT" ]]; then
    mv "$BACKUP_ROOT" "$INSTALL_ROOT"
  fi
  INSTALLED_NEW_ROOT=0
  BACKED_UP_OLD_ROOT=0
}

release_lock() {
  if [[ "$LOCK_HELD" -eq 1 && -d "$LOCK_ROOT" ]]; then
    rm -rf -- "$LOCK_ROOT"
  fi
  LOCK_HELD=0
}

finish_install_process() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ "$status" -ne 0 ]]; then
    rollback_install || true
  fi
  cleanup_stage || true
  release_lock || true
  exit "$status"
}

acquire_lock() {
  local prior_pid=""
  if mkdir "$LOCK_ROOT" 2>/dev/null; then
    LOCK_HELD=1
    printf '%s\n' "$$" > "$LOCK_ROOT/pid"
    return 0
  fi

  if [[ -f "$LOCK_ROOT/pid" ]]; then
    prior_pid="$(cat "$LOCK_ROOT/pid" 2>/dev/null || true)"
  fi
  if [[ "$prior_pid" =~ ^[0-9]+$ ]] && kill -0 "$prior_pid" 2>/dev/null; then
    echo "ERROR: Another Sthang Studio installation is still running. Close it before retrying." >&2
    return 1
  fi

  rm -rf -- "$LOCK_ROOT"
  if ! mkdir "$LOCK_ROOT"; then
    echo "ERROR: Could not acquire the Sthang Studio installation lock." >&2
    return 1
  fi
  LOCK_HELD=1
  printf '%s\n' "$$" > "$LOCK_ROOT/pid"
}

recover_interrupted_install() {
  cleanup_stage
  if [[ -d "$BACKUP_ROOT" ]]; then
    echo "Recovering the previous app from an interrupted installation..."
    if [[ -d "$INSTALL_ROOT" ]]; then
      rm -rf -- "$INSTALL_ROOT"
    fi
    mv "$BACKUP_ROOT" "$INSTALL_ROOT"
  fi
}

if [[ "$SOURCE_ROOT" == "$INSTALL_ROOT" ]]; then
  echo "ERROR: Run this installer from the extracted release package, not from the installed app folder." >&2
  exit 1
fi

if [[ ! -f "$SOURCE_ROOT/INSTALL-MACOS.sh" || ! -f "$SOURCE_ROOT/run-macos.sh" || ! -f "$SOURCE_ROOT/package.json" ]]; then
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
  BACKED_UP_OLD_ROOT=1
fi

mv "$STAGE_ROOT" "$INSTALL_ROOT"
INSTALLED_NEW_ROOT=1

if ! bash "$INSTALL_ROOT/INSTALL-MACOS.sh"; then
  echo "ERROR: macOS dependency setup did not complete. Restoring the previous installed application." >&2
  exit 1
fi

if [[ "$HAD_OLD_ENV" -eq 1 && ! -f "$INSTALL_ROOT/apps/server/.env" ]]; then
  echo "ERROR: The existing advanced .env fallback was not preserved. Restoring the previous installed application." >&2
  exit 1
fi

mkdir -p "$LAUNCHER_DIR"
cat > "$LAUNCHER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
APP_ROOT="${STHANG_STUDIO_STATE_ROOT:-$HOME/Library/Application Support/Sthang Studio}/app"
if [[ ! -f "$APP_ROOT/run-macos.sh" ]]; then
  echo "Sthang Studio is not installed correctly. Re-run the downloaded installer."
  read -r -p "Press Return to close..." _
  exit 1
fi
exec bash "$APP_ROOT/run-macos.sh"
EOF
chmod 755 "$LAUNCHER"

if [[ "$BACKED_UP_OLD_ROOT" -eq 1 && -d "$BACKUP_ROOT" ]]; then
  rm -rf -- "$BACKUP_ROOT"
fi
BACKED_UP_OLD_ROOT=0
INSTALLED_NEW_ROOT=0

echo
echo "Sthang Studio is installed."
echo "Open it from: $LAUNCHER"
echo "You can delete the downloaded setup folder now."
