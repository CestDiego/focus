# PRD: Session History with Before/During/After Lifecycle View

**Status:** Proposed
**Priority:** Medium — enables reflection, which is key to the before/during/after vision
**Author:** Diego

## Update Log

- 2026-03-10: Initial draft (Focus only shows active sessions; no way to review past work or reflect on session lifecycles)

## Problem

Focus tracks cognitive state across AI coding sessions, but only shows what's happening *right now*. Once a session ends — whether completed, abandoned, or redefined — it disappears from the UI entirely.

This creates several gaps:

1. **No reflection.** The before/during/after lifecycle is central to Focus's design (trigger → tasks → end reason), but the user can never actually *see* this lifecycle after the fact. The "after" phase is invisible.
2. **No pattern recognition.** A developer can't see that they abandon sessions every afternoon, or that Claude Code sessions tend to be shorter than OpenCode ones, or that their completion rate has been dropping.
3. **No sense of progress.** After a long day of work across multiple sessions, there's nothing to show for it. The popover is empty or shows only the current session.
4. **Wasted data.** The database stores everything — goals, triggers, tasks, end reasons, durations — but none of it surfaces after the session ends.

## Solution

Add a session history section to the existing popover UI, below the active sessions area. Show completed sessions from the last 7 days, grouped by day, with summary statistics and expandable detail views that reveal the full before/during/after lifecycle of each session.

### Information Architecture

```
┌─────────────────────────────────────┐
│ ● FOCUSED          2 sessions       │  ← existing mode header
├─────────────────────────────────────┤
│ [active session cards]              │  ← existing
├─────────────────────────────────────┤
│ [mood buttons]                      │  ← existing
├─────────────────────────────────────┤
│ TODAY  3 sessions · 4h 12m · 78%    │  ← new: summary stats
├─────────────────────────────────────┤
│ ▸ focus · claude-code · 1h 23m      │  ← new: collapsed history card
│   "Build session history view"      │
│   ■ completed · 5/8 tasks           │
│                                     │
│ ▾ orchestration · opencode · 45m    │  ← new: expanded history card
│   ┌ BEFORE ────────────────────┐    │
│   │ trigger: PR review needed  │    │
│   ├ DURING ────────────────────┤    │
│   │ ✓ Review auth changes      │    │
│   │ ✓ Fix token refresh bug    │    │
│   │ ○ Update tests             │    │
│   ├ AFTER ─────────────────────┤    │
│   │ abandoned · 3:42 PM        │    │
│   └────────────────────────────┘    │
├─────────────────────────────────────┤
│ YESTERDAY  5 sessions · 6h · 82%   │
│ ▸ ...                               │
├─────────────────────────────────────┤
│ focus                          Quit │  ← existing footer
└─────────────────────────────────────┘
```

### Summary Stats Bar

A single-line stats bar appears at the top of the history section, showing today's numbers:

- **Sessions count:** total completed sessions today
- **Focused time:** sum of all session durations today
- **Completion rate:** percentage of tasks marked "completed" across today's sessions (completed tasks / total tasks)

Format: `TODAY  3 sessions · 4h 12m · 78%`

### History Cards (Collapsed)

Each completed session shows a compact card with:

- **Project name** (from `projectName`)
- **Source badge** (claude-code, opencode, mcp, manual) with color coding matching existing `sourceColor` function
- **Duration** (computed from `startedAt` / `endedAt`)
- **Goal** (from `goal`, 2-line max)
- **End reason indicator** with color coding:
  - `completed` → green accent
  - `abandoned` → amber accent
  - `redefined` → blue accent
- **Task completion ratio** (e.g., "5/8 tasks") — count of completed tasks vs total tasks for that session

### History Cards (Expanded)

Tapping a card expands it to show the full before/during/after lifecycle:

- **BEFORE section:** The `trigger` field — what prompted the session to start.
- **DURING section:** Full task list with status icons (matching existing `statusIcon` / `statusColor` patterns). Show all tasks, not just the first 6.
- **AFTER section:** End reason + end timestamp. Format: `completed · 3:42 PM`

### Day Grouping

Sessions are grouped under day headers:

- `TODAY` — sessions ending today
- `YESTERDAY` — sessions ending yesterday
- `Mon, Mar 8` — named day format for older dates
- Show last 7 days. If a day has no sessions, omit it (no empty day headers).

### Color Coding

End reason colors appear as a subtle left-border accent or small indicator dot on each history card:

| End Reason | Color | Meaning |
|------------|-------|---------|
| `completed` | Green (`.green`) | Session goals were met |
| `abandoned` | Amber (`.orange`) | Session was dropped without completion |
| `redefined` | Blue (`.blue`) | Session scope was changed, spawned new work |

These colors align with the existing design language: green = good/done, orange = warning/attention, blue = informational/transition.

## Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | History section in popover below active sessions and mood buttons | Scrollable, shares popover with existing content |
| 2 | Show last 7 days of completed sessions | Sessions where `endedAt IS NOT NULL` |
| 3 | Group sessions by day with day headers | TODAY, YESTERDAY, then named days |
| 4 | Summary stats bar for today | Session count, total duration, task completion % |
| 5 | Collapsed card: project, source badge, duration, goal, end reason, task ratio | Consistent with existing session card styling |
| 6 | Expandable detail view with before/during/after sections | Use `DisclosureGroup` or similar |
| 7 | Before section shows trigger | From `trigger` field |
| 8 | During section shows full task list with statuses | Reuse existing task rendering patterns |
| 9 | After section shows end reason + end time | Human-readable time format |
| 10 | Color coding for end reasons | Green/amber/blue as specified |
| 11 | Monospaced typography throughout | `.system(design: .monospaced)` matching existing UI |
| 12 | Popover remains usable height | ScrollView with reasonable max height |

## Non-Goals

- **No editing of past sessions.** History is read-only. If we add editing later, it would be a separate feature.
- **No export functionality.** No CSV, JSON, or clipboard export of session data. Future feature.
- **No charts or graphs.** The summary stats bar gives quick numbers, but we're not building visualizations yet. A future "insights" view could add sparklines, heatmaps, etc.
- **No filtering or search.** Show the last 7 days chronologically. Filtering by project, source, or end reason is a future enhancement.
- **No notifications or alerts.** No "you abandoned 3 sessions today" nudges. Just data.

## Technical Notes

### GRDB Queries

Add new query methods to `Store.swift`:

```swift
/// Fetch completed sessions for the last N days, ordered by endedAt DESC
func completedSessions(days: Int = 7) -> [FocusSession] {
    // WHERE endedAt IS NOT NULL
    //   AND endedAt >= date('now', '-7 days')
    // ORDER BY endedAt DESC
}

/// Fetch task completion stats for a session
func taskStats(sessionId: Int64) -> (completed: Int, total: Int) {
    // COUNT(*) and COUNT(CASE WHEN status = 'completed')
}

/// Today's summary: session count, total duration, completion rate
func todaySummary() -> (sessions: Int, totalMinutes: Int, completionRate: Double) {
    // Aggregate query over today's completed sessions
}
```

Date filtering should use SQLite date functions against the ISO 8601 strings stored in `startedAt` / `endedAt`. Example: `endedAt >= datetime('now', '-7 days')`.

### SwiftUI Structure

- Add a `HistorySection` view below the existing mood buttons section in `ContentView.swift`.
- Use `DisclosureGroup` for expandable session cards — it provides the collapse/expand toggle natively.
- Wrap the entire content (active sessions + history) in a single `ScrollView` to keep the popover height bounded.
- Consider bumping the popover `maxHeight` from the current implicit limit if needed, but keep it reasonable (~500-600pt max).

### ViewModel Updates

Extend `ContentViewModel` to include:

- `@Published var completedSessions: [FocusSession]`
- `@Published var todayStats: (sessions: Int, totalMinutes: Int, completionRate: Double)`
- A helper to group sessions by calendar day
- A helper to compute duration between `startedAt` and `endedAt`

The existing 2-second refresh timer can also update history data, though a longer interval (e.g., 10 seconds) would be fine for historical data since it changes less frequently.

### Performance

- 7 days of sessions is unlikely to exceed ~50-100 rows, so no pagination needed initially.
- Fetch tasks on-demand when a card is expanded rather than eagerly loading all tasks for all historical sessions.
- Consider a separate slower timer for history refresh (10s vs 2s for active sessions).

## Acceptance Criteria

1. When no sessions are active, the history section still appears showing past sessions.
2. Completed sessions from the last 7 days appear grouped by day with correct headers.
3. Each history card shows project name, source badge, duration, goal, end reason indicator, and task completion ratio.
4. Tapping a history card expands it to show the before/during/after lifecycle view.
5. The before section shows the session's trigger.
6. The during section shows the full task list with correct status icons and colors.
7. The after section shows the end reason and end time.
8. Color coding correctly reflects end reason: green for completed, amber for abandoned, blue for redefined.
9. Summary stats bar shows today's session count, total focused time, and task completion percentage.
10. Days with no completed sessions are not shown (no empty headers).
11. The popover remains scrollable and doesn't exceed a reasonable height.
12. Typography is monospaced throughout, consistent with existing UI.
13. History data refreshes automatically (timer-driven, like active sessions).
