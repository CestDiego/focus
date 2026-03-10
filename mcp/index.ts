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
import { join, basename, isAbsolute, resolve } from "node:path"
import { execSync } from "node:child_process"

// ── types ───────────────────────────────────────

export interface SessionRow { id: number }
export interface SessionNameRow { id: number; projectName: string | null }
export interface SessionFullRow {
  id: number; projectName: string | null; projectDir: string | null
  gitBranch: string | null; goal: string | null; why: string | null
  source: string | null; startedAt: string; taskSummary: string | null
}
export interface ModeRow { mode: string; reason: string | null }
export interface ReportRow { mood: string; reportedAt: string }

// ── helpers ─────────────────────────────────────

export function iso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

export function validateDir(dir: string): string {
  if (!isAbsolute(dir)) throw new Error("projectDir must be an absolute path")
  return resolve(dir)
}

export function gitBranch(dir: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir, timeout: 5000, encoding: "utf8",
    }).trim()
  } catch { return null }
}

export function findSession(db: Database, projectDir: string, sourceSessionId?: string): SessionRow | null {
  if (sourceSessionId) {
    const row = db.query<SessionRow, [string]>(
      "SELECT id FROM sessions WHERE sourceSessionId = ? AND endedAt IS NULL LIMIT 1"
    ).get(sourceSessionId)
    if (row) return row
  }
  return db.query<SessionRow, [string]>(
    "SELECT id FROM sessions WHERE projectDir = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1"
  ).get(projectDir)
}

// ── database ────────────────────────────────────

const DB_DIR = join(homedir(), ".config", "focus")
const DB_PATH = join(DB_DIR, "focus.db")

export function initDb(existingDb?: Database): Database {
  let db: Database
  if (existingDb) {
    db = existingDb
  } else {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
    db = new Database(DB_PATH)
  }
  db.run("PRAGMA journal_mode=WAL")
  db.run("PRAGMA busy_timeout=5000")
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
  try { db.run("ALTER TABLE sessions ADD COLUMN source TEXT") } catch {}
  try { db.run("ALTER TABLE sessions ADD COLUMN sourceSessionId TEXT") } catch {}
  return db
}

// ── tool handlers (exported for testability) ────

export async function handleSessionStart(db: Database, args: {
  projectDir: string; goal?: string; why?: string; trigger?: string;
  source?: string; sourceSessionId?: string;
}) {
  const dir = validateDir(args.projectDir)
  const now = iso()
  const name = basename(dir)
  const branch = gitBranch(dir)

  const row = findSession(db, dir, args.sourceSessionId)

  let sessionId: number
  if (row) {
    sessionId = row.id
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

  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, sessionId, project: name, branch }) }] }
}

export async function handleTasksSync(db: Database, args: {
  projectDir: string; sourceSessionId?: string;
  tasks: Array<{ content: string; status: string; priority?: string }>;
}) {
  const dir = validateDir(args.projectDir)
  const now = iso()
  const row = findSession(db, dir, args.sourceSessionId)

  if (!row) {
    return { isError: true, content: [{ type: "text" as const, text: "No active session found. Call focus_session_start first." }] }
  }

  const sessionId = row.id

  db.transaction(() => {
    db.run("DELETE FROM tasks WHERE sessionId = ?", [sessionId])
    const stmt = db.prepare("INSERT INTO tasks (sessionId, content, status, priority, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
    for (const t of args.tasks) {
      stmt.run(sessionId, t.content, t.status, t.priority || "medium", now, now)
    }
  })()

  db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [
    "focused", `Tasks synced: ${args.tasks.length} items`, now,
  ])

  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, sessionId, taskCount: args.tasks.length }) }] }
}

export async function handleSessionEnd(db: Database, args: {
  projectDir: string; sourceSessionId?: string; reason: string;
}) {
  const dir = validateDir(args.projectDir)
  const now = iso()

  let row: SessionNameRow | null = null
  if (args.sourceSessionId) {
    row = db.query<SessionNameRow, [string]>(
      "SELECT id, projectName FROM sessions WHERE sourceSessionId = ? AND endedAt IS NULL LIMIT 1"
    ).get(args.sourceSessionId)
  }
  if (!row) {
    row = db.query<SessionNameRow, [string]>(
      "SELECT id, projectName FROM sessions WHERE projectDir = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1"
    ).get(dir)
  }
  if (!row) {
    return { isError: true, content: [{ type: "text" as const, text: "No active session found." }] }
  }

  db.run("UPDATE sessions SET endedAt = ?, endReason = ?, phase = 'after' WHERE id = ?", [
    now, args.reason, row.id,
  ])
  db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [
    "unfocused", `Session ended (${args.reason}): ${row.projectName}`, now,
  ])

  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ended: row.projectName, reason: args.reason }) }] }
}

export async function handleModeSet(db: Database, args: {
  mode: string; reason?: string;
}) {
  db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [
    args.mode, args.reason || null, iso(),
  ])
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, mode: args.mode }) }] }
}

export async function handleStatus(db: Database) {
  const sessions = db.query<SessionFullRow, []>(`
    SELECT s.id, s.projectName, s.projectDir, s.gitBranch, s.goal, s.why,
           s.source, s.startedAt,
           GROUP_CONCAT(SUBSTR(t.content, 1, 80) || ' [' || t.status || ']', '; ') as taskSummary
    FROM sessions s
    LEFT JOIN tasks t ON t.sessionId = s.id
    WHERE s.endedAt IS NULL
    GROUP BY s.id
    ORDER BY s.startedAt DESC
  `).all()

  const mode = db.query<ModeRow, []>("SELECT mode, reason FROM mode_log ORDER BY detectedAt DESC LIMIT 1").get()
  const report = db.query<ReportRow, []>("SELECT mood, reportedAt FROM self_reports ORDER BY reportedAt DESC LIMIT 1").get()

  const status = {
    mode: mode?.mode || "unfocused",
    modeReason: mode?.reason || null,
    lastMood: report?.mood || null,
    activeSessions: sessions.map((s) => ({
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
}

// ── server wiring ───────────────────────────────

function createServer(db: Database): McpServer {
  const server = new McpServer({
    name: "focus",
    version: "0.2.0",
  })

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
    async (args) => handleSessionStart(db, args),
  )

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
    async (args) => handleTasksSync(db, args),
  )

  server.tool(
    "focus_session_end",
    "End a focus session. Call when work is done, abandoned, or needs redefinition.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      sourceSessionId: z.string().optional().describe("Client session ID for matching"),
      reason: z.enum(["completed", "abandoned", "redefined"]).describe("Why the session ended"),
    },
    async (args) => handleSessionEnd(db, args),
  )

  server.tool(
    "focus_mode_set",
    "Set the user's current cognitive mode. Use when you detect the user may be unfocused, or to confirm focus.",
    {
      mode: z.enum(["focused", "grounding", "unfocused"]).describe("The cognitive mode"),
      reason: z.string().optional().describe("Human-readable reason for this mode"),
    },
    async (args) => handleModeSet(db, args),
  )

  server.tool(
    "focus_status",
    "Get the current state of all active focus sessions. Use this to understand what work is in progress across all coding sessions.",
    {},
    async () => handleStatus(db),
  )

  return server
}

// ── start (only when run directly, not when imported) ─

const isMainModule = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith("/mcp/index.ts")

if (isMainModule) {
  const db = initDb()
  const server = createServer(db)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

export { createServer }
