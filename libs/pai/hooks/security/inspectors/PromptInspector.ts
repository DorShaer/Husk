/**
 * PromptInspector — Scans user prompts for injection, exfiltration, and evasion
 *
 * Runs on UserPromptSubmit to catch malicious intent BEFORE the LLM processes it.
 * Complements SecurityPipeline (tool inputs) and ContentScanner (tool outputs).
 *
 * Heuristic-only — no LLM inference. Two-phase exfiltration detection:
 * sensitive data reference + outbound intent must BOTH match (reduces false positives).
 */

import type { Inspector, InspectionContext, InspectionResult } from '../types';
import { ALLOW, alert, deny } from '../types';

interface PatternDef {
  regex: RegExp;
  category: 'injection' | 'exfiltration' | 'evasion' | 'security_disable';
  description: string;
  severity: 'block' | 'warn';
}

// ── Injection: attempts to override instructions ──

const INJECTION_PATTERNS: PatternDef[] = [
  { regex: /ignore\s+(all\s+)?previous\s+instructions/i, category: 'injection', description: 'Ignore previous instructions', severity: 'block' },
  { regex: /forget\s+(everything|what|all|your)/i, category: 'injection', description: 'Forget context directive', severity: 'block' },
  { regex: /your\s+new\s+(instructions|role|task)\s+(are|is)/i, category: 'injection', description: 'New instructions directive', severity: 'block' },
  { regex: /you\s+are\s+now\s+a\s/i, category: 'injection', description: 'Role reassignment attempt', severity: 'block' },
  { regex: /disregard\s+(all\s+)?(prior|previous|above)/i, category: 'injection', description: 'Disregard prior instructions', severity: 'block' },
  { regex: /system\s+override\s*:/i, category: 'injection', description: 'System override directive', severity: 'block' },
  { regex: /\[SYSTEM\]\s*:/i, category: 'injection', description: 'System message impersonation', severity: 'block' },
  { regex: /\[ADMIN\]\s*:/i, category: 'injection', description: 'Admin message impersonation', severity: 'block' },
  { regex: /do\s+not\s+(follow|obey|listen|apply)\s+(your|the|any|previous)/i, category: 'injection', description: 'Instruction override attempt', severity: 'block' },
];

// ── Security disable: attempts to weaken defenses ──

const SECURITY_DISABLE_PATTERNS: PatternDef[] = [
  { regex: /disable\s+(all\s+)?(security|logging|hooks?|monitoring|protection)/i, category: 'security_disable', description: 'Security disable directive', severity: 'block' },
  { regex: /skip\s+(all\s+)?(security|validation|checks?|hooks?)/i, category: 'security_disable', description: 'Security skip directive', severity: 'block' },
  { regex: /turn\s+off\s+(all\s+)?(security|logging|monitoring)/i, category: 'security_disable', description: 'Security turn-off directive', severity: 'block' },
];

// ── Evasion: encoded payloads ──

const EVASION_PATTERNS: PatternDef[] = [
  { regex: /\batob\s*\(/i, category: 'evasion', description: 'Base64 decode function', severity: 'warn' },
  { regex: /\bbase64\s+(-d|--decode|decode)\b/i, category: 'evasion', description: 'Base64 decode command', severity: 'warn' },
  { regex: /\becho\s+[A-Za-z0-9+/=]{20,}\s*\|\s*(base64|openssl)/i, category: 'evasion', description: 'Encoded payload piped to decoder', severity: 'block' },
  { regex: /\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}/i, category: 'evasion', description: 'Hex-encoded content', severity: 'warn' },
];

// ── Exfiltration: sensitive data + outbound intent (both must match) ──

const SENSITIVE_DATA_PATTERNS = [
  /\.env\b/i, /\bapi[_-]?key\b/i, /\bsecret[_-]?key\b/i, /\bcredential/i,
  /\bprivate[_-]?key\b/i, /\bssh[_-]?key\b/i, /\baws[_-]?access/i,
];

const EXFILTRATION_INTENT = [
  /\bsend\b.{0,30}\bto\s+(https?:|an?\s|the\s|my\s)/i,
  /\bpost\b.{0,30}\bto\s+(https?:|an?\s|the\s|my\s)/i,
  /\bupload\b.{0,30}\bto\s/i,
  /\bforward\b.{0,30}\bto\s/i,
  /\bexfiltrat/i,
  /\bpipe\b.{0,20}\bto\s/i,
  /\bsend\s+(the\s+)?(contents?|data|output|file|keys?|tokens?|secrets?|credentials?)\b/i,
];

const ALL_PATTERNS = [...INJECTION_PATTERNS, ...SECURITY_DISABLE_PATTERNS, ...EVASION_PATTERNS];

class PromptInspector implements Inspector {
  name = 'PromptInspector';
  priority = 95;

  inspect(ctx: InspectionContext): InspectionResult {
    const prompt = ctx.prompt;
    if (!prompt || prompt.length < 10) return ALLOW;

    const hits: Array<{ description: string; category: string; severity: string }> = [];

    for (const { regex, category, description, severity } of ALL_PATTERNS) {
      if (regex.test(prompt)) {
        hits.push({ description, category, severity });
      }
    }

    // Two-phase exfiltration: sensitive data reference + outbound intent
    const hasSensitive = SENSITIVE_DATA_PATTERNS.some(p => p.test(prompt));
    if (hasSensitive) {
      for (const pattern of EXFILTRATION_INTENT) {
        if (pattern.test(prompt)) {
          hits.push({ description: 'Sensitive data + exfiltration intent', category: 'exfiltration', severity: 'block' });
          break;
        }
      }
    }

    if (hits.length === 0) return ALLOW;

    const hasBlock = hits.some(h => h.severity === 'block');
    const categories = [...new Set(hits.map(h => h.category))];
    const descriptions = hits.map(h => h.description).join(', ');
    const reason = `Prompt security: ${categories.join('+')} — ${descriptions}`;

    if (hasBlock) {
      return deny(reason, `SEC-prompt-${categories[0]}`);
    }

    return alert(reason);
  }
}

export function createPromptInspector(): PromptInspector {
  return new PromptInspector();
}
