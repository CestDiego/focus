# PRD: LaunchAgent for Auto-Start on Login

**Status:** Proposed
**Priority:** High — foundational for always-on operation
**Author:** Diego

## Update Log

- 2026-03-10: Initial draft (Focus app doesn't survive reboots; need LaunchAgent for always-on cognitive tracking)

## Problem

Focus is a menu bar app that promises always-on cognitive state tracking across AI coding sessions. Today, it doesn't survive reboots. After every restart or logout, the user must manually launch the app. This breaks the core "always-on" contract — if Focus isn't running, sessions go untracked and the data has gaps.

A developer who forgets to start Focus after a reboot silently loses tracking for hours or days until they notice.

## Solution

Create a macOS LaunchAgent plist that auto-starts Focus on login. Integrate installation of the plist into the existing `install.sh` script so that any `install.sh` run also sets up auto-start. Provide an uninstall path to cleanly remove it.

### LaunchAgent Plist

File: `~/Library/LaunchAgents/com.focus.app.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.focus.app</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/focus</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/focus.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/focus.err.log</string>
</dict>
</plist>
```

Key settings:
- **`RunAtLoad: true`** — start automatically when the user logs in.
- **`KeepAlive: false`** — if the user intentionally quits Focus (e.g. via the menu bar), it stays quit. No forced restarts.
- **`ProgramArguments`** — points to `/usr/local/bin/focus`, the installed binary location from `install.sh`.
- **Log paths** — `/tmp/focus.{out,err}.log` for basic debugging. These are ephemeral and cleared on reboot.

### install.sh Changes

After the existing binary copy step, add:

1. Write (or overwrite) the plist to `~/Library/LaunchAgents/com.focus.app.plist`.
2. Run `launchctl unload` on the plist if it was previously loaded (ignore errors).
3. Run `launchctl load` on the new plist.
4. Print confirmation.

This must be **idempotent**: running `install.sh` multiple times should overwrite the plist and reload cleanly without errors or duplicate agents.

### Uninstall

Add an `uninstall.sh` script (or `install.sh --uninstall` flag) that:

1. `launchctl unload ~/Library/LaunchAgents/com.focus.app.plist` (ignore errors if not loaded).
2. `rm -f ~/Library/LaunchAgents/com.focus.app.plist`.
3. Optionally remove the binary from `/usr/local/bin/focus`.
4. Print confirmation.

## Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | Plist at `~/Library/LaunchAgents/com.focus.app.plist` | Standard user-level LaunchAgent location |
| 2 | `RunAtLoad: true` | Start on login |
| 3 | `KeepAlive: false` | Respect intentional quit |
| 4 | Binary path: `/usr/local/bin/focus` | Matches current `install.sh` |
| 5 | `install.sh` writes + loads the plist | Integrated into existing flow |
| 6 | Idempotent install | Safe to run multiple times |
| 7 | Uninstall path (`uninstall.sh` or `--uninstall`) | Clean removal of plist + unload |
| 8 | Basic log output to `/tmp/` | For debugging startup issues |

## Non-Goals

- **No GUI toggle** for enable/disable auto-start. That's a future enhancement if needed.
- **No `SMLoginItemSetEnabled` / Login Items API**. LaunchAgent is simpler, scriptable, and doesn't require app bundling or entitlements. It's the right tool for a CLI-installed menu bar app.
- **No `KeepAlive: true` / restart-on-crash**. Out of scope for v1. Can revisit if stability warrants it.

## Acceptance Criteria

1. After running `install.sh`, `launchctl list | grep com.focus.app` shows the agent loaded.
2. After a logout/login cycle, Focus is running without manual intervention.
3. Quitting Focus via the menu bar does **not** cause it to restart.
4. Running `install.sh` a second time completes without errors and the agent is still functional.
5. Running `uninstall.sh` (or `install.sh --uninstall`) removes the plist and unloads the agent.
6. After uninstall, a logout/login cycle does **not** start Focus.

## Implementation Notes

- Use `launchctl bootout gui/$(id -u)/com.focus.app 2>/dev/null || true` + `launchctl bootstrap gui/$(id -u) <plist>` for modern macOS (the `load`/`unload` subcommands are deprecated but still work; either approach is fine for now).
- The plist should be generated from `install.sh` rather than committed as a static file, since the binary path could theoretically vary.
- Consider printing a note if Focus is already running when install.sh loads the agent (to avoid confusing duplicate-process situations).
