import Foundation
import GRDB

// ──────────────────────────────────────────────
// MARK: - Models
// ──────────────────────────────────────────────

struct FocusSession: Codable, FetchableRecord, MutablePersistableRecord {
    var id: Int64?
    var phase: String          // before · during · after
    var goal: String?
    var why: String?
    var trigger: String?
    var projectDir: String?
    var projectName: String?
    var gitBranch: String?
    var startedAt: String      // ISO 8601
    var endedAt: String?
    var endReason: String?
    var source: String?        // claude-code · opencode · mcp · manual
    var sourceSessionId: String?

    static let databaseTableName = "sessions"
    mutating func didInsert(_ inserted: InsertionSuccess) { id = inserted.rowID }
}

struct TaskItem: Codable, FetchableRecord, MutablePersistableRecord {
    var id: Int64?
    var sessionId: Int64?
    var content: String
    var status: String         // pending · in_progress · completed
    var priority: String       // high · medium · low
    var createdAt: String
    var updatedAt: String

    static let databaseTableName = "tasks"
    mutating func didInsert(_ inserted: InsertionSuccess) { id = inserted.rowID }

    var statusIcon: String {
        switch status {
        case "completed":   return "checkmark.circle.fill"
        case "in_progress": return "play.circle.fill"
        default:            return "circle"
        }
    }
}

struct ModeEntry: Codable, FetchableRecord, MutablePersistableRecord {
    var id: Int64?
    var mode: String           // focused · grounding · unfocused
    var reason: String?
    var detectedAt: String

    static let databaseTableName = "mode_log"
    mutating func didInsert(_ inserted: InsertionSuccess) { id = inserted.rowID }
}

struct SelfReport: Codable, FetchableRecord, MutablePersistableRecord {
    var id: Int64?
    var mood: String
    var note: String?
    var reportedAt: String

    static let databaseTableName = "self_reports"
    mutating func didInsert(_ inserted: InsertionSuccess) { id = inserted.rowID }
}

// ──────────────────────────────────────────────
// MARK: - Store (singleton)
// ──────────────────────────────────────────────

final class Store {
    static let shared = Store()

    let dbQueue: DatabaseQueue

    private init() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/focus")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("focus.db").path
        var config = Configuration()
        config.busyMode = .timeout(5) // wait up to 5s for MCP writer locks
        dbQueue = try! DatabaseQueue(path: path, configuration: config)
    }

    // MARK: Migrations

    func migrate() {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.create(table: "sessions", ifNotExists: true) { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("phase", .text).notNull().defaults(to: "during")
                t.column("goal", .text)
                t.column("why", .text)
                t.column("trigger", .text)
                t.column("projectDir", .text)
                t.column("projectName", .text)
                t.column("gitBranch", .text)
                t.column("startedAt", .text).notNull()
                t.column("endedAt", .text)
                t.column("endReason", .text)
            }
            try db.create(table: "tasks", ifNotExists: true) { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("sessionId", .integer).references("sessions", onDelete: .cascade)
                t.column("content", .text).notNull()
                t.column("status", .text).notNull().defaults(to: "pending")
                t.column("priority", .text).notNull().defaults(to: "medium")
                t.column("createdAt", .text).notNull()
                t.column("updatedAt", .text).notNull()
            }
            try db.create(table: "mode_log", ifNotExists: true) { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("mode", .text).notNull()
                t.column("reason", .text)
                t.column("detectedAt", .text).notNull()
            }
            try db.create(table: "self_reports", ifNotExists: true) { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("mood", .text).notNull()
                t.column("note", .text)
                t.column("reportedAt", .text).notNull()
            }
        }
        migrator.registerMigration("v2-multi-session") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "source", .text)
                t.add(column: "sourceSessionId", .text)
            }
        }
        try! migrator.migrate(dbQueue)
    }

    // MARK: Queries

    func currentSession() -> FocusSession? {
        try? dbQueue.read { db in
            try FocusSession.fetchOne(db, sql: """
                SELECT * FROM sessions WHERE endedAt IS NULL
                ORDER BY startedAt DESC LIMIT 1
            """)
        }
    }

    func activeSessions() -> [FocusSession] {
        (try? dbQueue.read { db in
            try FocusSession.fetchAll(db, sql: """
                SELECT * FROM sessions WHERE endedAt IS NULL
                ORDER BY startedAt DESC
            """)
        }) ?? []
    }

    func tasksForSession(_ sessionId: Int64?) -> [TaskItem] {
        (try? dbQueue.read { db in
            if let sid = sessionId {
                return try TaskItem.fetchAll(db, sql: """
                    SELECT * FROM tasks WHERE sessionId = ?
                    ORDER BY
                        CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                        CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
                """, arguments: [sid])
            } else {
                return try TaskItem.fetchAll(db, sql: "SELECT * FROM tasks ORDER BY createdAt DESC LIMIT 20")
            }
        }) ?? []
    }

    func allActiveTasks() -> [TaskItem] {
        (try? dbQueue.read { db in
            try TaskItem.fetchAll(db, sql: """
                SELECT t.* FROM tasks t
                JOIN sessions s ON t.sessionId = s.id
                WHERE s.endedAt IS NULL
                ORDER BY
                    CASE t.status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                    CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
            """)
        }) ?? []
    }

    func currentMode() -> ModeEntry? {
        try? dbQueue.read { db in
            try ModeEntry.fetchOne(db, sql: "SELECT * FROM mode_log ORDER BY detectedAt DESC LIMIT 1")
        }
    }

    func latestSelfReport() -> SelfReport? {
        try? dbQueue.read { db in
            try SelfReport.fetchOne(db, sql: "SELECT * FROM self_reports ORDER BY reportedAt DESC LIMIT 1")
        }
    }

    // MARK: Writes

    func addSelfReport(mood: String) {
        try? dbQueue.write { db in
            var r = SelfReport(id: nil, mood: mood, note: nil, reportedAt: Date.now8601)
            try r.insert(db)
        }
    }

    func updateMode(_ mode: String, reason: String?) {
        try? dbQueue.write { db in
            var entry = ModeEntry(id: nil, mode: mode, reason: reason, detectedAt: Date.now8601)
            try entry.insert(db)
        }
    }

    // MARK: Seed

    func seedIfEmpty() {
        let count = (try? dbQueue.read { db in try TaskItem.fetchCount(db) }) ?? 0
        guard count == 0 else { return }

        try? dbQueue.write { db in
            var session = FocusSession(
                id: nil,
                phase: "during",
                goal: "Build Focus — cognitive state tracker",
                why: "Stay aligned across coding sessions",
                trigger: "Brainstorm with Naledi",
                projectDir: "/Users/diego/Projects/focus",
                projectName: "focus",
                gitBranch: "main",
                startedAt: Date.now8601,
                endedAt: nil,
                endReason: nil
            )
            try session.insert(db)

            let items: [(String, String, String)] = [
                ("Set up Swift package + GRDB", "completed", "high"),
                ("Build menu bar + popover UI", "in_progress", "high"),
                ("Implement mode inference engine", "pending", "medium"),
                ("Add PostToolUse hook for Claude Code", "pending", "medium"),
                ("Idle detection via IOKit", "pending", "low"),
            ]
            for (content, status, priority) in items {
                var task = TaskItem(
                    id: nil,
                    sessionId: session.id,
                    content: content,
                    status: status,
                    priority: priority,
                    createdAt: Date.now8601,
                    updatedAt: Date.now8601
                )
                try task.insert(db)
            }

            var mode = ModeEntry(id: nil, mode: "focused", reason: "Active coding session", detectedAt: Date.now8601)
            try mode.insert(db)
        }
    }
}

// ──────────────────────────────────────────────
// MARK: - Date helper
// ──────────────────────────────────────────────

extension Date {
    static var now8601: String {
        ISO8601DateFormatter().string(from: Date())
    }
}
