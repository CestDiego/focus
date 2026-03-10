#!/usr/bin/env bun
/**
 * focus-mcp — MCP server for the Focus cognitive state tracker.
 *
 * Any MCP-compatible client (OpenCode, Claude Code, etc.) can connect and:
 *   • Register what session/project it's working on
 *   • Sync its task list
 *   • Report mode changes
 *   • Read the global state across all active sessions
 *
 * Data flows into ~/.config/focus/focus.db (shared with the menu bar app).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { Database } from "bun:sqlite"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, basename } from "node:path"
import { execSync } from "node:child_process"

// ── database ────────────────────────────────────

const DB_DIR = join(homedir(), ".config", "focus")
const DB_PATH = join(DB_DIR, "focus.db")

function iso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

function openDb(): Database {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
  const db = new Database(DB_PATH)
  db.run("PRAGMA journal_mode=WAL")
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase TEXT NOT NULL DEFAULT 'during',
    goal TEXT, why TEXT, "trigger" TEXT,
    projectDir TEXT, projectName TEXT, gitBranch TEXT,
    startedAt TEXT NOT NULL, endedAt TEXT, endReason TEXT,
    source TEXT, sourceSessionId TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId INTEGER REFERENCES sessions(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'medium',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS mode_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL, reason TEXT,
    detectedAt TEXT NOT NULL
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS self_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mood TEXT NOT NULL, note TEXT,
    reportedAt TEXT NOT NULL
  )`)
  // ensure source columns exist on older DBs
  try { db.run("ALTER TABLE sessions ADD COLUMN source TEXT") } catch {}
  try { db.run("ALTER TABLE sessions ADD COLUMN sourceSessionId TEXT") } catch {}
  return db
}

function gitBranch(dir: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir, timeout: 5000, encoding: "utf8",
    }).trim()
  } catch { return null }
}

// ── server ──────────────────────────────────────

const server = new McpServer({
  name: "focus",
  version: "0.1.0",
})

// ── TOOL: focus_session_start ───────────────────

server.tool(
  "focus_session_start",
  "Start or resume a focus session. Call this when beginning work on a project. If a session already exists for this project, it will be reused.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    goal: z.string().optional().describe("What you're trying to accomplish in this session"),
    why: z.string().optional().describe("Why this work matters — the larger purpose"),
    trigger: z.string().optional().describe("What triggered this focus session"),
    source: z.string().optional().describe("Client identifier: claude-code, opencode, cursor, etc."),
    sourceSessionId: z.string().optional().describe("The client's own session ID for correlation"),
  },
  async (args) => {
    const db = openDb()
    const now = iso()
    const dir = args.projectDir
    const name = basename(dir)
    const branch = gitBranch(dir)

    // check for existing active session for this project+source
    let row: any = null
    if (args.sourceSessionId) {
      row = db.query("SELECT id FROM sessions WHERE sourceSessionId = ? AND endedAt IS NULL LIMIT 1")
        .get(args.sourceSessionId)
    }
    if (!row) {
      row = db.query("SELECT id FROM sessions WHERE projectDir = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
        .get(dir)
    }

    let sessionId: number
    if (row) {
      sessionId = (row as any).id
      if (args.goal) db.run("UPDATE sessions SET goal = ? WHERE id = ?", [args.goal, sessionId])
      if (args.why) db.run("UPDATE sessions SET why = ? WHERE id = ?", [args.why, sessionId])
      if (args.trigger) db.run('UPDATE sessions SET "trigger" = ? WHERE id = ?', [args.trigger, sessionId])
      db.run("UPDATE sessions SET gitBranch = ?, source = ?, sourceSessionId = ? WHERE id = ?", [
        branch, args.source || null, args.sourceSessionId || null, sessionId,
      ])
    } else {
      const result = db.run(
        'INSERT INTO sessions (phase, goal, why, "trigger", projectDir, projectName, gitBranch, startedAt, source, sourceSessionId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ["during", args.goal || null, args.why || null, args.trigger || null, dir, name, branch, now, args.source || null, args.sourceSessionId || null],
      )
      sessionId = Number(result.lastInsertRowid)
    }

    db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [
      "focused", `Session started: ${name}`, now,
    ])
    db.close()

    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, sessionId, project: name, branch }) }] }
  },
)

// ── TOOL: focus_tasks_sync ──────────────────────

server.tool(
  "focus_tasks_sync",
  "Sync the current task list for a project. Replaces all tasks for the matched session. Call this whenever your todo list changes.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    sourceSessionId: z.string().optional().describe("Client session ID for matching"),
    tasks: z.array(z.object({
      content: z.string().describe("Task description"),
      status: z.enum(["pending", "in_progress", "completed"]).describe("Task status"),
      priority: z.enum(["high", "medium", "low"]).optional().describe("Priority level"),
    })).describe("The full task list"),
  },
  async (args) => {
    const db = openDb()
    const now = iso()

    // find session
    let row: any = null
    if (args.sourceSessionId) {
      row = db.query("SELECT id FROM sessions WHERE sourceSessionId = ? AND endedAt IS NULL LIMIT 1")
        .get(args.sourceSessionId)
    }
    if (!row) {
      row = db.query("SELECT id FROM sessions WHERE projectDir = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
        .get(args.projectDir)
    }
    if (!row) {
      db.close()
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "No active session found. Call focus_session_start first." }) }] }
    }

    const sessionId = (row as any).id
    db.run("DELETE FROM tasks WHERE sessionId = ?", [sessionId])

    const stmt = db.prepare("INSERT INTO tasks (sessionId, content, status, priority, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
    for (const t of args.tasks) {
      stmt.run(sessionId, t.content, t.status, t.priority || "medium", now, now)
    }

    db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [
      "focused", `Tasks synced: ${args.tasks.length} items`, now,
    ])
    db.close()

    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, sessionId, taskCount: args.tasks.length }) }] }
  },
)

// ── TOOL: focus_session_end ─────────────────────

server.tool(
  "focus_session_end",
  "End a focus session. Call when work is done, abandoned, or needs redefinition.",
  {
    projectDir: z.string().describe("Absolute path to the project directory"),
    sourceSessionId: z.string().optional().describe("Client session ID for matching"),
    reason: z.enum(["completed", "abandoned", "redefined"]).describe("Why the session ended"),
  },
  async (args) => {
    const db = openDb()
    const now = iso()

    let row: any = null
    if (args.sourceSessionId) {
      row = db.query("SELECT id, projectName FROM sessions WHERE sourceSessionId = ? AND endedAt IS NULL LIMIT 1")
        .get(args.sourceSessionId)
    }
    if (!row) {
      row = db.query("SELECT id, projectName FROM sessions WHERE projectDir = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
        .get(args.projectDir)
    }
    if (!row) {
      db.close()
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "No active session found." }) }] }
    }

    db.run("UPDATE sessions SET endedAt = ?, endReason = ?, phase = 'after' WHERE id = ?", [
      now, args.reason, (row as any).id,
    ])
    db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [
      "unfocused", `Session ended (${args.reason}): ${(row as any).projectName}`, now,
    ])
    db.close()

    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ended: (row as any).projectName, reason: args.reason }) }] }
  },
)

// ── TOOL: focus_mode_set ────────────────────────

server.tool(
  "focus_mode_set",
  "Set the user's current cognitive mode. Use when you detect the user may be unfocused, or to confirm focus.",
  {
    mode: z.enum(["focused", "grounding", "unfocused"]).describe("The cognitive mode"),
    reason: z.string().optional().describe("Human-readable reason for this mode"),
  },
  async (args) => {
    const db = openDb()
    db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [
      args.mode, args.reason || null, iso(),
    ])
    db.close()
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, mode: args.mode }) }] }
  },
)

// ── TOOL: focus_status ──────────────────────────

server.tool(
  "focus_status",
  "Get the current state of all active focus sessions. Use this to understand what work is in progress across all coding sessions.",
  {},
  async () => {
    const db = openDb()

    const sessions = db.query(`
      SELECT s.*, GROUP_CONCAT(t.content || ' [' || t.status || ']', '; ') as taskSummary
      FROM sessions s
      LEFT JOIN tasks t ON t.sessionId = s.id
      WHERE s.endedAt IS NULL
      GROUP BY s.id
      ORDER BY s.startedAt DESC
    `).all() as any[]

    const mode = db.query("SELECT mode, reason FROM mode_log ORDER BY detectedAt DESC LIMIT 1").get() as any
    const report = db.query("SELECT mood, reportedAt FROM self_reports ORDER BY reportedAt DESC LIMIT 1").get() as any
    db.close()

    const status = {
      mode: mode?.mode || "unfocused",
      modeReason: mode?.reason || null,
      lastMood: report?.mood || null,
      activeSessions: sessions.map((s: any) => ({
        id: s.id,
        project: s.projectName,
        dir: s.projectDir,
        branch: s.gitBranch,
        goal: s.goal,
        why: s.why,
        source: s.source,
        startedAt: s.startedAt,
        tasks: s.taskSummary,
      })),
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] }
  },
)

// ── start ───────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
