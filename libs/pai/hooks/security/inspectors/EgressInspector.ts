/**
 * EgressInspector — Monitors outbound data exfiltration patterns in Bash commands.
 * Priority 90: runs after PatternInspector (100), before RulesInspector (50).
 */
import type { Inspector, InspectionContext, InspectionResult } from '../types.ts';
import { ALLOW, deny, alert } from '../types.ts';

const OUTBOUND_TOOLS = /\b(curl|wget|nc|ncat|fetch|http)\b/i;

const CREDENTIAL_PATTERNS: [RegExp, string][] = [
  [/sk_live_/i, 'Stripe live key'],
  [/sk_test_/i, 'Stripe test key'],
  [/sk-ant-/i, 'Anthropic API key'],
  [/sk-proj-/i, 'OpenAI project key'],
  [/PRIVATE KEY/i, 'Private key material'],
  [/whsec_/i, 'Webhook secret'],
];

const EGRESS_ALERTS: [RegExp, string][] = [
  [/curl.*(-X POST|--data|\s-d\s)/i, 'HTTP POST via curl'],
  [/wget.*(--post-data|--post-file)/i, 'HTTP POST via wget'],
  [/\bnc\s/i, 'Netcat usage'],
  [/\bncat\s/i, 'Ncat usage'],
  [/\bsocat\s/i, 'Socat usage'],
  [/sendmail\b/i, 'Sendmail usage'],
  [/^(printenv|env)\s*$/i, 'Environment variable dump'],
  [/^set\s*$/i, 'Shell variable dump'],
  [/python3?\s+-c\s/i, 'Python inline execution'],
  [/node\s+-e\s/i, 'Node inline execution'],
  [/ruby\s+-e\s/i, 'Ruby inline execution'],
  [/perl\s+-e\s/i, 'Perl inline execution'],
];

const PIPE_TO_SHELL = /\|\s*(sh|bash|zsh)\b/i;

class EgressInspector implements Inspector {
  name = 'EgressInspector';
  priority = 90;

  inspect(ctx: InspectionContext): InspectionResult {
    if (ctx.toolName !== 'Bash') return ALLOW;

    const command =
      typeof ctx.toolInput === 'string'
        ? ctx.toolInput
        : (ctx.toolInput.command as string | undefined) ?? '';

    if (!command) return ALLOW;

    // Credential exfiltration — only when combined with outbound tools
    if (OUTBOUND_TOOLS.test(command)) {
      for (const [pattern, label] of CREDENTIAL_PATTERNS) {
        if (pattern.test(command)) {
          return deny(`Credential exfiltration blocked: ${label} sent via outbound tool`);
        }
      }
    }

    // Pipe to shell interpreter
    if (PIPE_TO_SHELL.test(command)) {
      return deny('Piping output to shell interpreter');
    }

    // Egress monitoring — alert but allow
    for (const [pattern, label] of EGRESS_ALERTS) {
      if (pattern.test(command)) {
        return alert(`Egress detected: ${label}`);
      }
    }

    return ALLOW;
  }
}

export function createEgressInspector(): Inspector {
  return new EgressInspector();
}
