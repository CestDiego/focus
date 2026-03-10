# PRD: Frontmost App Tracking

**Status:** Draft
**Priority:** Medium
**Author:** Diego
**Created:** 2026-03-10

## Update Log

- 2026-03-10: Initial draft — define frontmost app tracking for distraction awareness signal in ModeEngine.

---

## Problem

Focus tracks sessions, tasks, and self-reports — but it has no visibility into what the user is actually doing on their machine. ModeEngine currently decides cognitive mode based only on session duration and self-reported mood. It cannot distinguish between a user deep in VS Code for 90 minutes and a user who alt-tabbed to Twitter 40 minutes ago.

Without this signal, ModeEngine has a blind spot: a session can appear "focused" when the user has been scrolling Reddit for the last 20 minutes.

## Solution

Use `NSWorkspace` notifications to observe frontmost application changes. Log each app activation to a local SQLite table. Classify apps into productivity categories and feed the classification distribution into ModeEngine as a new evaluation signal.

This is a lightweight, privacy-respecting approach — no window titles, no URLs, no screenshots. Just bundle IDs and app names.

## Requirements

### 1. AppTracker class

Create `Sources/Focus/AppTracker.swift` with a singleton `AppTracker` class that:

- Observes `NSWorkspace.didActivateApplicationNotification` via `NSWorkspace.shared.notificationCenter`.
- On each notification, extracts `bundleIdentifier` and `localizedName` from the `NSRunningApplication` in the notification's `userInfo`.
- Writes a row to the `app_log` table via `Store`.
- Starts/stops alongside `ModeEngine` (call from `FocusApp` init or similar).

### 2. Database: `app_log` table

Add a new GRDB migration (`v3-app-tracking`) to create:

```sql
CREATE TABLE app_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundleId TEXT NOT NULL,
    appName TEXT NOT NULL,
    activatedAt TEXT NOT NULL  -- ISO 8601
);
```

Add a corresponding `AppLogEntry` model struct conforming to `Codable, FetchableRecord, MutablePersistableRecord`.

### 3. App categories

Define a static dictionary mapping bundle ID prefixes/exact matches to categories:

```swift
enum AppCategory: String {
    case productive
    case neutral
    case distracting
}
```

Initial classification:

| Category      | Apps                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `productive`  | Terminal, VS Code, Xcode, Cursor, iTerm2, Warp, Alacritty, Kitty, Nova, Zed, JetBrains IDEs |
| `neutral`     | Finder, Preview, Notes, Calendar, System Settings, Activity Monitor, Slack, Discord      |
| `distracting` | Twitter/X, Safari*, Chrome*, Reddit, YouTube, TikTok, Instagram, Facebook                |

*Safari and Chrome are classified as `neutral` by default since we cannot inspect URLs. They are only `distracting` if we add a future URL-aware signal (explicitly out of scope — see Non-goals).

Hard-coded in a `[String: AppCategory]` dictionary keyed by bundle ID. Unknown apps default to `neutral`.

### 4. ModeEngine integration

Add a new evaluation step in `ModeEngine.evaluate()`:

1. Query `app_log` for entries in the last 10 minutes.
2. Compute time-weighted category distribution (each app activation is assumed active until the next activation).
3. If `distracting` share > 60% of the last 10 minutes → set mode to `"grounding"` with reason `"High distraction: {top_app} and others"`.
4. This signal should be lower priority than a recent self-report (preserve existing 300s self-report override) but higher priority than the basic session-duration heuristic.

### 5. Store helpers

Add to `Store.swift`:

- `logAppActivation(bundleId:appName:)` — insert into `app_log`.
- `recentAppLog(minutes:)` → `[AppLogEntry]` — fetch entries from the last N minutes, ordered by `activatedAt`.

### 6. Privacy controls

- The feature must be toggleable via a `UserDefaults` boolean (`appTrackingEnabled`, default `true`).
- When disabled, `AppTracker` unsubscribes from notifications and no rows are written.
- Add a menu item in the popover or settings to toggle this.
- On disable, do NOT delete existing data — let the user decide.

## Non-goals

- **No browser URL tracking.** We do not inspect URLs or page titles. Browsers are classified by their bundle ID alone. This is a deliberate privacy boundary.
- **No screenshot-based analysis.** No OCR, no vision models, no screen recording.
- **No user-configurable categories** in this iteration. The dictionary is hard-coded. A future PRD can add a settings UI.
- **No cross-device sync.** Data stays in `~/.config/focus/focus.db`.

## Technical Notes

- `NSWorkspace.didActivateApplicationNotification` delivers a `Notification` whose `userInfo?[NSWorkspace.applicationUserInfoKey]` is an `NSRunningApplication`.
- `NSRunningApplication.bundleIdentifier` returns `String?` (nil for some system processes — skip those).
- `NSRunningApplication.localizedName` returns `String?`.
- No special entitlements or permissions required — this is standard AppKit API available to all macOS apps.
- The 30s ModeEngine timer is sufficient for evaluating the distraction signal; no need for a separate timer.

## Privacy Consideration

This feature records which applications the user brings to the foreground. While it stores only bundle IDs and app names (no window content, no URLs, no keystrokes), it still constitutes activity tracking and must be:

1. **Disclosed** — the first time the feature activates, show a brief explanation of what is tracked and why.
2. **Easy to disable** — a single toggle, accessible from the menu bar popover.
3. **Local only** — data never leaves the machine. No telemetry, no cloud sync.

## Open Questions

- Should we expose app usage stats in the popover UI (e.g., "Today: 4h productive, 1h distracting")? Useful but adds UI scope.
- Should `app_log` rows be pruned after N days to limit DB growth? Probably yes — suggest 30-day retention.
- Should idle time (screen locked, no app switch for >5 min) count as its own category? Pairs with the planned idle detection feature.
