/**
 * Canonical effort-tier normalizer (frontend twin of ~/.claude/hooks/lib/effort.ts).
 *
 * MUST stay in sync with the backend copy. Next.js static export cannot import
 * outside src/, so this file duplicates the logic. If you change one, change
 * both — see ~/.claude/LIFEOS/MEMORY/WORK/20260507-pulse-effort-tag-fix/ISA.md
 * Decisions for the rationale.
 */

export type EffortELevel = 'E1' | 'E2' | 'E3' | 'E4' | 'E5';
export type EffortTierName = 'Standard' | 'Extended' | 'Advanced' | 'Deep' | 'Comprehensive';

export interface NormalizedEffort {
  eLevel: EffortELevel;
  tierName: EffortTierName;
}

const TIER_BY_E: Record<EffortELevel, EffortTierName> = {
  E1: 'Standard',
  E2: 'Extended',
  E3: 'Advanced',
  E4: 'Deep',
  E5: 'Comprehensive',
};

const E_BY_TIER: Record<string, EffortELevel> = {
  standard: 'E1',
  extended: 'E2',
  advanced: 'E3',
  deep: 'E4',
  comprehensive: 'E5',
};

export function normalizeEffort(input: unknown): NormalizedEffort | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const eMatch = trimmed.match(/^[Ee]([1-5])$/);
  if (eMatch) {
    const eLevel = `E${eMatch[1]}` as EffortELevel;
    return { eLevel, tierName: TIER_BY_E[eLevel] };
  }

  const lower = trimmed.toLowerCase();
  if (lower in E_BY_TIER) {
    const eLevel = E_BY_TIER[lower];
    return { eLevel, tierName: TIER_BY_E[eLevel] };
  }

  return null;
}
