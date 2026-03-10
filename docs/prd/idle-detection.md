# PRD: Idle Detection via IOKit

**Status:** Draft
**Priority:** Medium
**Author:** Diego
**Date:** 2026-03-10

## Update Log

- 2026-03-10: Initial draft (first "smart" behavior — make Focus aware of physical presence)

## Problem

Focus has no awareness of whether the user is physically at the computer. ModeEngine evaluates cognitive state every 30 seconds based on session duration and self-reports, but it has zero signal about actual presence. This leads to incorrect state: a session can show "focused" while the user has been AFK for 30 minutes. The menu bar indicator becomes meaningless if it doesn't reflect reality.

## Solution

Use IOKit's `HIDIdleTime` property to read the system-level input idle time (time since last keyboard/mouse/trackpad event). Integrate this reading into ModeEngine's existing 30-second evaluation cycle so that idle time downgrades cognitive mode automatically, and return-from-idle is logged.

This is the simplest possible presence signal — no camera, no microphone, no new permissions. IOKit `HIDIdleTime` works without entitlements on macOS.

## Requirements

### R1: `IdleDetector` class

Create a new `IdleDetector` class (or struct) in `Sources/Focus/IdleDetector.swift` that encapsulates the IOKit call:

- Use `IOServiceGetMatchingService` with `kIOHIDSystemClass` to get the HID system service.
- Read `HIDIdleTime` via `IORegistryEntryCreateCFProperty`.
- The returned value is in **nanoseconds**. Convert to seconds for consumers.
- Expose a single method: `func systemIdleTime() -> TimeInterval` (seconds).
- Handle the case where the IOKit service is unavailable (return `0` — assume active).

### R2: Idle thresholds

Two thresholds govern mode transitions:

| Idle duration | Mode transition | Reason string |
|---|---|---|
| > 5 minutes | → `grounding` | `"Idle detected"` |
| > 15 minutes | → `unfocused` | `"Extended idle"` |

These thresholds apply only when there is an active session. If there is no session, ModeEngine already sets `unfocused` — idle detection doesn't change that path.

### R3: ModeEngine integration

Modify `ModeEngine.evaluate()` to query `IdleDetector` as part of each 30-second cycle:

1. After the existing external-mode protection check (the `age < 60 && !isEngineMode` guard at line 31), read the current idle time.
2. If idle time exceeds thresholds, override the session-based mode with the idle-based mode and reason.
3. Idle-based mode should take precedence over session-duration logic but **not** over self-report overrides (self-reports still win within their 300s window).
4. Idle-set modes are "engine modes" — they should be overridable by the next evaluation cycle and should not trigger the 60-second external-mode protection.

### R4: Return-from-idle logging

When the user returns from an idle period:

- If the **previous** mode was set due to idle (reason contains `"Idle detected"` or `"Extended idle"`) and the current idle time has dropped below the 5-minute threshold, log a `mode_log` entry with reason `"Returned from idle"`.
- The mode on return should be re-evaluated normally (session-based logic determines if it's `focused`, `grounding`, or `unfocused`).

### R5: Respect external-mode protection

The existing 60-second protection for MCP-set and self-reported modes must be preserved. Idle detection must not override a mode that was set externally within the last 60 seconds. The current guard in `ModeEngine.evaluate()` already handles this — idle logic runs after this guard, so no special handling is needed beyond placing the idle check correctly.

## Non-Goals

- **Camera/microphone-based presence detection.** No use of AVFoundation or any sensor beyond HID idle time.
- **Activity tracking.** We do not record what the user was doing, which app was active, or any input content. We only read a single integer: time since last input event.
- **Configurable thresholds (v1).** Hardcode the 5-min and 15-min values. A future iteration may expose these as preferences.
- **Sleep/wake detection.** macOS sleep transitions are a separate concern. This PRD covers only HID idle time.

## Technical Notes

### IOKit API usage

```swift
import IOKit

func systemIdleTime() -> TimeInterval {
    let service = IOServiceGetMatchingService(
        kIOMainPortDefault,
        IOServiceMatching(kIOHIDSystemClass)
    )
    guard service != IO_OBJECT_NULL else { return 0 }
    defer { IOObjectRelease(service) }

    let key = "HIDIdleTime" as CFString
    guard let prop = IORegistryEntryCreateCFProperty(
        service, key, kCFAllocatorDefault, 0
    )?.takeRetainedValue() as? NSNumber else {
        return 0
    }
    // Value is in nanoseconds
    return prop.doubleValue / 1_000_000_000
}
```

- `kIOMainPortDefault` replaces the deprecated `kIOMasterPortDefault` on macOS 12+.
- No entitlements, no sandbox exceptions, no privacy prompts required.
- The value resets to 0 on any HID input event (keyboard, mouse, trackpad).

### Integration point in ModeEngine

The idle check slots into `evaluate()` between the external-mode guard and the session-duration logic. Pseudocode:

```
evaluate():
  if external mode set < 60s ago → return (existing)
  idleSeconds = IdleDetector.shared.systemIdleTime()
  if idleSeconds > 900 → mode=unfocused, reason="Extended idle"
  else if idleSeconds > 300 → mode=grounding, reason="Idle detected"
  else → existing session-based logic
  if returning from idle → log "Returned from idle"
  self-report override (existing)
  store.updateMode(mode, reason)
```

## Priority

**Medium.** This is the first "smart" behavior that makes Focus feel aware of the user's actual presence. It's low-risk (read-only IOKit call, no permissions), low-complexity (one new file, one modified function), and high-impact on perceived intelligence of the app.
