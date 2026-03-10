# Focus

A Mac menu bar app that tracks what you're working on across all your coding sessions.

Every AI coding session (Claude Code, OpenCode, Cursor, etc.) registers its current project, goal, and task list via MCP. Focus aggregates everything into a single glanceable indicator so you always know what's active, what's next, and whether you're drifting.

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   Claude Code    │  │    OpenCode       │  │  Any MCP Client  │
│   (PostToolUse   │  │   (plugin hook    │  │                  │
│    hook + MCP)   │  │    + MCP)         │  │   (MCP only)     │
└────────┬─────────┘  └────────┬──────────┘  └────────┬─────────┘
         │                     │                       │
         ▼                     ▼                       ▼
    ┌────────────────────────────────────────────────────────┐
    │              ~/.config/focus/focus.db                   │
    │              (SQLite · WAL mode)                        │
    └────────────────────────┬───────────────────────────────┘
                             │
                             ▼
                  ┌────────────────────────┐
                  │  Focus (menu bar)      │
                  │  🟢 2 sessions         │
                  └────────────────────────┘
```

## Quick Start

### Prerequisites

- macOS 13+ (Ventura or later)
- Xcode Command Line Tools (`xcode-select --install`)
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)

### 1. Build the menu bar app

```bash
git clone https://github.com/diegofcornejo/focus.git
cd focus
swift build
```

### 2. Install MCP server dependencies

```bash
cd mcp && bun install && cd ..
```

### 3. Run it

```bash
.build/debug/Focus &
```

You'll see a `◌ focus` indicator in your menu bar. Click it to open the popover.

### 4. Connect your coding tools

#### Option A: MCP Server (works with any MCP client)

Add to your tool's MCP config:

**Claude Code** — add to `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "focus": {
      "command": "bun",
      "args": ["run", "/path/to/focus/mcp/index.ts"]
    }
  }
}
```

**OpenCode** — add to `~/.config/opencode/opencode.json` under `"mcp"`:
```json
{
  "mcp": {
    "focus": {
      "type": "local",
      "command": ["bun", "run", "/path/to/focus/mcp/index.ts"]
    }
  }
}
```

**Any other MCP-compatible client** — point it at `bun run /path/to/focus/mcp/index.ts` via stdio transport.

#### Option B: Claude Code PostToolUse Hook (automatic TodoWrite sync)

```bash
cp scripts/sync-tasks.py ~/.claude/hooks/sync-tasks.py
```

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "TodoWrite",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/sync-tasks.py",
        "timeout": 5
      }]
    }]
  }
}
```

#### Option C: OpenCode Plugin (automatic todowrite sync)

Copy the plugin file:
```bash
cp scripts/opencode-plugin.ts ~/.config/opencode/plugin/focus.ts
```

OpenCode auto-discovers plugins in that directory on next launch.

## MCP Tools

Once connected, your coding sessions have these tools:

| Tool | Description |
|---|---|
| `focus_session_start` | Register a new focus session (project, goal, why, trigger) |
| `focus_tasks_sync` | Sync the current task list for a session |
| `focus_session_end` | End a session (completed / abandoned / redefined) |
| `focus_mode_set` | Set cognitive mode: `focused`, `grounding`, or `unfocused` |
| `focus_status` | Get state of all active sessions across all tools |

### Example

From any MCP-connected session:

```
"Start a focus session for this project with goal 'Build auth flow' 
 and why 'Ship login by Friday'"

→ calls focus_session_start(projectDir, goal, why, source)
→ menu bar turns 🟢 and shows the session
```

## Cognitive Modes

Focus tracks three working modes:

| Mode | Icon | Meaning |
|---|---|---|
| **Focused** | 🟢 | Actively working, clear goal, making progress |
| **Grounding** | 🟡 | Transitioning to focus — addressing blockers, managing energy |
| **Unfocused** | ◌ | Drifting, fatigued, or between sessions |

The menu bar popover includes mood check-in buttons. When you report feeling stuck, Focus suggests grounding before jumping back into code.

## Architecture

```
focus/
├── Package.swift                 # Swift Package Manager
├── Sources/Focus/
│   ├── main.swift                # Entry point
│   ├── AppDelegate.swift         # Menu bar + popover
│   ├── Store.swift               # GRDB · SQLite · models · queries
│   ├── ModeEngine.swift          # Rules-based mode inference
│   └── ContentView.swift         # SwiftUI popover (multi-session)
├── mcp/
│   ├── package.json              # MCP server deps
│   └── index.ts                  # MCP server (5 tools, bun:sqlite)
└── scripts/
    ├── sync-tasks.py             # Claude Code PostToolUse hook
    └── opencode-plugin.ts        # OpenCode plugin
```

### Data

All state lives in `~/.config/focus/focus.db` (SQLite, WAL mode). Multiple processes can read/write concurrently. The menu bar app polls every 2 seconds.

**Tables:** `sessions`, `tasks`, `mode_log`, `self_reports`

Each session tracks: `source` (which tool), `sourceSessionId`, `projectDir`, `goal`, `why`, `trigger`, `phase` (before/during/after).

## Run on Login

To start Focus automatically:

1. Build a release: `swift build -c release`
2. Copy to Applications: `cp -r .build/release/Focus /usr/local/bin/focus`
3. Add to Login Items: System Settings → General → Login Items → add `focus`

Or create a LaunchAgent — see the wiki for details.

## License

MIT
