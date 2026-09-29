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
LOCK_FILE="$STATE_ROOT/.manual-install.lock"
SHLOCK_BIN="${STHANG_STUDIO_SHLOCK:-/usr/bin/shlock}"
LAUNCHER_DIR="$HOME/Applications"
LAUNCHER="$LAUNCHER_DIR/Sthang Studio.command"
LAUNCHER_TMP="$LAUNCHER_DIR/.Sthang Studio.command.tmp"
STATE_ROOT_QUOTED="$(printf '%q' "$STATE_ROOT")"
OLD_ENV="$INSTALL_ROOT/apps/server/.env"
HAD_OLD_ENV=0
LOCK_HELD=0

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
    rollback_install || true
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
}

recover_interrupted_install() {
  cleanup_stage
  if [[ -d "$BACKUP_ROOT" ]]; then
    echo "Recovering the previous app from an interrupted installation..."
    if [[ -d "$INSTALL_ROOT" ]]; then
      rm -rf -- "$INSTALL_ROOT"
    fi
    mv "$BACKUP_ROOT" "$INSTALL_ROOT"
  elif [[ -f "$FRESH_MARKER" ]]; then
    echo "Removing an incomplete interrupted installation before retrying..."
    if [[ -d "$INSTALL_ROOT" ]]; then
      rm -rf -- "$INSTALL_ROOT"
    fi
  fi
  rm -f -- "$FRESH_MARKER"
  cleanup_launcher_temp
  cleanup_discard
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
rm -f -- "$LAUNCHER_TMP"
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
mv -f -- "$LAUNCHER_TMP" "$LAUNCHER"

if [[ -d "$DISCARD_ROOT" ]]; then
  rm -rf -- "$DISCARD_ROOT"
fi
if [[ -d "$BACKUP_ROOT" ]]; then
  mv "$BACKUP_ROOT" "$DISCARD_ROOT"
else
  rm -f -- "$FRESH_MARKER"
fi
cleanup_discard || true

echo
echo "Sthang Studio is installed."
echo "Open it from: $LAUNCHER"
echo "You can delete the downloaded setup folder now."
