/**
 * SQLite Session Store for Telegram
 *
 * Hermes-parity session and message persistence. Replaces the JSONL
 * ConversationStore with proper relational storage that supports:
 * - Session resume across Pulse restarts
 * - Compression (marking old messages inactive)
 * - Full message history with tool calls
 * - Session metadata (title, cost, tokens)
 *
 * Schema mirrors Hermes's state.db (sessions + messages tables).
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs"
import { join } from "path"

// ── Types ──

export interface Session {
  id: string
  source: string
  started_at: number
  ended_at: number | null
  message_count: number
  input_tokens: number
  output_tokens: number
  estimated_cost_usd: number | null
  title: string | null
  archived: boolean
}

export interface Message {
  id: number
  session_id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string | null
  tool_calls: string | null  // JSON array of tool call objects
  tool_name: string | null
  tool_call_id: string | null
  timestamp: number
  token_count: number | null
  active: boolean  // false = compressed/summarized
}

export interface NewMessage {
  session_id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string | null
  tool_calls?: string | null
  tool_name?: string | null
  tool_call_id?: string | null
  timestamp?: number
  token_count?: number | null
}

// ── Schema ──

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'telegram',
  started_at REAL NOT NULL,
  ended_at REAL,
  message_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL,
  title TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

-- Compression locks (prevent concurrent compression)
CREATE TABLE IF NOT EXISTS compression_locks (
  session_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at REAL NOT NULL,
  expires_at REAL NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_session_active ON messages(session_id, active, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_compression_locks_expires ON compression_locks(expires_at);
`

// ── Store Class ──

export class SessionStore {
  private db: Database
  private readonly dbPath: string

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true })
    this.dbPath = join(stateDir, "sessions.db")
    this.db = new Database(this.dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.initSchema()
  }

  private initSchema(): void {
    const versionRow = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get()
    if (!versionRow) {
      this.db.exec(SCHEMA_SQL)
      this.db.exec(`INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION})`)
    }
    // Future: migration logic when SCHEMA_VERSION increases
  }

  // ── Session Operations ──

  createSession(id?: string): Session {
    const sessionId = id ?? crypto.randomUUID()
    const now = Date.now()
    this.db.run(
      `INSERT INTO sessions (id, source, started_at, message_count, input_tokens, output_tokens, archived)
       VALUES (?, 'telegram', ?, 0, 0, 0, 0)`,
      [sessionId, now]
    )
    return {
      id: sessionId,
      source: "telegram",
      started_at: now,
      ended_at: null,
      message_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: null,
      title: null,
      archived: false,
    }
  }

  getSession(id: string): Session | null {
    const row = this.db.query<any, [string]>(
      `SELECT * FROM sessions WHERE id = ?`
    ).get(id)
    if (!row) return null
    return this.rowToSession(row)
  }

  getRecentSessions(limit: number = 10): Session[] {
    const rows = this.db.query<any, [number]>(
      `SELECT * FROM sessions WHERE archived = 0 ORDER BY started_at DESC LIMIT ?`
    ).all(limit)
    return rows.map(this.rowToSession)
  }

  getLatestSession(): Session | null {
    const row = this.db.query<any, []>(
      `SELECT * FROM sessions WHERE archived = 0 ORDER BY started_at DESC LIMIT 1`
    ).get()
    if (!row) return null
    return this.rowToSession(row)
  }

  updateSession(id: string, updates: Partial<Pick<Session, "ended_at" | "title" | "input_tokens" | "output_tokens" | "estimated_cost_usd" | "archived">>): void {
    const sets: string[] = []
    const values: any[] = []
    if (updates.ended_at !== undefined) { sets.push("ended_at = ?"); values.push(updates.ended_at) }
    if (updates.title !== undefined) { sets.push("title = ?"); values.push(updates.title) }
    if (updates.input_tokens !== undefined) { sets.push("input_tokens = ?"); values.push(updates.input_tokens) }
    if (updates.output_tokens !== undefined) { sets.push("output_tokens = ?"); values.push(updates.output_tokens) }
    if (updates.estimated_cost_usd !== undefined) { sets.push("estimated_cost_usd = ?"); values.push(updates.estimated_cost_usd) }
    if (updates.archived !== undefined) { sets.push("archived = ?"); values.push(updates.archived ? 1 : 0) }
    if (sets.length === 0) return
    values.push(id)
    this.db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, values)
  }

  archiveSession(id: string): void {
    this.updateSession(id, { ended_at: Date.now(), archived: true })
  }

  // ── Message Operations ──

  addMessage(msg: NewMessage): number {
    const timestamp = msg.timestamp ?? Date.now()
    const result = this.db.run(
      `INSERT INTO messages (session_id, role, content, tool_calls, tool_name, tool_call_id, timestamp, token_count, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [msg.session_id, msg.role, msg.content, msg.tool_calls ?? null, msg.tool_name ?? null, msg.tool_call_id ?? null, timestamp, msg.token_count ?? null]
    )
    // Update session message count
    this.db.run(`UPDATE sessions SET message_count = message_count + 1 WHERE id = ?`, [msg.session_id])
    return Number(result.lastInsertRowid)
  }

  addExchange(sessionId: string, userContent: string, assistantContent: string): void {
    const now = Date.now()
    this.addMessage({ session_id: sessionId, role: "user", content: userContent, timestamp: now })
    this.addMessage({ session_id: sessionId, role: "assistant", content: assistantContent, timestamp: now })
  }

  getMessages(sessionId: string, activeOnly: boolean = true): Message[] {
    const query = activeOnly
      ? `SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY timestamp ASC`
      : `SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC`
    const rows = this.db.query<any, [string]>(query).all(sessionId)
    return rows.map(this.rowToMessage)
  }

  getActiveMessageCount(sessionId: string): number {
    const row = this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND active = 1`
    ).get(sessionId)
    return row?.count ?? 0
  }

  /**
   * Mark messages as inactive (compressed). Used after compression summarizes them.
   * @param sessionId Session to compress
   * @param beforeTimestamp Mark all messages before this timestamp as inactive
   * @param keepLast Keep the N most recent messages active regardless of timestamp
   */
  markMessagesInactive(sessionId: string, beforeTimestamp: number, keepLast: number = 0): number {
    // Get IDs of messages to keep (most recent N)
    const keepIds = keepLast > 0
      ? this.db.query<{ id: number }, [string, number]>(
          `SELECT id FROM messages WHERE session_id = ? AND active = 1 ORDER BY timestamp DESC LIMIT ?`
        ).all(sessionId, keepLast).map(r => r.id)
      : []

    const keepClause = keepIds.length > 0 ? ` AND id NOT IN (${keepIds.join(",")})` : ""
    const result = this.db.run(
      `UPDATE messages SET active = 0 WHERE session_id = ? AND timestamp < ? AND active = 1${keepClause}`,
      [sessionId, beforeTimestamp]
    )
    return result.changes
  }

  // ── Compression Lock ──

  acquireCompressionLock(sessionId: string, holder: string, ttlMs: number = 60_000): boolean {
    const now = Date.now()
    // Clean up expired locks
    this.db.run(`DELETE FROM compression_locks WHERE expires_at < ?`, [now])
    // Try to acquire
    try {
      this.db.run(
        `INSERT INTO compression_locks (session_id, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)`,
        [sessionId, holder, now, now + ttlMs]
      )
      return true
    } catch {
      // Lock exists and not expired
      return false
    }
  }

  releaseCompressionLock(sessionId: string, holder: string): void {
    this.db.run(`DELETE FROM compression_locks WHERE session_id = ? AND holder = ?`, [sessionId, holder])
  }

  // ── Migration ──

  /**
   * Migrate from JSONL ConversationStore format.
   * Groups messages into sessions by timestamp gaps (>60min = new session).
   */
  migrateFromJsonl(jsonlPath: string): { sessions: number; messages: number } {
    if (!existsSync(jsonlPath)) return { sessions: 0, messages: 0 }

    // readFileSync, not Bun.file().text() — .text() is async and this method is
    // synchronous; calling .split() on the returned Promise crash-looped the
    // whole Telegram module at boot (2026-07-09 outage).
    const content = readFileSync(jsonlPath, "utf8")
    const lines = content.split(/\r?\n/).filter(l => l.length > 0)
    const messages: Array<{ role: string; content: string; timestamp: number }> = []

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (msg.role && msg.content !== undefined) {
          messages.push({
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp ?? Date.now(),
          })
        }
      } catch { /* skip malformed lines */ }
    }

    if (messages.length === 0) return { sessions: 0, messages: 0 }

    // Group into sessions by 60-minute gaps
    const IDLE_GAP_MS = 60 * 60 * 1000
    const sessionGroups: Array<typeof messages> = []
    let currentGroup: typeof messages = []

    for (const msg of messages.sort((a, b) => a.timestamp - b.timestamp)) {
      if (currentGroup.length > 0) {
        const lastTs = currentGroup[currentGroup.length - 1]!.timestamp
        if (msg.timestamp - lastTs > IDLE_GAP_MS) {
          sessionGroups.push(currentGroup)
          currentGroup = []
        }
      }
      currentGroup.push(msg)
    }
    if (currentGroup.length > 0) sessionGroups.push(currentGroup)

    // Insert into SQLite
    let totalMessages = 0
    for (const group of sessionGroups) {
      const session = this.createSession()
      for (const msg of group) {
        this.addMessage({
          session_id: session.id,
          role: msg.role as "user" | "assistant",
          content: msg.content,
          timestamp: msg.timestamp,
        })
        totalMessages++
      }
    }

    // Rename old file
    renameSync(jsonlPath, `${jsonlPath}.migrated`)

    return { sessions: sessionGroups.length, messages: totalMessages }
  }

  // ── Helpers ──

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      source: row.source,
      started_at: row.started_at,
      ended_at: row.ended_at,
      message_count: row.message_count,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      estimated_cost_usd: row.estimated_cost_usd,
      title: row.title,
      archived: row.archived === 1,
    }
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      tool_calls: row.tool_calls,
      tool_name: row.tool_name,
      tool_call_id: row.tool_call_id,
      timestamp: row.timestamp,
      token_count: row.token_count,
      active: row.active === 1,
    }
  }

  // ── Lifecycle ──

  close(): void {
    this.db.close()
  }
}
