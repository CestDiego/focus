#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# Focus — uninstaller
#
# Removes the LaunchAgent and binary. Source code is kept.
#
# Usage:
#   ./uninstall.sh
# ─────────────────────────────────────────────────────────

PLIST_LABEL="com.focus.app"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
FOCUS_BIN="/usr/local/bin/focus"

info()  { printf "\033[0;34m▸\033[0m %s\n" "$*"; }
ok()    { printf "\033[0;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "\033[0;33m!\033[0m %s\n" "$*"; }

info "Uninstalling Focus..."

# Unload the LaunchAgent
launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
ok "LaunchAgent unloaded (or was not loaded)"

# Remove the plist
rm -f "$PLIST_PATH"
ok "Removed $PLIST_PATH"

# Remove the binary
if [ -f "$FOCUS_BIN" ]; then
  rm -f "$FOCUS_BIN" 2>/dev/null || {
    warn "Cannot remove $FOCUS_BIN — trying with sudo"
    sudo rm -f "$FOCUS_BIN"
  }
  ok "Removed $FOCUS_BIN"
else
  ok "Binary already removed"
fi

echo ""
ok "Focus uninstalled."
