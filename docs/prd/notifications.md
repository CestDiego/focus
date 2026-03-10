# PRD: macOS Notifications for Proactive Cognitive Nudges

**Status:** Draft
**Priority:** Medium — depends on idle detection and app tracking for meaningful triggers
**Author:** Diego
**Date:** 2026-03-10

## Update Log

- 2026-03-10: Initial draft (Focus can't proactively reach the user; needs gentle notifications for key transitions)

## Problem

Focus only communicates when the user actively clicks the menu bar icon. The app has no way to proactively reach the user when their cognitive mode changes or when a nudge would be helpful.

This means:
- A user who transitions to `grounding` mode gets no prompt to actually ground themselves.
- A user who has been `unfocused` for 15+ minutes gets no reminder to re-engage.
- A user deep in a 2+ hour focused session gets no encouragement to take a break.
- When a session ends via an external tool (MCP), the user may not notice.

The menu bar icon changes, but icons are easy to miss — especially when the user is heads-down or away from the screen. Focus has useful state transitions happening in the background with no channel to surface them.

## Solution

Use the macOS `UserNotifications` framework (`UNUserNotificationCenter`) to send gentle, well-timed notifications for key cognitive transitions and nudges. Notifications are compassionate in tone — they suggest, they don't nag. Rate limiting and Do Not Disturb integration prevent annoyance.

The notification system is a thin layer on top of ModeEngine's existing evaluation cycle and session lifecycle events. It observes state changes and decides whether a notification is warranted, respecting rate limits and user preferences.

## Requirements

### R1: Notification triggers

Four notification types, each tied to a specific state transition or milestone:

| Trigger | Condition | Title | Body | Action |
|---|---|---|---|---|
| Mode → grounding | ModeEngine sets mode to `grounding` | Time to check in | Hey, how are you feeling? Might be time for a quick reset. | "Start breathing exercise" |
| Extended unfocused | Mode has been `unfocused` for >15 minutes continuously | Been a while | You've been away for a while. Ready to refocus? | "Open Focus" |
| Long session | Session has been in `focused` mode for >2 hours continuously | Nice run! | Nice run! Consider a break. 🧘 | "Open Focus" |
| Session ended | Session ended by an external tool (MCP `session_end`) | Session ended | Session on {project} ended ({reason}). | "Open Focus" |

All notification copy should be compassionate, not nagging. The tone is a gentle friend, not a productivity coach.

### R2: Notification permission

- Request `UNUserNotificationCenter` authorization on first launch, using `.alert`, `.sound`, and `.badge` options.
- If the user denies permission, notifications silently degrade — no repeated prompts, no error states. The rest of the app works identically.
- Log the authorization result for debugging.

### R3: macOS Do Not Disturb / Focus mode integration

- Use the default `UNUserNotificationCenter` delivery path. macOS automatically suppresses notifications when the user has Do Not Disturb or a system Focus mode active.
- No special handling needed — this is built into `UserNotifications`. Do not attempt to detect or work around DND state.

### R4: Rate limiting

- Maximum 1 notification per 10 minutes, globally across all trigger types.
- Track the timestamp of the last delivered notification in memory (no persistence needed — rate limit resets on app restart, which is fine).
- If a notification is suppressed by the rate limit, log it at debug level but do not queue it for later delivery.

### R5: Notification actions

Each notification should include interactive actions via `UNNotificationCategory`:

- **All notifications**: "Open Focus" action (brings the popover/app to foreground) and default dismiss.
- **Grounding transition**: Additional "Start breathing exercise" action that opens the grounding exercises view.

Register notification categories and action identifiers at app startup. Handle action responses via `UNUserNotificationCenterDelegate`.

### R6: User preference to disable

- Add a "Notifications" toggle (or "Enable Notifications" / "Disable Notifications" menu item) to the existing menu bar menu.
- Store the preference in `UserDefaults` under key `notificationsEnabled` (default: `true`).
- When disabled, skip all notification delivery. The toggle controls Focus's own notification logic, independent of macOS system notification permissions.

### R7: `NotificationManager` class

Create a `NotificationManager` (or similar) that encapsulates all notification logic:

- Owns the `UNUserNotificationCenter` delegate.
- Exposes methods for each trigger type: `notifyGrounding()`, `notifyExtendedUnfocused()`, `notifyLongSession(duration:)`, `notifySessionEnded(project:reason:)`.
- Checks rate limit and user preference before each delivery.
- Registers categories and handles action responses.
- Called from ModeEngine (for mode transitions) and session lifecycle (for session end).

## Non-Goals

- **Sound customization.** Use the default notification sound. No custom sounds, no sound selection UI.
- **Notification scheduling.** All notifications are immediate, triggered by state changes. No time-based scheduling or recurring reminders.
- **Notification history view.** No in-app log of past notifications. macOS Notification Center already provides this.
- **Granular per-notification-type toggles.** v1 is a single on/off switch. Per-type configuration is a future enhancement if needed.
- **Custom notification UI (UNNotificationContentExtension).** Standard system notifications are sufficient.

## Dependencies

- **Grounding exercises feature**: The "Start breathing exercise" notification action needs a grounding exercises view to navigate to. If this feature isn't built yet, the action can open the main Focus popover as a fallback.
- **Idle detection** (see `idle-detection.md`): Richer idle signals make the "extended unfocused" and "grounding" triggers more meaningful. Without idle detection, these triggers fire based on session-duration heuristics alone, which are less accurate.
- **App tracking** (future): Knowing which app is in the foreground would enable smarter trigger logic (e.g., don't nudge during a video call). Not a blocker, but would improve notification relevance.

## Technical Notes

### UserNotifications setup

```swift
import UserNotifications

// Request permission (call once, e.g., in AppDelegate or app init)
UNUserNotificationCenter.current().requestAuthorization(
    options: [.alert, .sound, .badge]
) { granted, error in
    // Log result; no retry if denied
}

// Register categories at startup
let openAction = UNNotificationAction(
    identifier: "OPEN_FOCUS",
    title: "Open Focus",
    options: .foreground
)
let breathingAction = UNNotificationAction(
    identifier: "START_BREATHING",
    title: "Start breathing exercise",
    options: .foreground
)
let groundingCategory = UNNotificationCategory(
    identifier: "GROUNDING",
    actions: [breathingAction, openAction],
    intentIdentifiers: []
)
let defaultCategory = UNNotificationCategory(
    identifier: "DEFAULT",
    actions: [openAction],
    intentIdentifiers: []
)
UNUserNotificationCenter.current().setNotificationCategories([
    groundingCategory, defaultCategory
])
```

### Integration points

- **ModeEngine.evaluate()**: After updating the mode, check if the new mode warrants a notification. Call `NotificationManager.shared.notifyGrounding()` etc.
- **Session lifecycle**: When a session ends via MCP, call `NotificationManager.shared.notifySessionEnded(project:reason:)`.
- **Long session detection**: Either check elapsed focused time in ModeEngine's 30-second cycle, or use a separate timer. The 30-second cycle is simpler — check if the active session's focused duration exceeds 2 hours.

### Rate limit implementation

```swift
private var lastNotificationTime: Date?

private func canDeliver() -> Bool {
    guard UserDefaults.standard.bool(forKey: "notificationsEnabled") else {
        return false
    }
    guard let last = lastNotificationTime else { return true }
    return Date().timeIntervalSince(last) >= 600 // 10 minutes
}
```

## Priority

**Medium.** Notifications are the first step toward Focus being genuinely proactive rather than passive. However, the value of notifications depends heavily on the quality of the triggers — and the best triggers come from idle detection and app tracking, which are not yet implemented. Shipping notifications before those signals exist risks sending poorly-timed nudges, which would train users to ignore or disable them. Build this after idle detection lands.
