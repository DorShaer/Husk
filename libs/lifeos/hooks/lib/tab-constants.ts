/**
 * tab-constants.ts - Single source of truth for tab title colors and states.
 *
 * All hooks that touch tab titles import from here.
 * No more independent color definitions across 6 files.
 *
 * Phase-aware tabs: Each Algorithm phase gets a distinct background color
 * and symbol, so multiple Kitty tabs show at-a-glance where each session
 * is in the Algorithm.
 */

// Each state carries its inactive-tab background AND text color. Dark backgrounds
// use light gray text (#A0A0A0); light/bright backgrounds need dark text or the
// gray washes out (the native-orange case — gray on #C2660A was ~1.5:1).
export const TAB_COLORS = {
  thinking:  { inactiveBg: '#1E0A3C', inactiveFg: '#A0A0A0', label: 'purple' },
  working:   { inactiveBg: '#804000', inactiveFg: '#A0A0A0', label: 'orange' },
  // NATIVE-mode working state — a lighter, brighter orange so native turns are
  // visually distinct from Algorithm's darker build/execute oranges. Dark text
  // for legibility on the bright fill (~5:1 vs the gray's ~1.5:1).
  native:    { inactiveBg: '#C2660A', inactiveFg: '#1A1206', label: 'native-orange' },
  question:  { inactiveBg: '#0D4F4F', inactiveFg: '#A0A0A0', label: 'teal' },
  completed: { inactiveBg: '#022800', inactiveFg: '#A0A0A0', label: 'green' },
  error:     { inactiveBg: '#804000', inactiveFg: '#A0A0A0', label: 'orange' },
  idle:      { inactiveBg: 'none',    inactiveFg: 'none',    label: 'default' },
} as const;

export const ACTIVE_TAB_BG = '#002B80';
export const ACTIVE_TAB_FG = '#FFFFFF';
export const INACTIVE_TAB_FG = '#A0A0A0';

export type TabState = keyof typeof TAB_COLORS;

/**
 * Phase-specific tab configuration.
 * Each Algorithm phase has a unique symbol and dark background color
 * optimized for readability with light text on Kitty tab bar.
 */
export const PHASE_TAB_CONFIG: Record<string, { symbol: string; inactiveBg: string; label: string; gerund: string }> = {
  OBSERVE:  { symbol: '👁️', inactiveBg: '#0C2D48', label: 'observe',  gerund: 'Observing.' },
  THINK:    { symbol: '🧠', inactiveBg: '#2D1B69', label: 'think',    gerund: 'Thinking.' },
  PLAN:     { symbol: '📋', inactiveBg: '#1E1B4B', label: 'plan',     gerund: 'Planning.' },
  BUILD:    { symbol: '🔨', inactiveBg: '#78350F', label: 'build',    gerund: 'Building.' },
  EXECUTE:  { symbol: '⚡', inactiveBg: '#713F12', label: 'execute',  gerund: 'Executing.' },
  VERIFY:   { symbol: '✅', inactiveBg: '#14532D', label: 'verify',   gerund: 'Verifying.' },
  LEARN:    { symbol: '📚', inactiveBg: '#134E4A', label: 'learn',    gerund: 'Learning.' },
  COMPLETE: { symbol: '✅', inactiveBg: '#022800', label: 'complete', gerund: 'Complete.' },
  IDLE:     { symbol: '',   inactiveBg: 'none',    label: 'idle',     gerund: '' },
};

export type AlgorithmTabPhase = keyof typeof PHASE_TAB_CONFIG;
