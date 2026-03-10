import SwiftUI

// ──────────────────────────────────────────────
// MARK: - ViewModel
// ──────────────────────────────────────────────

final class ContentViewModel: ObservableObject {
    @Published var currentMode: String = "unfocused"
    @Published var modeReason: String = ""
    @Published var sessions: [FocusSession] = []
    @Published var tasksBySession: [Int64: [TaskItem]] = [:]
    @Published var lastMood: String?

    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            DispatchQueue.main.async { self?.refresh() }
        }
    }

    func refresh() {
        let store = Store.shared

        if let m = store.currentMode() {
            currentMode = m.mode
            modeReason = m.reason ?? ""
        }

        sessions = store.activeSessions()
        var grouped: [Int64: [TaskItem]] = [:]
        for s in sessions {
            if let sid = s.id {
                grouped[sid] = store.tasksForSession(sid)
            }
        }
        tasksBySession = grouped
        lastMood = store.latestSelfReport()?.mood
    }

    func reportMood(_ mood: String) {
        Store.shared.addSelfReport(mood: mood)
        ModeEngine.shared.evaluate()
        refresh()
        if let delegate = NSApp.delegate as? AppDelegate {
            delegate.updateIcon()
        }
    }

    var modeColor: Color {
        switch currentMode {
        case "focused":   return .green
        case "grounding": return .orange
        default:          return .gray
        }
    }

    func elapsed(from iso: String) -> String {
        guard let d = ISO8601DateFormatter().date(from: iso) else { return "" }
        let secs = Int(Date().timeIntervalSince(d))
        let mins = secs / 60
        let hrs = mins / 60
        return hrs > 0 ? "\(hrs)h \(mins % 60)m" : "\(mins)m"
    }
}

// ──────────────────────────────────────────────
// MARK: - Content View
// ──────────────────────────────────────────────

struct ContentView: View {
    @StateObject private var vm = ContentViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {

            // ── mode header ──
            HStack(spacing: 8) {
                Circle()
                    .fill(vm.modeColor)
                    .frame(width: 8, height: 8)
                Text(vm.currentMode.uppercased())
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                Spacer()
                Text("\(vm.sessions.count) session\(vm.sessions.count == 1 ? "" : "s")")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)

            sep

            // ── sessions ──
            if vm.sessions.isEmpty {
                VStack(spacing: 6) {
                    Text("no active sessions")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.secondary)
                    Text("start a coding session to see tasks here")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary.opacity(0.6))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(vm.sessions, id: \.id) { session in
                            sessionCard(session)
                            if session.id != vm.sessions.last?.id {
                                sep
                            }
                        }
                    }
                }
                .frame(maxHeight: 320)
            }

            sep

            // ── self-report ──
            VStack(alignment: .leading, spacing: 6) {
                Text("how are you feeling?")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
                HStack(spacing: 16) {
                    moodBtn("good",     emoji: "😊")
                    moodBtn("meh",      emoji: "😐")
                    moodBtn("stuck",    emoji: "😔")
                    moodBtn("redefine", emoji: "🔄")
                    Spacer()
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)

            // ── mode reason ──
            if !vm.modeReason.isEmpty {
                sep
                Text(vm.modeReason)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                    .padding(.horizontal, 16).padding(.vertical, 6)
            }

            sep

            // ── footer ──
            HStack {
                Text("focus")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundColor(.secondary.opacity(0.4))
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .font(.system(size: 10, design: .monospaced))
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .frame(width: 340)
    }

    // MARK: - Session card

    @ViewBuilder
    private func sessionCard(_ s: FocusSession) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // header: project · branch · elapsed
            HStack(spacing: 6) {
                if let src = s.source {
                    Text(src)
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(sourceColor(src).opacity(0.2))
                        .cornerRadius(3)
                }
                Text(s.projectName ?? "—")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                if let b = s.gitBranch {
                    Text("·").foregroundColor(.secondary)
                    Text(b)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.secondary)
                }
                Spacer()
                Text(vm.elapsed(from: s.startedAt))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
            }

            // goal
            if let g = s.goal {
                Text(g)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }

            // tasks
            let tasks = vm.tasksBySession[s.id ?? -1] ?? []
            if !tasks.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(tasks.prefix(6), id: \.id) { task in
                        HStack(spacing: 6) {
                            Image(systemName: task.statusIcon)
                                .font(.system(size: 9))
                                .foregroundColor(statusColor(task.status))
                                .frame(width: 12)
                            Text(task.content)
                                .font(.system(size: 10, design: .monospaced))
                                .lineLimit(1)
                            Spacer()
                        }
                    }
                    if tasks.count > 6 {
                        Text("+ \(tasks.count - 6) more")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    // MARK: - Helpers

    private var sep: some View {
        Divider().padding(.horizontal, 8)
    }

    private func moodBtn(_ mood: String, emoji: String) -> some View {
        Button(action: { vm.reportMood(mood) }) {
            Text(emoji)
                .font(.system(size: 18))
                .opacity(vm.lastMood == mood ? 1.0 : 0.5)
        }
        .buttonStyle(.plain)
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "completed":   return .green
        case "in_progress": return .blue
        default:            return .secondary
        }
    }

    private func sourceColor(_ source: String) -> Color {
        switch source {
        case "claude-code": return .purple
        case "opencode":    return .blue
        case "mcp":         return .cyan
        default:            return .gray
        }
    }
}
