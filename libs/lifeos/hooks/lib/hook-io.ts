/**
 * hook-io.ts — Shared stdin reader for Stop hooks
 *
 * Eliminates duplicated stdin-reading boilerplate across individual hooks.
 * Each hook calls readHookInput() to get the parsed JSON payload, and
 * parseTranscriptFromInput() if it needs the full transcript.
 */

import { parseTranscript, type ParsedTranscript } from '../../LIFEOS/TOOLS/TranscriptParser';

export interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  last_assistant_message?: string;
  /**
   * Active effort level for the current run (Anthropic CC v2.1.133+).
   * Mirrors the same value as `$CLAUDE_EFFORT` in Bash subprocesses.
   * Absent when effort routing is undecided; treat absence as "run full work."
   */
  effort?: {
    level?: string;
  };
  /**
   * Anthropic Stop-hook loop-breaker (documented hook API).
   * `true` when this Stop hook is firing as a follow-up to a previous
   * `{"decision":"block"}` response — the hook MUST short-circuit (continue:true)
   * to avoid deadlocking the session. See OutputFormatGate.hook.ts +
   * VerificationGate.hook.ts for canonical usage.
   */
  stop_hook_active?: boolean;
}

/**
 * Read and parse JSON from stdin with a 2000ms timeout.
 * Returns null if stdin is empty or malformed.
 */
export async function readHookInput(): Promise<HookInput | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const decoder = new TextDecoder();
    reader = Bun.stdin.stream().getReader();
    let input = '';

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 2000);
    });

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;
        input += decoder.decode(value, { stream: true });
      }
    })();

    await Promise.race([readPromise, timeoutPromise]);
    reader.cancel().catch(() => {});

    if (input.trim()) {
      return JSON.parse(input) as HookInput;
    }
  } catch (error) {
    if (reader) reader.cancel().catch(() => {});
    console.error('[hook-io] Error reading stdin:', error);
  }
  return null;
}

/**
 * Parse transcript from hook input. Waits 150ms for transcript to be
 * fully written to disk before parsing.
 */
export async function parseTranscriptFromInput(input: HookInput): Promise<ParsedTranscript> {
  await new Promise(resolve => setTimeout(resolve, 150));
  return parseTranscript(input.transcript_path);
}
