# PRD: Pattern Learning & Weekly Digest

**Status:** Draft
**Priority:** Low
**Author:** Diego
**Created:** 2026-03-10

## Update Log

- 2026-03-10: Initial draft — define pattern learning system for surfacing cognitive insights from historical session data.

---

## Problem

Focus collects a growing dataset about the user's cognitive patterns — sessions with goals and outcomes, mode transitions, mood self-reports, grounding exercises, and frontmost app usage. But none of this data feeds back into the experience. Every day starts from zero: no personalization, no insights, no memory of what worked yesterday.

The user has no way to answer questions like:
- "Am I more focused in the morning or evening?"
- "Which grounding exercise actually helps me refocus?"
- "How has my focus improved (or degraded) over the past month?"
- "Are there projects or times of day where I consistently lose focus?"

The data exists. The analysis doesn't.

## Solution

Analyze historical data in the local SQLite database to surface patterns and personalize the Focus experience. Start with simple heuristics and SQL aggregate queries — no ML, no external dependencies. Leave room for more sophisticated analysis later.

The system has two output surfaces:
1. **MCP tool** (`focus_weekly_digest`) — returns structured insights for AI coding assistants to reference mid-session.
2. **Popover UI** — shows streak count and productive hours inline.

## Requirements

### 1. Weekly digest (MCP tool)

Add a `focus_weekly_digest` MCP tool that returns a structured summary of the past 7 days. The tool takes no arguments and returns:

| Metric | Source | Query |
|--------|--------|-------|
| Total focused time | `sessions` | `SUM(endedAt - startedAt)` where `endReason = 'completed'` or session had meaningful duration |
| Session count | `sessions` | `COUNT(*)` where `startedAt` in last 7 days |
| Completion rate | `sessions` | `completed / total` for sessions with an `endReason` |
| Most common end reasons | `sessions` | `GROUP BY endReason ORDER BY COUNT(*) DESC` |
| Most productive hour | `sessions` + `mode_log` | Hour-of-day with highest ratio of `focused` mode entries |
| Most used grounding exercises | (future `exercises` table) | `GROUP BY exerciseType ORDER BY COUNT(*) DESC` |
| Completion rate trend | `sessions` | Compare current week's completion rate to previous week |

Return format: JSON object with labeled sections. Example:

```json
{
  "period": "2026-03-03 to 2026-03-09",
  "totalFocusedMinutes": 847,
  "sessionCount": 23,
  "completionRate": 0.74,
  "completionRatePrevWeek": 0.68,
  "topEndReasons": ["completed", "abandoned", "redefined"],
  "mostProductiveHour": 10,
  "streak": { "current": 5, "longest": 12 },
  "topGroundingExercises": [],
  "blockerPatterns": []
}
```

### 2. Best grounding technique

Track which grounding exercises correlate with successful refocusing. A "successful refocus" is defined as:

- A `mode_log` entry with `mode = 'grounding'`
- Followed by a `mode_log` entry with `mode = 'focused'`
- Where the focused entry occurs within 10 minutes of the grounding entry

For each exercise type, compute a success rate: `successful_refocuses / total_uses`. Surface the most effective exercise first when presenting grounding options in the popover.

**Depends on:** Grounding exercises feature (not yet implemented). Until that table exists, this section of the digest returns an empty array.

### 3. Productive hours

Identify which hours of the day the user tends to be most focused:

1. Query `mode_log` for all `focused` entries.
2. Extract the hour from `detectedAt`.
3. Weight by duration (time until the next mode entry or session end).
4. Rank hours by total weighted focused time.

Surface as a simple bar/heat visualization in a future history view. For the MCP digest, return the single most productive hour (0–23).

Optionally cross-reference with `app_log` to confirm productive hours align with productive app usage (high `productive` category ratio during those hours).

### 4. Blocker identification

Detect recurring patterns in abandoned sessions:

1. Query `sessions` where `endReason = 'abandoned'`.
2. Group by: hour of day, `projectName`, most recent `self_reports.mood` before session end.
3. If 3+ abandoned sessions share a pattern (same project + similar time-of-day bucket), flag it.

Output a natural-language pattern string:
> "You tend to lose focus on **{project}** after 5pm — consider scheduling it for mornings."

Include in the `blockerPatterns` array of the weekly digest. Show at most 3 patterns, ranked by frequency.

### 5. Streak tracking

Track consecutive calendar days with at least one session where `endReason = 'completed'`.

- **Current streak:** consecutive days ending today (or yesterday, to be forgiving of timezone edge cases).
- **Longest streak:** all-time maximum.

Display in the popover, below the current mode indicator. Format: "5-day streak" or a subtle flame/checkmark icon with the count.

Compute via SQL: select distinct dates from `sessions` where `endReason = 'completed'`, then walk backward from today counting consecutive days.

### 6. Privacy

All analysis runs locally over `~/.config/focus/focus.db`. No data leaves the machine. No telemetry. No cloud sync. The digest is returned only to the local MCP client that requested it.

## Non-goals

- **No ML models or on-device inference in v1.** All insights come from SQL aggregates and simple heuristics. ML-based pattern detection (e.g., predicting when focus will drop) is a future consideration.
- **No cloud sync.** Data stays local. No server-side aggregation.
- **No comparison with other users.** No benchmarks, no leaderboards, no "you're in the top 10% of focused developers."
- **No real-time notifications.** The digest is pull-based (requested via MCP tool or shown when popover opens). No push alerts like "you're losing focus."

## Dependencies

| Dependency | Status | Impact |
|-----------|--------|--------|
| Session history (`sessions` table) | Implemented | Required for digest, streaks, blockers |
| Mode log (`mode_log` table) | Implemented | Required for productive hours |
| Self-reports (`self_reports` table) | Implemented | Used in blocker identification |
| App tracking (`app_log` table) | PRD drafted | Enriches productive hours analysis |
| Grounding exercises | Not started | Required for best technique analysis |

Without grounding exercises and app tracking, the digest will have partial data. This is acceptable — each section degrades gracefully to empty/null when its data source doesn't exist yet.

## Technical Approach

### No new dependencies

All analysis is pure SQL over existing GRDB tables. No new Swift packages, no Python, no analytics frameworks.

### Compute on demand

Insights are not precomputed or cached. They are calculated:
- When `focus_weekly_digest` is called via MCP.
- When the popover opens (for streak count only — keep it fast).

For the popover, streak computation should complete in <50ms. The weekly digest can take up to 500ms since it's not blocking UI.

### MCP implementation

Add the tool in `mcp/index.ts`:

```typescript
server.tool("focus_weekly_digest", {}, async () => {
  // Run aggregate queries against focus.db
  // Return structured JSON
});
```

The MCP server already has read access to the database. Add helper SQL queries as functions.

### SQL sketch: productive hour

```sql
SELECT
  CAST(strftime('%H', detectedAt) AS INTEGER) AS hour,
  COUNT(*) AS focused_entries
FROM mode_log
WHERE mode = 'focused'
  AND detectedAt >= datetime('now', '-7 days')
GROUP BY hour
ORDER BY focused_entries DESC
LIMIT 1;
```

### SQL sketch: streak

```sql
SELECT DISTINCT DATE(startedAt) AS day
FROM sessions
WHERE endReason = 'completed'
ORDER BY day DESC;
```

Then walk the result set in application code, counting consecutive days from today.

### SQL sketch: blocker patterns

```sql
SELECT
  projectName,
  CASE
    WHEN CAST(strftime('%H', startedAt) AS INTEGER) < 12 THEN 'morning'
    WHEN CAST(strftime('%H', startedAt) AS INTEGER) < 17 THEN 'afternoon'
    ELSE 'evening'
  END AS timeBlock,
  COUNT(*) AS abandonCount
FROM sessions
WHERE endReason = 'abandoned'
  AND startedAt >= datetime('now', '-30 days')
  AND projectName IS NOT NULL
GROUP BY projectName, timeBlock
HAVING abandonCount >= 3
ORDER BY abandonCount DESC
LIMIT 3;
```

## Open Questions

- Should the digest be cached for a configurable TTL to avoid redundant computation if called multiple times in a session?
- Should streak tracking count "any session started" or strictly "at least one completed session" per day?
- Should we add a `focus_insights` MCP tool for ad-hoc queries ("when am I most productive?") separate from the structured weekly digest?
- What's the minimum data threshold before surfacing insights? (e.g., don't show "most productive hour" with only 3 data points.)
