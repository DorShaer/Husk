/**
 * RulesInspector — Evaluates tool calls against user-written natural language
 * security rules in SECURITY_RULES.md (inspired by Goose's adversary.md pattern).
 *
 * Priority 50: runs last (most expensive — requires LLM call per unique invocation).
 * Only activates if SECURITY_RULES.md exists and contains content.
 * Session-level caching ensures repeated identical calls skip the LLM.
 */
import type { Inspector, InspectionContext, InspectionResult } from '../types.ts';
import { ALLOW, deny } from '../types.ts';
import { paiPath } from '../../lib/paths.ts';
import { inference } from '../../../PAI/TOOLS/Inference.ts';
import { readFileSync, existsSync } from 'fs';

const RULES_PATH = paiPath('USER', 'SECURITY', 'SECURITY_RULES.md');

const SYSTEM_PROMPT = `You are a security policy evaluator. Given a tool call and a set of user-written security rules, determine if the tool call should be ALLOWED or BLOCKED.

Rules are written in natural language with ## BLOCK and ## ALLOW sections.
- BLOCK rules describe operations that must be denied.
- ALLOW rules describe operations that are explicitly permitted.
- If the tool call matches a BLOCK rule, respond BLOCK.
- If the tool call matches an ALLOW rule, respond ALLOW.
- If no rule matches, respond ALLOW (default allow).

Respond with EXACTLY this JSON, no markdown:
{"decision":"ALLOW","reason":"one sentence"}
or
{"decision":"BLOCK","reason":"one sentence"}`;

/** Simple cache key: toolName + first 100 chars of input */
function cacheKey(toolName: string, toolInput: string): string {
  return `${toolName}:${toolInput.slice(0, 100)}`;
}

/** Extract a string representation of tool input, truncated to 500 chars */
function extractToolInput(ctx: InspectionContext): string {
  if (typeof ctx.toolInput === 'string') {
    return ctx.toolInput.slice(0, 500);
  }
  const input = ctx.toolInput;
  const value = (input.command ?? input.file_path ?? JSON.stringify(input)) as string;
  return String(value).slice(0, 500);
}

class RulesInspector implements Inspector {
  name = 'RulesInspector';
  priority = 50;

  private rulesCache: string | null = null;
  private rulesLoaded = false;
  private resultCache = new Map<string, InspectionResult>();

  /** Load rules once per process, cache the content */
  private loadRules(): string | null {
    if (this.rulesLoaded) return this.rulesCache;
    this.rulesLoaded = true;

    if (!existsSync(RULES_PATH)) {
      this.rulesCache = null;
      return null;
    }

    const content = readFileSync(RULES_PATH, 'utf-8').trim();
    this.rulesCache = content.length > 0 ? content : null;
    return this.rulesCache;
  }

  async inspect(ctx: InspectionContext): Promise<InspectionResult> {
    const rules = this.loadRules();
    if (!rules) return ALLOW;

    const toolInput = extractToolInput(ctx);
    const key = cacheKey(ctx.toolName, toolInput);

    // Return cached result for identical tool calls
    const cached = this.resultCache.get(key);
    if (cached) return cached;

    // Build prompt and call haiku
    try {
      const result = await inference({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `Tool: ${ctx.toolName}\nInput: ${toolInput}\n\nSecurity Rules:\n${rules}`,
        level: 'fast',
        expectJson: true,
        timeout: 3000,
      });

      if (result.success && result.parsed) {
        const parsed = result.parsed as { decision?: string; reason?: string };
        const decision = parsed.decision?.toUpperCase();
        const reason = parsed.reason ?? 'Security rule matched';

        if (decision === 'BLOCK') {
          const blocked = deny(reason, `SEC-rules-${Date.now()}`);
          this.resultCache.set(key, blocked);
          return blocked;
        }

        // ALLOW or any other response
        this.resultCache.set(key, ALLOW);
        return ALLOW;
      }

      // Inference failed to parse — fail open
      return ALLOW;
    } catch {
      // Inference threw — fail open
      return ALLOW;
    }
  }
}

export function createRulesInspector(): Inspector {
  return new RulesInspector();
}
