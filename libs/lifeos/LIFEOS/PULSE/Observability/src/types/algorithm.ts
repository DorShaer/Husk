export type AlgorithmPhase = 'OBSERVE' | 'THINK' | 'PLAN' | 'BUILD' | 'EXECUTE' | 'VERIFY' | 'LEARN' | 'IDLE' | 'COMPLETE';

export interface AlgorithmCriterion {
  id: string;
  description: string;
  type: 'criterion' | 'anti-criterion';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  evidence?: string;
  createdInPhase: AlgorithmPhase;
}

export interface AlgorithmAgent {
  name: string;
  agentType: string;
  status: 'active' | 'idle' | 'completed';
  task?: string;
  phase: AlgorithmPhase;
}

export interface PhaseEntry {
  phase: AlgorithmPhase;
  startedAt: number;
  completedAt?: number;
  criteriaCount: number;
  agentCount: number;
  phaseNarrative?: string;
  /** True if this phase visit is part of a rework cycle */
  isRework?: boolean;
  /** Which rework iteration (0 = initial run, 1+ = rework) */
  reworkIteration?: number;
}

/** Archive of a completed algorithm cycle (preserved during rework) */
export interface ReworkCycle {
  iteration: number;
  startedAt: number;
  completedAt: number;
  fromPhase: AlgorithmPhase;
  toPhase: AlgorithmPhase;
  criteria: AlgorithmCriterion[];
  summary?: string;
  effortLevel: string;
  phaseHistory: PhaseEntry[];
}

export type EffortLevel = 'Native' | 'Standard' | 'Extended' | 'Advanced' | 'Deep' | 'Comprehensive';

export interface CompletedWork {
  taskDescription: string;
  completedAt: number;
  summary?: string;
  criteria: AlgorithmCriterion[];
  phaseHistory: PhaseEntry[];
  effortLevel: EffortLevel;
  /** @deprecated Use effortLevel */
  sla?: EffortLevel;
}

export type SessionMode = 'minimal' | 'native' | 'algorithm';

export interface ModeTransition {
  mode: SessionMode;
  startedAt: number;
  endedAt?: number;
  trigger?: string;
}

export interface RatingPulse {
  value: number;
  timestamp: number;
  message?: string;
}

export interface AlgorithmState {
  active: boolean;
  sessionId: string;
  taskDescription: string;
  currentPhase: AlgorithmPhase;
  phaseStartedAt: number;
  algorithmStartedAt: number;
  effortLevel: EffortLevel;
  /** @deprecated Use effortLevel — kept for reading old state files */
  sla?: EffortLevel;
  criteria: AlgorithmCriterion[];
  agents: AlgorithmAgent[];
  capabilities: string[];
  /** Path to the session's Ideal State Artifact (ISA.md, or legacy PRD.md). */
  isaPath?: string;
  /** @deprecated use isaPath. Kept so older state files still parse. */
  prdPath?: string;
  phaseHistory: PhaseEntry[];
  qualityGate?: {
    count: boolean;
    length: boolean;
    state: boolean;
    testable: boolean;
    anti: boolean;
    open: boolean;
  };
  currentAction?: string;
  mode?: string;
  rawTask?: string;
  completedAt?: number;
  summary?: string;
  abandoned?: boolean;
  workHistory?: CompletedWork[];
  compactionEvents?: number[];
  /** Number of times this session re-entered the algorithm after completion */
  reworkCount?: number;
  /** True when currently in a rework cycle (vs initial run) */
  isRework?: boolean;
  /** Archive of each completed algorithm cycle */
  reworkHistory?: ReworkCycle[];
  /** History of session name changes on rework (for name rejuvenation display) */
  previousNames?: Array<{ name: string; changedAt: string }>;
  /** Current LifeOS mode for this session */
  currentMode?: SessionMode;
  /** History of mode transitions within this session */
  modeHistory?: ModeTransition[];
  /** Recent MINIMAL ratings within this session */
  ratings?: RatingPulse[];
  /** Count of MINIMAL interactions in this session */
  minimalCount?: number;
  /** Tunable parameter configuration for this session */
  algorithmConfig?: {
    preset: string | null;
    focus: number | null;
    params: Record<string, number | string>;
    mode: string;
  };
  /** Intent snippet extracted from ISA body — shown when no criteria are parseable */
  intent?: string;
  /** Non-null when the ISASync parser could not extract ISCs from the ISA */
  criteriaParseWarning?: 'missing-section' | 'empty-section' | 'all-dropped';
}

/**
 * Frontmatter shape for the per-session Ideal State Artifact (ISA.md).
 * The artifact is the single source of truth for an Algorithm run.
 */
export interface IsaFrontmatter {
  isa?: boolean;
  /** @deprecated legacy flag from when the artifact was named PRD.md */
  prd?: boolean;
  id: string;
  title?: string;
  status: string;
  mode?: string;
  effort?: string;
  effort_level?: string;
  phase?: string;
  progress?: string;
  iteration?: number;
  maxIterations?: number;
  loopStatus?: string | null;
  last_phase?: string | null;
  failing_criteria?: string[];
  verification_summary?: string;
  parent?: string | null;
  children?: string[];
  session_id?: string;
  slug?: string;
  task?: string;
  created?: string;
  updated?: string;
  completed_at?: string | null;
  github_issue?: number;
}

/** @deprecated use IsaFrontmatter */
export type PrdFrontmatter = IsaFrontmatter;

export interface AlgorithmApiResponse {
  algorithms: AlgorithmState[];
  active: boolean;
  pulseStrip?: RatingPulse[];
}
