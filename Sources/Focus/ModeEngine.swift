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

        // Don't override a recently-set mode from an MCP client or self-report
        // Only overwrite modes that this engine itself set (contain "Active session" or "No active")
        if let current = store.currentMode(),
           let detectedDate = fmt.date(from: current.detectedAt) {
            let age = Date().timeIntervalSince(detectedDate)
            let isEngineMode = current.reason?.hasPrefix("Active session") == true
                || current.reason?.hasPrefix("No active") == true
                || current.reason?.hasPrefix("Session running") == true
            if age < 60 && !isEngineMode {
                return // respect externally-set mode for at least 60s
            }
        }

        var mode = "unfocused"
        var reason = "No active session"

        if let session = session {
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
