import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import {
  initDb,
  handleSessionStart,
  handleTasksSync,
  handleSessionEnd,
  handleModeSet,
  handleStatus,
  validateDir,
  findSession,
} from "../index"

// ── helpers ─────────────────────────────────────

function freshDb(): Database {
  return initDb(new Database(":memory:"))
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text)
}

function taskRows(db: Database, sessionId: number) {
  return db.query<{ content: string; status: string; priority: string }, [number]>(
    "SELECT content, status, priority FROM tasks WHERE sessionId = ? ORDER BY id"
  ).all(sessionId)
}

function sessionRow(db: Database, id: number) {
  return db.query<{
    id: number; phase: string; goal: string | null; why: string | null;
    trigger: string | null; projectDir: string | null; projectName: string | null;
    endedAt: string | null; endReason: string | null; source: string | null;
    sourceSessionId: string | null;
  }, [number]>("SELECT * FROM sessions WHERE id = ?").get(id)
}

// Use /tmp paths to avoid gitBranch side effects on real dirs
const PROJECT_A = "/tmp/focus-test-project-a"
const PROJECT_B = "/tmp/focus-test-project-b"

// ── focus_session_start ─────────────────────────

describe("focus_session_start", () => {
  let db: Database

  beforeEach(() => { db = freshDb() })

  test("creates a new session with all fields", async () => {
    const result = await handleSessionStart(db, {
      projectDir: PROJECT_A,
      goal: "Ship feature X",
      why: "Users need it",
      trigger: "PM request",
      source: "claude-code",
      sourceSessionId: "sess-123",
    })
    const data = parseResult(result)

    expect(data.ok).toBe(true)
    expect(data.sessionId).toBeGreaterThan(0)
    expect(data.project).toBe("focus-test-project-a")

    const row = sessionRow(db, data.sessionId)!
    expect(row.goal).toBe("Ship feature X")
    expect(row.why).toBe("Users need it")
    expect(row.trigger).toBe("PM request")
    expect(row.source).toBe("claude-code")
    expect(row.sourceSessionId).toBe("sess-123")
    expect(row.projectDir).toBe(PROJECT_A)
    expect(row.phase).toBe("during")
    expect(row.endedAt).toBeNull()
  })

  test("reuses existing session for same projectDir", async () => {
    const r1 = await handleSessionStart(db, { projectDir: PROJECT_A })
    const r2 = await handleSessionStart(db, { projectDir: PROJECT_A })

    expect(parseResult(r1).sessionId).toBe(parseResult(r2).sessionId)
  })

  test("reuses session by sourceSessionId", async () => {
    const r1 = await handleSessionStart(db, {
      projectDir: PROJECT_A,
      sourceSessionId: "ext-1",
    })
    const r2 = await handleSessionStart(db, {
      projectDir: PROJECT_B, // different dir, same sourceSessionId
      sourceSessionId: "ext-1",
    })

    expect(parseResult(r1).sessionId).toBe(parseResult(r2).sessionId)
  })

  test("updates goal/why/trigger on reuse", async () => {
    const r1 = await handleSessionStart(db, {
      projectDir: PROJECT_A,
      goal: "old goal",
      why: "old why",
      trigger: "old trigger",
    })
    const sid = parseResult(r1).sessionId

    await handleSessionStart(db, {
      projectDir: PROJECT_A,
      goal: "new goal",
      why: "new why",
      trigger: "new trigger",
    })

    const row = sessionRow(db, sid)!
    expect(row.goal).toBe("new goal")
    expect(row.why).toBe("new why")
    expect(row.trigger).toBe("new trigger")
  })

  test("rejects relative projectDir", async () => {
    await expect(
      handleSessionStart(db, { projectDir: "relative/path" })
    ).rejects.toThrow("projectDir must be an absolute path")
  })

  test("logs mode entry on start", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A })

    const mode = db.query<{ mode: string; reason: string }, []>(
      "SELECT mode, reason FROM mode_log ORDER BY id DESC LIMIT 1"
    ).get()!

    expect(mode.mode).toBe("focused")
    expect(mode.reason).toContain("Session started")
  })
})

// ── focus_tasks_sync ────────────────────────────

describe("focus_tasks_sync", () => {
  let db: Database
  let sessionId: number

  beforeEach(async () => {
    db = freshDb()
    const r = await handleSessionStart(db, { projectDir: PROJECT_A })
    sessionId = parseResult(r).sessionId
  })

  test("syncs tasks to active session", async () => {
    const result = await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "Task 1", status: "pending" },
        { content: "Task 2", status: "in_progress", priority: "high" },
      ],
    })
    const data = parseResult(result)

    expect(data.ok).toBe(true)
    expect(data.taskCount).toBe(2)

    const tasks = taskRows(db, sessionId)
    expect(tasks).toHaveLength(2)
    expect(tasks[0].content).toBe("Task 1")
    expect(tasks[0].status).toBe("pending")
    expect(tasks[1].content).toBe("Task 2")
    expect(tasks[1].priority).toBe("high")
  })

  test("replaces previous tasks (not appends)", async () => {
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "Old task", status: "pending" },
      ],
    })

    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "New task A", status: "in_progress" },
        { content: "New task B", status: "completed" },
      ],
    })

    const tasks = taskRows(db, sessionId)
    expect(tasks).toHaveLength(2)
    expect(tasks[0].content).toBe("New task A")
    expect(tasks[1].content).toBe("New task B")
  })

  test("returns error when no active session", async () => {
    const result = await handleTasksSync(db, {
      projectDir: "/tmp/nonexistent-project",
      tasks: [{ content: "X", status: "pending" }],
    })

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain("No active session")
  })

  test("handles empty task array (deletes all tasks)", async () => {
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [{ content: "Will be removed", status: "pending" }],
    })

    const result = await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [],
    })

    expect(parseResult(result).taskCount).toBe(0)

    const tasks = taskRows(db, sessionId)
    expect(tasks).toHaveLength(0)
  })

  test("default priority is medium", async () => {
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [{ content: "No priority", status: "pending" }],
    })

    const tasks = taskRows(db, sessionId)
    expect(tasks[0].priority).toBe("medium")
  })

  test("matches session by sourceSessionId", async () => {
    const db2 = freshDb()
    const r = await handleSessionStart(db2, {
      projectDir: PROJECT_A,
      sourceSessionId: "src-99",
    })
    const sid = parseResult(r).sessionId

    const result = await handleTasksSync(db2, {
      projectDir: PROJECT_B, // different dir
      sourceSessionId: "src-99",
      tasks: [{ content: "Found via source", status: "pending" }],
    })

    expect(parseResult(result).sessionId).toBe(sid)
  })
})

// ── focus_session_end ───────────────────────────

describe("focus_session_end", () => {
  let db: Database

  beforeEach(() => { db = freshDb() })

  test("ends session by projectDir", async () => {
    const r = await handleSessionStart(db, { projectDir: PROJECT_A })
    const sid = parseResult(r).sessionId

    const result = await handleSessionEnd(db, {
      projectDir: PROJECT_A,
      reason: "completed",
    })
    const data = parseResult(result)

    expect(data.ok).toBe(true)
    expect(data.reason).toBe("completed")

    const row = sessionRow(db, sid)!
    expect(row.endedAt).not.toBeNull()
    expect(row.endReason).toBe("completed")
    expect(row.phase).toBe("after")
  })

  test("ends session by sourceSessionId", async () => {
    const r = await handleSessionStart(db, {
      projectDir: PROJECT_A,
      sourceSessionId: "src-end",
    })
    const sid = parseResult(r).sessionId

    const result = await handleSessionEnd(db, {
      projectDir: PROJECT_B, // different dir, matched by sourceSessionId
      sourceSessionId: "src-end",
      reason: "abandoned",
    })

    expect(parseResult(result).ok).toBe(true)

    const row = sessionRow(db, sid)!
    expect(row.endedAt).not.toBeNull()
    expect(row.endReason).toBe("abandoned")
  })

  test("returns error for non-existent session", async () => {
    const result = await handleSessionEnd(db, {
      projectDir: "/tmp/no-such-project",
      reason: "completed",
    })

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain("No active session")
  })

  test("logs unfocused mode on end", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A })
    await handleSessionEnd(db, { projectDir: PROJECT_A, reason: "completed" })

    const mode = db.query<{ mode: string; reason: string }, []>(
      "SELECT mode, reason FROM mode_log ORDER BY id DESC LIMIT 1"
    ).get()!

    expect(mode.mode).toBe("unfocused")
    expect(mode.reason).toContain("Session ended")
    expect(mode.reason).toContain("completed")
  })

  test("supports redefined reason", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A })
    const result = await handleSessionEnd(db, {
      projectDir: PROJECT_A,
      reason: "redefined",
    })

    expect(parseResult(result).reason).toBe("redefined")
  })
})

// ── focus_mode_set ──────────────────────────────

describe("focus_mode_set", () => {
  let db: Database

  beforeEach(() => { db = freshDb() })

  test("inserts mode log entry", async () => {
    const result = await handleModeSet(db, {
      mode: "grounding",
      reason: "User seems stuck",
    })
    const data = parseResult(result)

    expect(data.ok).toBe(true)
    expect(data.mode).toBe("grounding")

    const row = db.query<{ mode: string; reason: string; detectedAt: string }, []>(
      "SELECT mode, reason, detectedAt FROM mode_log ORDER BY id DESC LIMIT 1"
    ).get()!

    expect(row.mode).toBe("grounding")
    expect(row.reason).toBe("User seems stuck")
    expect(row.detectedAt).toBeTruthy()
  })

  test("handles missing reason", async () => {
    const result = await handleModeSet(db, { mode: "unfocused" })
    expect(parseResult(result).ok).toBe(true)

    const row = db.query<{ reason: string | null }, []>(
      "SELECT reason FROM mode_log ORDER BY id DESC LIMIT 1"
    ).get()!

    expect(row.reason).toBeNull()
  })

  test("supports all mode values", async () => {
    for (const mode of ["focused", "grounding", "unfocused"]) {
      await handleModeSet(db, { mode })
    }

    const count = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM mode_log"
    ).get()!

    expect(count.cnt).toBe(3)
  })
})

// ── focus_status ────────────────────────────────

describe("focus_status", () => {
  let db: Database

  beforeEach(() => { db = freshDb() })

  test("returns empty state when no sessions", async () => {
    const result = await handleStatus(db)
    const data = parseResult(result)

    expect(data.mode).toBe("unfocused")
    expect(data.activeSessions).toHaveLength(0)
    expect(data.lastMood).toBeNull()
  })

  test("returns active sessions with task summaries", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A, goal: "Build tests" })
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "Write unit tests", status: "in_progress" },
        { content: "Run CI", status: "pending" },
      ],
    })

    const result = await handleStatus(db)
    const data = parseResult(result)

    expect(data.activeSessions).toHaveLength(1)
    expect(data.activeSessions[0].project).toBe("focus-test-project-a")
    expect(data.activeSessions[0].goal).toBe("Build tests")
    expect(data.activeSessions[0].tasks).toContain("Write unit tests")
    expect(data.activeSessions[0].tasks).toContain("Run CI")
  })

  test("excludes ended sessions", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A })
    await handleSessionEnd(db, { projectDir: PROJECT_A, reason: "completed" })

    const result = await handleStatus(db)
    const data = parseResult(result)

    expect(data.activeSessions).toHaveLength(0)
  })

  test("reflects current mode from mode_log", async () => {
    await handleModeSet(db, { mode: "grounding", reason: "Checking in" })

    const result = await handleStatus(db)
    const data = parseResult(result)

    expect(data.mode).toBe("grounding")
    expect(data.modeReason).toBe("Checking in")
  })

  test("returns multiple active sessions", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A })
    await handleSessionStart(db, { projectDir: PROJECT_B })

    const result = await handleStatus(db)
    const data = parseResult(result)

    expect(data.activeSessions).toHaveLength(2)
  })
})

// ── lifecycle integration tests ─────────────────

describe("lifecycle", () => {
  let db: Database

  beforeEach(() => { db = freshDb() })

  test("full lifecycle: start → sync → sync (replace) → end → verify", async () => {
    // Start
    const startResult = await handleSessionStart(db, {
      projectDir: PROJECT_A,
      goal: "Integration test",
      source: "test-runner",
    })
    const sid = parseResult(startResult).sessionId

    // First sync
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "in_progress" },
      ],
    })
    expect(taskRows(db, sid)).toHaveLength(2)

    // Second sync (replaces)
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "Step 2", status: "completed" },
        { content: "Step 3", status: "pending" },
        { content: "Step 4", status: "pending" },
      ],
    })
    const tasks = taskRows(db, sid)
    expect(tasks).toHaveLength(3)
    expect(tasks[0].content).toBe("Step 2")
    expect(tasks[0].status).toBe("completed")

    // End
    const endResult = await handleSessionEnd(db, {
      projectDir: PROJECT_A,
      reason: "completed",
    })
    expect(parseResult(endResult).ok).toBe(true)

    // Verify final DB state
    const row = sessionRow(db, sid)!
    expect(row.endedAt).not.toBeNull()
    expect(row.endReason).toBe("completed")
    expect(row.phase).toBe("after")

    // Status should show no active sessions
    const status = parseResult(await handleStatus(db))
    expect(status.activeSessions).toHaveLength(0)
  })

  test("overlapping sessions: two projects both active", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A, goal: "Project A" })
    await handleSessionStart(db, { projectDir: PROJECT_B, goal: "Project B" })

    const status = parseResult(await handleStatus(db))
    expect(status.activeSessions).toHaveLength(2)

    const projects = status.activeSessions.map((s: any) => s.project)
    expect(projects).toContain("focus-test-project-a")
    expect(projects).toContain("focus-test-project-b")
  })

  test("session reuse: start, end, start same project creates new session", async () => {
    const r1 = await handleSessionStart(db, { projectDir: PROJECT_A })
    const sid1 = parseResult(r1).sessionId

    await handleSessionEnd(db, { projectDir: PROJECT_A, reason: "completed" })

    const r2 = await handleSessionStart(db, { projectDir: PROJECT_A })
    const sid2 = parseResult(r2).sessionId

    // Should be a different session (ended one is not reused)
    expect(sid2).not.toBe(sid1)
  })
})

// ── edge cases ──────────────────────────────────

describe("edge cases", () => {
  let db: Database

  beforeEach(() => { db = freshDb() })

  test("duplicate start returns same sessionId", async () => {
    const r1 = await handleSessionStart(db, { projectDir: PROJECT_A })
    const r2 = await handleSessionStart(db, { projectDir: PROJECT_A })

    expect(parseResult(r1).sessionId).toBe(parseResult(r2).sessionId)
  })

  test("end non-existent session returns isError", async () => {
    const result = await handleSessionEnd(db, {
      projectDir: "/tmp/ghost-project",
      reason: "completed",
    })

    expect((result as any).isError).toBe(true)
  })

  test("empty task sync deletes all tasks", async () => {
    await handleSessionStart(db, { projectDir: PROJECT_A })

    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [{ content: "Will vanish", status: "pending" }],
    })

    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [],
    })

    const count = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM tasks"
    ).get()!
    expect(count.cnt).toBe(0)
  })

  test("relative path rejection", () => {
    expect(() => validateDir("relative/path")).toThrow("projectDir must be an absolute path")
    expect(() => validateDir("./relative")).toThrow("projectDir must be an absolute path")
    expect(() => validateDir("no-slash")).toThrow("projectDir must be an absolute path")
  })

  test("sync tasks for non-existent session returns isError", async () => {
    const result = await handleTasksSync(db, {
      projectDir: "/tmp/no-session-here",
      tasks: [{ content: "Orphan", status: "pending" }],
    })

    expect((result as any).isError).toBe(true)
  })
})

// ── transactional integrity ─────────────────────

describe("transactional integrity", () => {
  test("task sync is atomic (delete + insert in one transaction)", async () => {
    const db = freshDb()
    await handleSessionStart(db, { projectDir: PROJECT_A })

    // Insert initial tasks
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "A", status: "pending" },
        { content: "B", status: "pending" },
        { content: "C", status: "pending" },
      ],
    })

    // Replace with new tasks — should be atomic
    await handleTasksSync(db, {
      projectDir: PROJECT_A,
      tasks: [
        { content: "X", status: "in_progress" },
        { content: "Y", status: "pending" },
      ],
    })

    // Verify we have exactly the new tasks, no remnants of old
    const all = db.query<{ content: string }, []>(
      "SELECT content FROM tasks ORDER BY id"
    ).all()
    expect(all.map(r => r.content)).toEqual(["X", "Y"])
  })
})

// ── input validation ────────────────────────────

describe("input validation", () => {
  test("validateDir accepts absolute paths", () => {
    expect(validateDir("/usr/local")).toBe("/usr/local")
    expect(validateDir("/tmp/test")).toBe("/tmp/test")
  })

  test("validateDir rejects relative paths", () => {
    expect(() => validateDir("relative")).toThrow()
    expect(() => validateDir("./relative")).toThrow()
    expect(() => validateDir("../parent")).toThrow()
  })

  test("findSession returns null when no sessions exist", () => {
    const db = freshDb()
    expect(findSession(db, "/tmp/nothing")).toBeNull()
  })

  test("findSession returns null for sourceSessionId that does not exist", () => {
    const db = freshDb()
    expect(findSession(db, "/tmp/nothing", "nonexistent")).toBeNull()
  })
})
