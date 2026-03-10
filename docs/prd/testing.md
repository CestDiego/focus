# PRD: Test Suites & CI Pipeline

**Status:** Draft
**Priority:** Medium
**Author:** Diego
**Created:** 2026-03-10

## Update Log

- 2026-03-10: Initial draft — define test strategy for MCP server, Swift app, Python hook, and CI pipeline.

---

## Problem

Focus currently has **zero test coverage**. There are no test targets in `Package.swift`, no test files for the MCP server, and no CI pipeline. Bugs are only caught through manual code review or discovered at runtime.

This has concrete consequences:

- **No refactoring confidence.** Changing `Store.swift` migrations, `ModeEngine` evaluation logic, or MCP tool handlers requires manually verifying every code path. This slows development and introduces risk.
- **Bugs ship silently.** Edge cases in the MCP server (duplicate session starts, ending non-existent sessions, empty task syncs) have no automated verification. The transactional task sync in `focus_tasks_sync` was never tested under concurrent access.
- **No regression gate.** Without CI, PRs merge without any automated check. A broken migration or invalid Zod schema change can land on `main` undetected.

## Solution

Add test suites for the three runtime components (MCP server, Swift app, Python hook) and a GitHub Actions CI pipeline to run them on every push and PR.

The approach prioritizes the MCP server (highest bug surface area, most active development) and focuses on unit/integration tests against isolated databases — no E2E integration between MCP and Swift, no UI tests.

## Requirements

### 1. MCP Server Tests (Highest Priority)

**Framework:** `bun test` (built-in, zero-config, already available in the runtime).

**Test location:** `mcp/__tests__/`

**Database strategy:** Each test file creates a temporary SQLite database via `bun:sqlite` with `new Database(":memory:")` or a temp file. The `initDb()` function in `mcp/index.ts` currently hardcodes the DB path — it must be refactored to accept an optional path/database argument for testability.

#### Required refactoring

Extract the database initialization and tool logic from `mcp/index.ts` so tests can call tool handlers directly without starting a full MCP server over stdio. Suggested approach:

- Extract `initDb(dbPath?: string)` to accept an optional path (default: `~/.config/focus/focus.db`).
- Extract tool handler functions (the async callbacks passed to `server.tool(...)`) into named, exported functions that accept `db: Database` as a parameter.
- Keep the server wiring (`new McpServer(...)`, `server.tool(...)`, transport) in `index.ts` as the entrypoint.

This does **not** change runtime behavior — only makes internals importable for tests.

#### Test cases

**Individual tool tests:**

| Tool | Test cases |
|------|------------|
| `focus_session_start` | Creates new session with all fields. Reuses existing session for same `projectDir`. Reuses by `sourceSessionId`. Updates `goal`/`why`/`trigger` on reuse. Rejects relative `projectDir`. |
| `focus_tasks_sync` | Syncs tasks to active session. Replaces previous tasks (not appends). Returns error when no active session. Handles empty task array. Default priority is `"medium"`. |
| `focus_session_end` | Ends session by `projectDir`. Ends by `sourceSessionId`. Sets `endedAt`, `endReason`, `phase`. Returns error for non-existent session. |
| `focus_mode_set` | Inserts mode log entry. Handles missing `reason`. |
| `focus_status` | Returns empty state when no sessions. Returns active sessions with task summaries. Excludes ended sessions. |

**Lifecycle integration tests:**

- Full lifecycle: `start` → `sync tasks` → `sync tasks` (replace) → `end` → verify final DB state.
- Overlapping sessions: start two sessions for different projects, verify `focus_status` returns both.
- Session reuse: start, end, start same project — should create a new session (not reuse ended one).

**Edge case tests:**

- Duplicate start: calling `focus_session_start` twice with same `projectDir` returns same `sessionId`.
- End non-existent: `focus_session_end` with unknown `projectDir` returns `isError: true`.
- Empty task sync: `focus_tasks_sync` with `tasks: []` should delete all tasks for the session.
- Relative path rejection: `focus_session_start` with `projectDir: "relative/path"` throws.

**Transactional integrity:**

- Verify that `focus_tasks_sync` deletes old tasks and inserts new ones atomically (no intermediate state where tasks are empty). Test by checking row count never drops to 0 during a sync that replaces N tasks with M tasks.

**Input validation:**

- `projectDir` must be absolute (tested above).
- `reason` must be one of the enum values in `focus_session_end`.
- `tasks[].status` must be a valid enum value.

### 2. Swift App Tests

**Framework:** XCTest (via `swift test`).

**Test location:** `Tests/FocusTests/`

**Package.swift change:** Add a `.testTarget`:

```swift
.testTarget(
    name: "FocusTests",
    dependencies: [
        .target(name: "Focus"),
        .product(name: "GRDB", package: "GRDB.swift")
    ]
)
```

> **Note:** The `Focus` target is currently `.executableTarget`. To make it importable by tests, it may need to be split into a library target (`FocusLib`) containing `Store.swift`, `ModeEngine.swift`, and models, with the executable target depending on the library. Evaluate during implementation.

**Database strategy:** In-memory GRDB database (`DatabaseQueue()` with no path argument) for full test isolation.

#### Store.swift tests

| Area | Test cases |
|------|------------|
| Migrations | `v1` creates all four tables. `v2-multi-session` adds `source` and `sourceSessionId` columns. Running migrations twice is idempotent. |
| CRUD | Insert and fetch `FocusSession`. Insert and fetch `TaskItem` with session FK. Insert and fetch `ModeEntry`. Insert and fetch `SelfReport`. |
| Queries | `currentSession()` returns most recent active session. `currentSession()` returns `nil` when all ended. `activeSessions()` returns multiple. `tasksForSession(_:)` ordering: `in_progress` first, then `pending`, then `completed`; within status, `high` before `medium` before `low`. `allActiveTasks()` excludes tasks from ended sessions. `currentMode()` returns latest. `latestSelfReport()` returns latest. |
| Writes | `addSelfReport(mood:)` persists. `updateMode(_:reason:)` persists. |
| Seed | `seedIfEmpty()` inserts seed data when empty. `seedIfEmpty()` is no-op when data exists. |

#### ModeEngine.swift tests

| Area | Test cases |
|------|------------|
| No session | Evaluates to `"unfocused"` with reason `"No active session"`. |
| Active session < 120m | Evaluates to `"focused"`. |
| Active session >= 120m | Evaluates to `"unfocused"` with check-in prompt. |
| Self-report override | `"stuck"` → `"grounding"`. `"good"` + active session → `"focused"`. `"redefine"` → `"grounding"`. |
| External mode protection | A mode set < 60s ago by an external source (reason not prefixed with `"Active session"` / `"No active"` / `"Session running"`) is not overwritten. |

### 3. Python Hook Test

**Framework:** `pytest` (or plain `unittest`).

**Test location:** `scripts/tests/test_sync_tasks.py`

#### Test cases

- Valid `TodoWrite` input on stdin → writes session and tasks to a temp SQLite database.
- Non-`TodoWrite` input (`tool_name` is different) → outputs `{}`, no DB writes.
- Invalid JSON on stdin → outputs `{}`, no crash.
- Empty `todos` array → creates session, deletes existing tasks.
- Existing session for same `projectDir` → reuses session, replaces tasks.

**Database strategy:** Override the DB path to a temp file (e.g., via environment variable or monkeypatch). The script currently hardcodes `~/.config/focus/focus.db` — a minor refactor to accept `FOCUS_DB_PATH` env var is needed.

### 4. CI Pipeline

**File:** `.github/workflows/test.yml`

**Trigger:** Push to `main`, pull requests to `main`.

**Jobs (matrix):**

| Job | Runner | Steps |
|-----|--------|-------|
| `mcp-server` | `ubuntu-latest` | Install Bun → `bun install` → `bun test` (working dir: `mcp/`) |
| `swift-app` | `macos-14` | `swift test` (root directory) |
| `python-hook` | `ubuntu-latest` | Set up Python 3.12 → `pip install pytest` (if needed) → `pytest scripts/tests/` |

**Notes:**
- Swift tests require macOS runner due to Foundation/AppKit dependencies.
- MCP server and Python hook tests can run on Linux (no macOS dependencies).
- Cache Bun dependencies and SPM `.build/` directory for speed.

## Non-Goals

- **No E2E MCP ↔ Swift integration tests.** The MCP server and Swift app share a SQLite database but run as separate processes. Testing this integration requires process orchestration that isn't worth the complexity yet.
- **No UI tests.** The menu bar app uses SwiftUI but has minimal interactive surface. UI testing would require XCUITest infrastructure for low value.
- **No performance benchmarks.** The database is small (dozens of rows) and performance is not a concern.
- **No snapshot/golden tests.** The MCP responses are simple JSON; assertion-based tests are sufficient.

## Success Criteria

1. `bun test` passes in `mcp/` with >90% line coverage of tool handler logic.
2. `swift test` passes with tests for all `Store` queries and `ModeEngine` evaluation paths.
3. `pytest scripts/tests/` passes with tests for valid/invalid input handling.
4. GitHub Actions workflow runs on every PR and blocks merge on failure.
5. All tests use isolated databases (no side effects on the real `~/.config/focus/focus.db`).

## Implementation Notes

- Start with MCP server tests — they cover the highest-risk code and require the least refactoring.
- The `initDb()` / tool handler extraction is the key prerequisite. Keep it as a focused refactor PR before adding tests.
- Swift test target may require splitting the executable into lib + executable. Evaluate whether `@testable import Focus` works with an executable target first (it does in some Swift versions but is fragile).
