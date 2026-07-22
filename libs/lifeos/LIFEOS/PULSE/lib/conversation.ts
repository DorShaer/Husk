/**
 * Conversation Persistence
 *
 * Adapted from LifeOS Monitor's ConversationStore.
 * JSONL append log with atomic migration/compaction writes.
 * Rolling window of last 40 messages (~20 exchanges).
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"

export interface ConversationMessage {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

export class ConversationStore {
  private messages: ConversationMessage[] = []
  private readonly path: string
  private readonly jsonlPath: string
  private readonly maxMessages: number

  constructor(path: string, maxMessages = 40) {
    this.path = path
    this.jsonlPath = path.endsWith(".json") ? path.replace(/\.json$/, ".jsonl") : `${path}.jsonl`
    this.maxMessages = maxMessages
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.jsonlPath)) {
        const lines = this.readJsonlLines()
        this.messages = this.parseMessages(lines).slice(-this.maxMessages)
        if (lines.length > 10 * this.maxMessages) {
          this.writeMessagesAtomically(this.messages)
        }
        return
      }

      if (existsSync(this.path)) {
        const legacy = JSON.parse(readFileSync(this.path, "utf8")) as ConversationMessage[]
        this.messages = legacy.slice(-this.maxMessages)
        this.writeMessagesAtomically(legacy)
        renameSync(this.path, `${this.path}.migrated`)
      }
    } catch {
      this.messages = []
    }
  }

  getHistory(): ConversationMessage[] {
    return this.messages.slice()
  }

  async addExchange(userContent: string, assistantContent: string): Promise<void> {
    const now = Date.now()
    const userMessage: ConversationMessage = { role: "user", content: userContent, timestamp: now }
    const assistantMessage: ConversationMessage = { role: "assistant", content: assistantContent, timestamp: now }
    this.messages.push(
      userMessage,
      assistantMessage,
    )

    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages)
    }

    appendFileSync(this.jsonlPath, [
      JSON.stringify(userMessage),
      JSON.stringify(assistantMessage),
      "",
    ].join("\n"), "utf8")
  }

  private readJsonlLines(): string[] {
    return readFileSync(this.jsonlPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
  }

  private parseMessages(lines: string[]): ConversationMessage[] {
    const messages: ConversationMessage[] = []
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as ConversationMessage)
      } catch {}
    }
    return messages
  }

  private writeMessagesAtomically(messages: ConversationMessage[]): void {
    const tmp = `${this.jsonlPath}.tmp`
    const content = messages.map((message) => JSON.stringify(message)).join("\n")
    writeFileSync(tmp, content ? `${content}\n` : "", "utf8")
    renameSync(tmp, this.jsonlPath)
  }
}
