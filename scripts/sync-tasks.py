#!/usr/bin/env python3
"""
PostToolUse hook — syncs Claude Code TodoWrite to Focus's SQLite database.

Install in ~/.claude/settings.json:

{
  "hooks": {
    "PostToolUse": [{
      "matcher": "TodoWrite",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/sync-tasks.py",
        "timeout": 5
      }]
    }]
  }
}
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_branch():
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def ensure_tables(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phase TEXT NOT NULL DEFAULT 'during',
            goal TEXT, why TEXT, "trigger" TEXT,
            projectDir TEXT, projectName TEXT, gitBranch TEXT,
            startedAt TEXT NOT NULL, endedAt TEXT, endReason TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId INTEGER REFERENCES sessions(id),
            content TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            priority TEXT NOT NULL DEFAULT 'medium',
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mode_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL, reason TEXT,
            detectedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS self_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mood TEXT NOT NULL, note TEXT,
            reportedAt TEXT NOT NULL
        );
    """)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("{}")
        return

    if data.get("tool_name") != "TodoWrite":
        print("{}")
        return

    todos = data.get("tool_input", {}).get("todos", [])
    project_dir = os.environ.get("PWD", os.getcwd())
    project_name = os.path.basename(project_dir)
    branch = git_branch()
    now = iso_now()

    db_dir = os.path.expanduser("~/.config/focus")
    os.makedirs(db_dir, exist_ok=True)
    db_path = os.path.join(db_dir, "focus.db")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    ensure_tables(conn)

    # Find or create session for this project
    row = conn.execute(
        "SELECT id FROM sessions WHERE projectDir = ? AND endedAt IS NULL "
        "ORDER BY startedAt DESC LIMIT 1",
        (project_dir,),
    ).fetchone()

    if row:
        session_id = row[0]
        # update branch if changed
        conn.execute(
            "UPDATE sessions SET gitBranch = ? WHERE id = ?",
            (branch, session_id),
        )
    else:
        cur = conn.execute(
            "INSERT INTO sessions (phase, projectDir, projectName, gitBranch, startedAt) "
            "VALUES (?, ?, ?, ?, ?)",
            ("during", project_dir, project_name, branch, now),
        )
        session_id = cur.lastrowid

    # Replace tasks for this session
    conn.execute("DELETE FROM tasks WHERE sessionId = ?", (session_id,))
    for t in todos:
        conn.execute(
            "INSERT INTO tasks (sessionId, content, status, priority, createdAt, updatedAt) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                session_id,
                t.get("content", ""),
                t.get("status", "pending"),
                t.get("priority", "medium"),
                now,
                now,
            ),
        )

    # Log as focused
    conn.execute(
        "INSERT INTO mode_log (mode, reason, detectedAt) VALUES (?, ?, ?)",
        ("focused", f"Active coding: {project_name}", now),
    )

    conn.commit()
    conn.close()
    print("{}")


if __name__ == "__main__":
    main()
