export type SourceName = "oura" | "eightsleep" | "apple" | "function";

export type SourceStatus =
  | "ok"
  | "stale"
  | "failed"
  | "unconfigured"
  | "awaiting-first-export";

export type DayFile = {
  schema: number;
  source: string;
  fetched_at: string;
  metrics: Record<string, unknown>;
};

export type Biomarker = {
  name: string;
  value: number | string | null;
  unit: string | null;
  in_range: boolean | null;
  ref_low: number | null;
  ref_high: number | null;
  collected_at: string | null;
};

export type LabsFile = {
  fetched_at: string;
  biomarkers: Biomarker[];
};

export type SourceResult = {
  source: SourceName;
  status: SourceStatus;
  records: number;
  lastError: string | null;
  lastSuccess: string | null;
  ms: number;
  note?: string;
  /** Content hash for file-based sources; merged into SyncState by the CLI. */
  lastHash?: string | null;
  /** Set by modules that performed a real login/auth attempt this run. */
  authAttempted?: boolean;
  /** Set when that auth attempt failed (drives lockout-protection backoff). */
  authFailed?: boolean;
};

export type Ctx = {
  env: Record<string, string>;
  now: Date;
  stateDir: string;
  dataDir: string;
  obsDir: string;
  tokensPath: string;
  statePath: string;
};

export type LastNight = {
  sleep_duration_h: number | null;
  sleep_efficiency: number | null;
  oura_sleep_score: number | null;
  oura_readiness_score: number | null;
  eightsleep_score: number | null;
  bed_temp_c: number | null;
};

export type CurrentJson = {
  generated_at: string;
  day: string;
  last_night: LastNight;
  sources: Record<SourceName, SourceResult>;
};

export type SourceState = {
  lastSuccess: string | null;
  lastError: string | null;
  lastHash: string | null;
  /** Consecutive failed login attempts (unofficial APIs) — gates backoff. */
  consecutiveAuthFailures?: number;
  /** ISO timestamp of the last real login attempt. */
  lastAuthAttempt?: string | null;
};

export type SyncState = Partial<Record<SourceName, SourceState>>;

export type OuraTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

export type EightSleepToken = {
  access_token: string;
  userId: string;
  expires_at: number;
};

export type TokenStore = {
  oura?: OuraTokens;
  eightsleep?: EightSleepToken;
};
