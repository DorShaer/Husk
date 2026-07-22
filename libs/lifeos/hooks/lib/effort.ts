/**
 * Canonical effort-tier normalizer.
 *
 * Single source of truth for parsing the many shapes effort can take in LifeOS:
 * - ISA frontmatter: `effort: E3` (canonical, Algorithm v6.x)
 * - Legacy lowercase tier names: `effort: advanced`
 * - Title-cased tier names: `effort: Advanced`
 * - Native sessions: `effort: native` or `effort: ''`
 * - Anything else: empty / undefined / garbage
 *
 * Every LifeOS surface that reads or writes the `effort` field MUST route through
 * this normalizer so the tier surface stays canonical.
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

/**
 * Parse any effort encoding into the canonical { eLevel, tierName } pair, or
 * return null when the input doesn't represent a real effort tier (native,
 * starting, empty, garbage).
 */
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

/** Canonical write form for work.json `effort` field. Empty string when no tier applies. */
export function effortToCanonicalELevel(input: unknown): '' | EffortELevel {
  const n = normalizeEffort(input);
  return n ? n.eLevel : '';
}

/** Canonical render form for the API boundary `effortLevel` field. Empty string when no tier applies. */
export function effortToCanonicalTierName(input: unknown): '' | EffortTierName {
  const n = normalizeEffort(input);
  return n ? n.tierName : '';
}
