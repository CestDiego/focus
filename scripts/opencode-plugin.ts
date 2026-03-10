/**
 * Focus — OpenCode plugin
 *
 * Syncs task state to the Focus menu bar app's SQLite database.
 *
 * Two mechanisms:
 *   1. tool.execute.after on "todowrite" — automatic sync whenever todos update
 *   2. Custom "focus" tool — lets the LLM directly set session goal, why, and mode
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, basename } from "node:path"
import { execSync } from "node:child_process"

const DB_DIR = join(homedir(), ".config", "focus")
const DB_PATH = join(DB_DIR, "focus.db")

// ── helpers ──────────────────────────────────────────

function iso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

function branch(dir: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir,
      timeout: 5000,
      encoding: "utf8",
    }).trim()
  } catch {
    return null
  }
}

function openDb(): Database {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
  const db = new Database(DB_PATH)
  db.run("PRAGMA journal_mode=WAL")

  // match the Swift app schema exactly
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase TEXT NOT NULL DEFAULT 'during',
    goal TEXT, why TEXT, "trigger" TEXT,
    projectDir TEXT, projectName TEXT, gitBranch TEXT,
    startedAt TEXT NOT NULL, endedAt TEXT, endReason TEXT
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
  return db
}

function findOrCreateSession(db: Database, projectDir: string): number {
  const now = iso()
  const name = basename(projectDir)
  const br = branch(projectDir)

  const row = db
    .query<{ id: number }, [string]>(
      "SELECT id FROM sessions WHERE projectDir = ? AND endedAt IS NULL ORDER BY startedAt DESC LIMIT 1",
    )
    .get(projectDir)

  if (row) {
    db.run("UPDATE sessions SET gitBranch = ? WHERE id = ?", [br, row.id])
    return row.id
  }

  const result = db.run(
    "INSERT INTO sessions (phase, projectDir, projectName, gitBranch, startedAt) VALUES (?, ?, ?, ?, ?)",
    ["during", projectDir, name, br, now],
  )
  return Number(result.lastInsertRowid)
}

function syncTodos(db: Database, sessionId: number, todos: any[]) {
  const now = iso()
  db.run("DELETE FROM tasks WHERE sessionId = ?", [sessionId])

  const stmt = db.prepare(
    "INSERT INTO tasks (sessionId, content, status, priority, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  )
  for (const t of todos) {
    stmt.run(sessionId, t.content || "", t.status || "pending", t.priority || "medium", now, now)
  }
}

function logMode(db: Database, mode: string, reason: string | null) {
  db.run("INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)", [mode, reason, iso()])
}

// ── plugin ───────────────────────────────────────────

export const FocusPlugin: Plugin = async (ctx) => {
  return {
    // ── auto-sync on todowrite ──
    "tool.execute.after": async (input, _output) => {
      if (input.tool !== "todowrite") return

      try {
        const db = openDb()
        const todos = input.args?.todos || []
        const dir = ctx.directory || ctx.worktree

        const sid = findOrCreateSession(db, dir)
        syncTodos(db, sid, todos)
        logMode(db, "focused", `Active coding: ${basename(dir)}`)
        db.close()
      } catch (e) {
        // never break the coding flow
        console.error("[focus]", e)
      }
    },

    // ── custom tool: direct focus control ──
    tool: {
      focus: tool({
        description: [
          "Update the Focus menu bar app — the user's cognitive state tracker.",
          "Use this to set or change the current focus session goal, record why it matters,",
          "update the working mode (focused/grounding/unfocused), or end a session.",
          "The Focus app shows a persistent indicator so the user always sees what they're working on.",
        ].join(" "),
        args: {
          goal: tool.schema.string().optional().describe("Current focus session goal"),
          why: tool.schema.string().optional().describe("Why this work matters — connects to larger purpose"),
          trigger: tool.schema.string().optional().describe("What triggered this focus session"),
          mode: tool.schema
            .enum(["focused", "grounding", "unfocused"])
            .optional()
            .describe("Current cognitive mode"),
          modeReason: tool.schema.string().optional().describe("Human-readable reason for this mode"),
          endSession: tool.schema.boolean().optional().describe("Set true to end the current session"),
          endReason: tool.schema
            .enum(["completed", "abandoned", "redefined"])
            .optional()
            .describe("Why the session ended"),
        },
        async execute(args, _context) {
          try {
            const db = openDb()
            const dir = ctx.directory || ctx.worktree
            const now = iso()

            // ── end session ──
            if (args.endSession) {
              const reason = args.endReason || "completed"
              db.run(
                "UPDATE sessions SET endedAt = ?, endReason = ?, phase = 'after' WHERE projectDir = ? AND endedAt IS NULL",
                [now, reason, dir],
              )
              logMode(db, "unfocused", `Session ended: ${reason}`)
              db.close()
              return `Focus session ended (${reason}).`
            }

            // ── update or create session ──
            const sid = findOrCreateSession(db, dir)

            if (args.goal) db.run("UPDATE sessions SET goal = ? WHERE id = ?", [args.goal, sid])
            if (args.why) db.run("UPDATE sessions SET why = ? WHERE id = ?", [args.why, sid])
            if (args.trigger)
              db.run('UPDATE sessions SET "trigger" = ? WHERE id = ?', [args.trigger, sid])

            if (args.mode) logMode(db, args.mode, args.modeReason || null)

            db.close()

            const parts: string[] = []
            if (args.goal) parts.push(`goal → ${args.goal}`)
            if (args.why) parts.push(`why → ${args.why}`)
            if (args.mode) parts.push(`mode → ${args.mode}`)
            return `Focus updated: ${parts.join(", ") || "session refreshed"}`
          } catch (e) {
            return `Focus sync error: ${e}`
          }
        },
      }),
    },
  }
}
