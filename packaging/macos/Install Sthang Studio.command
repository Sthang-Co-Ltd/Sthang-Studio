#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES="$ROOT/Sthang Studio Files"
INSTALLER="$FILES/scripts/install-release-package-macos.sh"

if [[ ! -f "$INSTALLER" ]]; then
  echo
  echo "Sthang Studio setup files are missing."
  echo "Extract the entire downloaded ZIP first, then open Install Sthang Studio.command again."
  echo
  read -r -p "Press Return to close..." _
  exit 1
fi

echo
echo "=== Sthang Studio Setup ==="
echo "Preparing Sthang Studio for this Mac..."
echo

if ! bash "$INSTALLER" "$FILES"; then
  echo
  echo "Sthang Studio setup did not finish successfully."
  echo "Keep this window open and use the message above to retry."
  echo
  read -r -p "Press Return to close..." _
  exit 1
fi

echo
read -r -p "Press Return to close setup..." _
