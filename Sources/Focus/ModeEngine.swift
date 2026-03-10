import Foundation

final class ModeEngine {
    static let shared = ModeEngine()
    private var timer: Timer?

    func start() {
        evaluate()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.evaluate()
        }
    }

    func evaluate() {
        let store = Store.shared
        let session = store.currentSession()
        let report = store.latestSelfReport()

        var mode = "unfocused"
        var reason = "No active session"

        // Base: check for active session
        if let session = session {
            if let startDate = ISO8601DateFormatter().date(from: session.startedAt) {
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
           let reportDate = ISO8601DateFormatter().date(from: report.reportedAt) {
            let age = Date().timeIntervalSince(reportDate)
            if age < 300 { // within 5 min
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
