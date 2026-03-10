import Foundation

private let fmt = ISO8601DateFormatter()

final class ModeEngine {
    static let shared = ModeEngine()
    private var timer: Timer?

    func start() {
        evaluate()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.evaluate()
        }
    }

    deinit { timer?.invalidate() }

    func evaluate() {
        let store = Store.shared
        let session = store.currentSession()
        let report = store.latestSelfReport()

        // Query current mode once — reused for external-mode protection and idle detection
        let current = store.currentMode()

        // Don't override a recently-set mode from an MCP client or self-report.
        // Only overwrite modes that this engine itself set.
        if let current = current,
           let detectedDate = fmt.date(from: current.detectedAt) {
            let age = Date().timeIntervalSince(detectedDate)
            let isEngineMode = current.reason?.hasPrefix("Active session") == true
                || current.reason?.hasPrefix("No active") == true
                || current.reason?.hasPrefix("Session running") == true
                || current.reason?.hasPrefix("Idle detected") == true
                || current.reason?.hasPrefix("Extended idle") == true
                || current.reason?.hasPrefix("Returned from idle") == true
            if age < 60 && !isEngineMode {
                return // respect externally-set mode for at least 60s
            }
        }

        // Idle detection: check if user is AFK
        let idleSeconds = IdleDetector.shared.systemIdleTime()
        let wasIdle = current.map {
            $0.reason?.hasPrefix("Idle detected") == true
            || $0.reason?.hasPrefix("Extended idle") == true
        } ?? false

        // Return-from-idle: log the transition and give the user one visible
        // "welcome back" tick (~30s) before normal re-evaluation resumes.
        if wasIdle && idleSeconds < 300 {
            store.updateMode("grounding", reason: "Returned from idle")
            return
        }

        var mode = "unfocused"
        var reason = "No active session"

        // Idle thresholds override session-based logic (only when there's an active session)
        if session != nil && idleSeconds > 900 {
            let mins = Int(idleSeconds / 60)
            mode = "unfocused"
            reason = "Extended idle (\(mins) min)"
        } else if session != nil && idleSeconds > 300 {
            let mins = Int(idleSeconds / 60)
            mode = "grounding"
            reason = "Idle detected (\(mins) min)"
        } else if let session = session {
            if let startDate = fmt.date(from: session.startedAt) {
                let mins = Int(Date().timeIntervalSince(startDate) / 60)
                if mins < 120 {
                    mode = "focused"
                    reason = "Active session: \(session.goal ?? "unnamed") (\(mins)m)"
                } else {
                    mode = "unfocused"
                    reason = "Session running \(mins)m — time to check in?"
                }
            } else {
                mode = "focused"
                reason = "Active session: \(session.goal ?? "unnamed")"
            }
        }

        // Override: recent self-report
        if let report = report,
           let reportDate = fmt.date(from: report.reportedAt) {
            let age = Date().timeIntervalSince(reportDate)
            if age < 300 {
                switch report.mood {
                case "stuck", "low":
                    mode = "grounding"
                    reason = "Self-reported: \(report.mood) — try a grounding exercise"
                case "good":
                    if session != nil {
                        mode = "focused"
                        reason = "Feeling good + active session"
                    }
                case "redefine":
                    mode = "grounding"
                    reason = "Redefining focus — what should the goal be?"
                default:
                    break
                }
            }
        }

        store.updateMode(mode, reason: reason)
    }
}
