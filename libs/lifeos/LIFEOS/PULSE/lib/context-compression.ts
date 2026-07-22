/**
 * Context Compression for Telegram Sessions
 *
 * When a session's active messages approach the context limit, this module
 * summarizes older turns into a compact summary block. The original messages
 * are marked inactive (preserved for history) and the summary replaces them
 * in the active context.
 *
 * Design from Hermes:
 * - Compression lock prevents concurrent compression
 * - Sonnet handles summarization (fast, good at distillation)
 * - Protected window: always keep the N most recent turns active
 * - Summary preserves: decisions, code changes, file paths, key facts
 * - Summary discards: verbose tool outputs, repeated attempts, interim thinking
 */

import { inference } from "../../TOOLS/Inference"
import type { SessionStore, Message } from "./session-store"

// ── Config ──

/** Compress when active tokens exceed this fraction of context limit */
const COMPRESSION_THRESHOLD_PERCENT = 0.60

/** Approximate context limit for Opus (tokens) */
const CONTEXT_LIMIT_TOKENS = 200_000

/** Target compression: aim for this fraction of original size */
const TARGET_COMPRESSION_RATIO = 0.20

/** Always keep at least this many recent messages active */
const PROTECT_LAST_N = 20

/** Always keep the first N messages (initial context) */
const PROTECT_FIRST_N = 3

/** Compression lock TTL */
const LOCK_TTL_MS = 120_000

/** Rough chars-to-tokens ratio for estimation */
const CHARS_PER_TOKEN = 4

// ── Compression ──

export interface CompressionResult {
  success: boolean
  messagesCompressed: number
  summaryTokens: number | null
  error?: string
}

/**
 * Estimate token count for messages.
 * Uses a simple chars/4 heuristic; good enough for threshold checks.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const msg of messages) {
    if (msg.content) chars += msg.content.length
    if (msg.tool_calls) chars += msg.tool_calls.length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Check if a session needs compression.
 */
export function needsCompression(messages: Message[]): boolean {
  const tokens = estimateTokens(messages)
  const threshold = CONTEXT_LIMIT_TOKENS * COMPRESSION_THRESHOLD_PERCENT
  return tokens > threshold
}

/**
 * Build the summarization prompt for Sonnet.
 */
function buildSummarizationPrompt(messages: Message[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    const role = msg.role === "user" ? "Principal" : msg.role === "assistant" ? "{{DA_NAME}}" : msg.role
    let text = msg.content ?? ""

    // Truncate very long tool outputs
    if (msg.role === "tool" && text.length > 2000) {
      text = text.slice(0, 2000) + "\n[...truncated tool output...]"
    }

    parts.push(`[${role}]: ${text}`)
  }

  return parts.join("\n\n")
}

/**
 * Compress a session's older messages into a summary.
 *
 * @param store Session store instance
 * @param sessionId Session to compress
 * @param holder Unique identifier for the compression holder (for lock)
 * @returns Compression result
 */
export async function compressSession(
  store: SessionStore,
  sessionId: string,
  holder: string
): Promise<CompressionResult> {
  // Acquire lock
  if (!store.acquireCompressionLock(sessionId, holder, LOCK_TTL_MS)) {
    return { success: false, messagesCompressed: 0, summaryTokens: null, error: "compression already in progress" }
  }

  try {
    const messages = store.getMessages(sessionId, true)  // active only

    // Identify messages to compress (all except protected window)
    const toCompress: Message[] = []
    const totalCount = messages.length

    // Protect first N and last N
    for (let i = 0; i < messages.length; i++) {
      if (i < PROTECT_FIRST_N) continue
      if (i >= totalCount - PROTECT_LAST_N) continue
      toCompress.push(messages[i]!)
    }

    if (toCompress.length < 5) {
      // Not enough to compress
      return { success: true, messagesCompressed: 0, summaryTokens: null }
    }

    // Build conversation transcript for summarization
    const transcript = buildSummarizationPrompt(toCompress)

    // Call Sonnet for summarization
    const systemPrompt = `You are summarizing a conversation between {{PRINCIPAL_NAME}} (the principal) and {{DA_NAME}} (his AI assistant).

Create a concise summary that preserves:
- Key decisions made
- Code changes and file paths mentioned
- Important facts learned
- Action items or next steps agreed upon

Discard:
- Verbose tool outputs (just note what tool was used and the outcome)
- Repeated failed attempts (just note what was tried and final result)
- Interim thinking or exploration
- Pleasantries and filler

Format as a dense paragraph or short bullets. Aim for ${Math.ceil(toCompress.length * TARGET_COMPRESSION_RATIO)} sentences or fewer.`

    const result = await inference({
      systemPrompt,
      userPrompt: `Summarize this conversation excerpt:\n\n${transcript}`,
      level: "medium",  // Sonnet
      timeout: 60_000,
    })

    if (!result.success || !result.output) {
      return { success: false, messagesCompressed: 0, summaryTokens: null, error: result.error ?? "summarization failed" }
    }

    const summary = result.output.trim()
    const summaryTokens = Math.ceil(summary.length / CHARS_PER_TOKEN)

    // Mark old messages as inactive
    const lastCompressedTs = toCompress[toCompress.length - 1]!.timestamp
    const compressedCount = store.markMessagesInactive(sessionId, lastCompressedTs + 1, PROTECT_LAST_N)

    // Insert summary as a system message
    store.addMessage({
      session_id: sessionId,
      role: "system",
      content: `[Conversation summary - ${compressedCount} messages compressed]\n\n${summary}`,
      timestamp: toCompress[0]!.timestamp - 1,  // Place before the compressed range
      token_count: summaryTokens,
    })

    return { success: true, messagesCompressed: compressedCount, summaryTokens }
  } finally {
    store.releaseCompressionLock(sessionId, holder)
  }
}

/**
 * Build a compression holder ID for this process.
 */
export function buildCompressionHolder(): string {
  return `pid=${process.pid}:ts=${Date.now()}:nonce=${crypto.randomUUID().slice(0, 8)}`
}
