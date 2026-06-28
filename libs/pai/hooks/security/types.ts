/**
 * PAI Security Inspector Pipeline — Shared Types
 *
 * Defines the Inspector interface and InspectionResult type used by all
 * inspectors in the security pipeline. Inspired by Goose's ToolInspector pattern.
 */

// ── Inspection Results ──

export type InspectionAction = 'allow' | 'deny' | 'require_approval' | 'alert';

export interface InspectionResult {
  action: InspectionAction;
  /** Human-readable reason for the decision */
  reason?: string;
  /** Unique finding ID for tracking (e.g., "SEC-pattern-rm-rf") */
  findingId?: string;
  /** For require_approval: the message shown to the user */
  permissionDecisionReason?: string;
}

export const ALLOW: InspectionResult = { action: 'allow' };

export function deny(reason: string, findingId?: string): InspectionResult {
  return { action: 'deny', reason, findingId };
}

export function requireApproval(reason: string, permissionDecisionReason?: string): InspectionResult {
  return {
    action: 'require_approval',
    reason,
    permissionDecisionReason: permissionDecisionReason ?? `[PAI SECURITY] ⚠️ ${reason}\n\nProceed?`,
  };
}

export function alert(reason: string): InspectionResult {
  return { action: 'alert', reason };
}

// ── Inspection Context ──

export interface InspectionContext {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown> | string;
  /** Only present for PostToolUse (content scanning) */
  toolResult?: string;
  /** Only present for UserPromptSubmit */
  prompt?: string;
}

// ── Inspector Interface ──

export interface Inspector {
  /** Inspector name for logging */
  name: string;
  /** Higher priority runs first. Pattern=100, Egress=90, Rules=50 */
  priority: number;
  /** Run inspection and return result */
  inspect(ctx: InspectionContext): Promise<InspectionResult> | InspectionResult;
}

// ── Security Events ──

export interface SecurityEvent {
  timestamp: string;
  sessionId: string;
  eventType: 'block' | 'confirm' | 'alert' | 'allow' | 'injection' | 'exfiltration';
  inspector: string;
  tool: string;
  target: string;
  reason?: string;
  findingId?: string;
  actionTaken: string;
}
