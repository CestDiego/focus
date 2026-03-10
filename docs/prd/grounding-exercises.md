# PRD: Grounding Exercise Prompts

**Status:** Proposed
**Priority:** Medium — this is the heart of the grounding mode experience
**Author:** Diego

## Update Log

- 2026-03-10: Initial draft (grounding mode exists but has no actual exercises; filling the gap with compassionate, brief prompts)

## Problem

When `ModeEngine` detects the user is in "grounding" mode — triggered by a self-report of "stuck" or "low", a long-running session, or a "redefine" action — the app has nothing to offer. The orange dot appears, the mode label reads `GROUNDING`, and the reason text says "try a grounding exercise." But there are no exercises. The mode is a dead end.

This is the most critical moment in the Focus experience: the user just told us they're struggling, and we respond with... a label. Grounding mode should be the most thoughtful, well-designed part of the app. Right now it's the emptiest.

## Solution

Build a library of quick grounding exercises that surface in the popover when the user enters grounding mode. Each exercise is brief (under 2 minutes), compassionate in tone, and designed to help the user re-center before returning to work. After completing an exercise, the mode automatically transitions back to "focused."

The exercises draw from established techniques (CBT/DBT grounding, the 20-20-20 rule, breathwork) adapted for a developer context — someone sitting at a desk, mid-session, who needs a gentle reset, not a therapy worksheet.

## Exercises

### 1. 4-7-8 Breathing

An animated visual guide for the 4-7-8 breathing pattern.

- **UI**: A circle or ring that smoothly expands during inhale, holds at full size, and contracts during exhale. Monospaced text labels the current phase: `inhale`, `hold`, `exhale`.
- **Timing**: 4 seconds inhale → 7 seconds hold → 8 seconds exhale.
- **Duration**: 3 full cycles (~57 seconds total).
- **Completion**: After the third cycle, display "done. take a moment." briefly before transitioning.

### 2. 5-4-3-2-1 Senses

A step-by-step sensory grounding prompt.

- **UI**: One step at a time, full-width in the popover. Each step advances on a button press or after a short timer.
- **Steps**:
  1. "Name **5** things you can see."
  2. "Name **4** things you can touch."
  3. "Name **3** things you can hear."
  4. "Name **2** things you can smell."
  5. "Name **1** thing you can taste."
- **Interaction**: User taps "next" to advance (no text input required — the naming is internal/mental).
- **Duration**: Self-paced, typically 60–90 seconds.

### 3. TAP (Touch and Pause)

A simple body-awareness pause.

- **UI**: Sequential text prompts displayed one at a time with gentle fade transitions.
- **Steps**:
  1. "Close your eyes for a moment."
  2. "Feel your feet on the ground."
  3. "Feel your hands — where are they resting?"
  4. "Take 3 slow breaths."
- **Timing**: Each prompt displays for ~5 seconds, or user taps to advance.
- **Duration**: ~20–30 seconds.

### 4. Micro-break (20-20-20)

A physical micro-break based on the 20-20-20 rule.

- **UI**: Single instruction card with a countdown timer.
- **Prompt**: "Stand up. Stretch. Look at something 20 feet away."
- **Timer**: 20-second countdown displayed in large monospaced text.
- **Completion**: Timer ends with a gentle "welcome back." message.

### 5. Intention Reset

A cognitive re-centering exercise that feeds back into the session.

- **UI**: A text prompt with a single-line input field.
- **Prompt**: "What were you trying to accomplish? Write it in one sentence."
- **Input**: Monospaced text field, single line, submit on Enter.
- **Effect**: The entered text updates the current session's `goal` field via `Store`. If no active session exists, the text is discarded with a note.
- **Duration**: Self-paced, typically 15–30 seconds.

## Requirements

### Grounding View

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | New `GroundingView` appears in the popover when `currentMode == "grounding"` | Replaces or overlays the default session list |
| 2 | Shows a randomly selected exercise by default | User can swipe/tap to pick a different one |
| 3 | Exercise selection menu shows all 5 types with icons | Compact horizontal or vertical picker |
| 4 | User can dismiss/skip any exercise at any time | "skip" button always visible; no forced engagement |
| 5 | After completing an exercise, mode transitions to "focused" | Via `Store.updateMode("focused", reason: "Grounding exercise completed")` |
| 6 | Calm, minimal design: monospaced text, muted colors, gentle animations | Consistent with existing `ContentView` aesthetic |
| 7 | Breathing animation uses SwiftUI native animations (no Lottie/external deps) | `scaleEffect` + `Animation.easeInOut` |

### Data Model

| # | Requirement | Notes |
|---|-------------|-------|
| 8 | New `grounding_log` table via GRDB migration | `v3-grounding-log` migration |
| 9 | Schema: `id` (auto PK), `exerciseType` (text), `startedAt` (text), `completedAt` (text, nullable), `sessionId` (integer, nullable FK → sessions) | Nullable `completedAt` means the exercise was started but skipped |
| 10 | `GroundingLog` model struct conforming to `Codable, FetchableRecord, MutablePersistableRecord` | Follows existing pattern in `Store.swift` |
| 11 | Log entry created when exercise starts, updated with `completedAt` on completion | Skipped exercises have `completedAt = NULL` |

### Intention Reset Integration

| # | Requirement | Notes |
|---|-------------|-------|
| 12 | Intention reset updates `sessions.goal` for the current session | Uses existing `Store` write path |
| 13 | If multiple sessions are active, updates the most recent one | `ORDER BY startedAt DESC LIMIT 1` |
| 14 | If no session is active, show a note: "no active session — but the clarity still helps." | Don't block the exercise |

### ModeEngine Integration

| # | Requirement | Notes |
|---|-------------|-------|
| 15 | `ModeEngine.evaluate()` respects the post-exercise "focused" mode for at least 60 seconds | Already handled by the existing `age < 60 && !isEngineMode` guard |
| 16 | Grounding exercise completion reason string must NOT start with "Active session", "No active", or "Session running" | Otherwise `ModeEngine` would treat it as an engine-set mode and overwrite it |

## Non-Goals

- **No audio guidance.** The app runs silently. No spoken instructions, chimes, or ambient sounds.
- **No complex CBT worksheets.** These are micro-exercises, not therapy tools. No multi-page forms, journaling prompts, or thought records.
- **No AI-generated exercises.** All exercise content is static and hand-written. No LLM calls, no dynamic text generation.
- **No notification-triggered exercises.** Exercises only appear when the user opens the popover while in grounding mode. No push notifications, no modal interruptions.
- **No exercise history/stats UI.** The `grounding_log` table captures data for future analytics, but v1 has no UI to review past exercises.

## Design Principles

1. **Compassionate, not nagging.** The tone should feel like a thoughtful colleague, not a wellness app. No exclamation marks. No "Great job!" affirmations. Calm, understated language.
2. **Brief.** Every exercise completes in under 2 minutes. Most are under 60 seconds. The user is mid-work — respect that.
3. **Respect user agency.** Skip is always available. No guilt for dismissing. No streak counters. The user chose to open the popover; they can choose to close it.
4. **Monospaced, minimal, muted.** Text is `.monospaced`. Colors are the existing palette (orange for grounding, green for focused, gray for unfocused). Animations are gentle `easeInOut` curves, not bouncy or playful.
5. **Feed back into the system.** Completing an exercise has a concrete effect: mode transitions to focused, and (for intention reset) the session goal updates. The exercises aren't decorative — they change state.

## Implementation Notes

- `GroundingView` should be a new SwiftUI file (`GroundingView.swift`) to keep `ContentView.swift` from growing further.
- The breathing animation circle can reuse the existing mode indicator dot pattern (colored `Circle()`) at a larger scale.
- Exercise type can be an enum: `.breathing`, `.senses`, `.tap`, `.microBreak`, `.intentionReset`.
- The `grounding_log` migration should be registered after `v2-multi-session` in `Store.migrate()`.
- Consider adding a `Store.logGroundingExercise(type:sessionId:)` → `GroundingLog` convenience method following the existing `addSelfReport` pattern.

## Acceptance Criteria

1. When mode is "grounding", opening the popover shows a grounding exercise instead of (or above) the session list.
2. The 4-7-8 breathing exercise displays an animated circle with correct timing (4s/7s/8s) for 3 cycles.
3. The 5-4-3-2-1 exercise steps through all 5 sensory prompts sequentially.
4. TAP displays body-awareness prompts with timed transitions.
5. Micro-break shows a 20-second countdown timer.
6. Intention reset accepts text input and updates the current session's goal.
7. Completing any exercise transitions mode to "focused" with reason "Grounding exercise completed".
8. Skipping an exercise does not change the mode.
9. The `grounding_log` table is created by migration and entries are written on exercise start/completion.
10. Skipped exercises are logged with `completedAt = NULL`.
11. All exercise text uses monospaced font and the existing color palette.
12. No audio is played at any point.
