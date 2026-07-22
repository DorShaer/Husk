"use client";

import { useCallback, useEffect, useState } from "react";
import { TELOS as FALLBACK, type Telos } from "./data";

// Type-stable skeleton for personalized installs where the API returns null
// for a field that hasn't been populated yet. Substituting empty arrays /
// blank objects keeps the Telos shape sound (consumers can iterate without
// nullchecking every access) while ensuring no fixture content leaks in.
// Renderers detect emptiness via `.length === 0` or empty-string fields and
// show empty-state guides instead of fixture flavor.
const EMPTY: Telos = {
  owner: { name: "", day: "", streak: 0 },
  idealState: { horizon: "", note: "" },
  dimensions: [],
  snapshot: [],
  problems: [],
  missions: [],
  goals: [],
  metrics: [],
  challenges: [],
  strategies: [],
  projects: [],
  team: [],
  budget: [],
  recommendations: [],
  stranded: { work_no_goal: [], goals_no_strategy: [], strategies_idle: [] },
  subtabs: [],
  preferences: { books: [], films: [], anime: [], characters: [], aphorisms: [], hobbies: [], literature: [] },
  narrativeSeed: { days_into: 0, push_name: "", current_work: "", via_strategy: "", addresses: "", moves_goal: "", serves_mission: "" },
  workNarrative: null,
  currentStateNarrative: null,
  idealStateNarrative: null,
  currentStateBullets: null,
  idealStateBullets: null,
  synthesisParagraph: null,
  synthesisSegments: null,
  recommendedNextAction: null,
};

// Three rendering states, decided by the API's `meta.isPersonalized` flag:
//
//   FRESH INSTALL   — meta.isPersonalized === false  → showcase fixture
//                     (so the dashboard isn't empty before /interview runs)
//   PERSONALIZED    — meta.isPersonalized === true   → real where populated,
//                     null/empty elsewhere (renderers show empty-state hints)
//   API ERROR       — meta missing / network failure → showcase fixture
//                     (keep the page useful when the daemon isn't reachable)
//
// Empty arrays and null fields stay empty/null on personalized installs so a
// half-populated TELOS renders accurately — never with sample data leaking in.
type ApiTelos = Partial<Telos> & { meta?: { isPersonalized?: boolean } };

function mergeTelos(api: ApiTelos | null): { telos: Telos; isPersonalized: boolean } {
  if (!api) return { telos: FALLBACK, isPersonalized: false };
  const isPersonalized = api.meta?.isPersonalized === true;
  if (!isPersonalized) return { telos: FALLBACK, isPersonalized: false };

  // Personalized: pass through what the API returned, but for null/missing
  // fields use EMPTY (type-stable blanks) — never FALLBACK fixture content.
  // This is what gives the renderer "real or empty, never sample".
  const passthrough = <K extends keyof Telos>(key: K): Telos[K] => {
    const v = api[key];
    if (v === null || v === undefined) return EMPTY[key];
    return v as Telos[K];
  };
  return {
    isPersonalized,
    telos: {
      owner: passthrough("owner"),
      idealState: passthrough("idealState"),
      dimensions: passthrough("dimensions"),
      snapshot: passthrough("snapshot"),
      problems: passthrough("problems"),
      missions: passthrough("missions"),
      goals: passthrough("goals"),
      metrics: passthrough("metrics"),
      challenges: passthrough("challenges"),
      strategies: passthrough("strategies"),
      projects: passthrough("projects"),
      team: passthrough("team"),
      budget: passthrough("budget"),
      recommendations: passthrough("recommendations"),
      stranded: passthrough("stranded"),
      subtabs: passthrough("subtabs"),
      preferences: passthrough("preferences"),
      narrativeSeed: passthrough("narrativeSeed"),
      workNarrative: passthrough("workNarrative"),
      currentStateNarrative: passthrough("currentStateNarrative"),
      idealStateNarrative: passthrough("idealStateNarrative"),
      currentStateBullets: passthrough("currentStateBullets"),
      idealStateBullets: passthrough("idealStateBullets"),
      synthesisParagraph: passthrough("synthesisParagraph"),
      synthesisSegments: passthrough("synthesisSegments"),
      recommendedNextAction: passthrough("recommendedNextAction"),
    },
  };
}

export function useTelosData(): {
  telos: Telos | null;
  refetch: () => void;
  error: string | null;
  isPersonalized: boolean;
} {
  // Start null (renders the loading state), NOT the FALLBACK fixture. With
  // FALLBACK as initial state, every fetch-latency window and every failed
  // fetch showed SAMPLE DATA on a fully personalized install — the principal
  // sees "sample build push" template text over his real life data
  // (2026-06-09 incident). Fixture is allowed ONLY after the API confirms
  // meta.isPersonalized === false (a genuine fresh install).
  const [telos, setTelos] = useState<Telos | null>(null);
  const [isPersonalized, setIsPersonalized] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<number>(0);

  const refetch = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/telos/overview", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data === "object" && !data.error) {
          const merged = mergeTelos(data as ApiTelos);
          setTelos(merged.telos);
          setIsPersonalized(merged.isPersonalized);
          setError(null);
        } else {
          // Error from the API: keep telos null so the page shows the error
          // state — never the sample fixture.
          setError(data?.error ?? "empty response");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // Fetch failure (daemon restarting, network): error state, not fixture.
        setError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  return { telos, refetch, error, isPersonalized };
}
