"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import type { HookEvent } from "./useAgentEvents";

// ─── Types ───

export type TimeRange = "1M" | "2M" | "4M" | "8M" | "16M";

export interface ChartDataPoint {
  timestamp: number;
  count: number;
  eventTypes: Record<string, number>;
  sessions: Record<string, number>;
  apps: Record<string, number>;
  rawEvents: HookEvent[];
}

interface TimeRangeConfig {
  duration: number;
  bucketSize: number;
  maxPoints: number;
}

const TIME_RANGE_CONFIGS: Record<TimeRange, TimeRangeConfig> = {
  "1M": { duration: 60_000, bucketSize: 1000, maxPoints: 60 },
  "2M": { duration: 120_000, bucketSize: 2000, maxPoints: 60 },
  "4M": { duration: 240_000, bucketSize: 4000, maxPoints: 60 },
  "8M": { duration: 480_000, bucketSize: 8000, maxPoints: 60 },
  "16M": { duration: 960_000, bucketSize: 16000, maxPoints: 60 },
};

// ─── Hook ───

export function useChartData(agentIdFilter?: string) {
  const [timeRange, setTimeRangeState] = useState<TimeRange>("1M");
  const dataPointsRef = useRef<ChartDataPoint[]>([]);
  const allEventsRef = useRef<HookEvent[]>([]);
  const eventBufferRef = useRef<HookEvent[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceUpdate] = useState(0);

  const agentIdParsed = useMemo(() => {
    if (!agentIdFilter) return null;
    const parts = agentIdFilter.split(":");
    return parts.length === 2 ? { app: parts[0], session: parts[1] } : null;
  }, [agentIdFilter]);

  const currentConfig = TIME_RANGE_CONFIGS[timeRange];

  const getBucketTimestamp = useCallback(
    (ts: number) => Math.floor(ts / currentConfig.bucketSize) * currentConfig.bucketSize,
    [currentConfig.bucketSize]
  );

  const cleanOldData = useCallback(() => {
    const cutoff = Date.now() - currentConfig.duration;
    dataPointsRef.current = dataPointsRef.current.filter((dp) => dp.timestamp >= cutoff);
    if (dataPointsRef.current.length > currentConfig.maxPoints) {
      dataPointsRef.current = dataPointsRef.current.slice(-currentConfig.maxPoints);
    }
  }, [currentConfig]);

  const cleanOldEvents = useCallback(() => {
    const cutoff = Date.now() - 5 * 60_000;
    allEventsRef.current = allEventsRef.current.filter((e) => e.timestamp && e.timestamp >= cutoff);
  }, []);

  const processEventBuffer = useCallback(() => {
    const eventsToProcess = [...eventBufferRef.current];
    eventBufferRef.current = [];
    if (eventsToProcess.length === 0) return;

    allEventsRef.current.push(...eventsToProcess);

    for (const event of eventsToProcess) {
      if (!event.timestamp) continue;

      if (agentIdParsed) {
        if (event.source_app !== agentIdParsed.app) continue;
        if (event.session_id.slice(0, 8) !== agentIdParsed.session) continue;
      }

      const bucketTime = getBucketTimestamp(event.timestamp);
      let bucket = dataPointsRef.current.find((dp) => dp.timestamp === bucketTime);

      const appKey = event.agent_name || event.source_app || "unknown";

      if (bucket) {
        bucket.count++;
        bucket.eventTypes[event.hook_event_type] = (bucket.eventTypes[event.hook_event_type] || 0) + 1;
        bucket.sessions[event.session_id] = (bucket.sessions[event.session_id] || 0) + 1;
        bucket.apps[appKey] = (bucket.apps[appKey] || 0) + 1;
        bucket.rawEvents.push(event);
      } else {
        dataPointsRef.current.push({
          timestamp: bucketTime,
          count: 1,
          eventTypes: { [event.hook_event_type]: 1 },
          sessions: { [event.session_id]: 1 },
          apps: { [appKey]: 1 },
          rawEvents: [event],
        });
      }
    }

    cleanOldData();
    cleanOldEvents();
    forceUpdate((n) => n + 1);
  }, [agentIdParsed, getBucketTimestamp, cleanOldData, cleanOldEvents]);

  const addEvent = useCallback(
    (event: HookEvent) => {
      eventBufferRef.current.push(event);
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        processEventBuffer();
        debounceTimerRef.current = null;
      }, 50);
    },
    [processEventBuffer]
  );

  const getChartData = useCallback((): ChartDataPoint[] => {
    const now = Date.now();
    const startTime = now - currentConfig.duration;
    const buckets: ChartDataPoint[] = [];

    for (let time = startTime; time <= now; time += currentConfig.bucketSize) {
      const bucketTime = getBucketTimestamp(time);
      const existing = dataPointsRef.current.find((dp) => dp.timestamp === bucketTime);
      buckets.push({
        timestamp: bucketTime,
        count: existing?.count || 0,
        eventTypes: existing?.eventTypes || {},
        sessions: existing?.sessions || {},
        apps: existing?.apps || {},
        rawEvents: existing?.rawEvents || [],
      });
    }

    return buckets.slice(-currentConfig.maxPoints);
  }, [currentConfig, getBucketTimestamp]);

  const reaggregateData = useCallback(() => {
    dataPointsRef.current = [];
    const now = Date.now();
    const cutoff = now - currentConfig.duration;

    let relevantEvents = allEventsRef.current.filter((e) => e.timestamp && e.timestamp >= cutoff);

    if (agentIdParsed) {
      relevantEvents = relevantEvents.filter(
        (e) => e.source_app === agentIdParsed.app && e.session_id.slice(0, 8) === agentIdParsed.session
      );
    }

    for (const event of relevantEvents) {
      if (!event.timestamp) continue;
      const bucketTime = getBucketTimestamp(event.timestamp);

      let bucket = dataPointsRef.current.find((dp) => dp.timestamp === bucketTime);
      const appKey = event.agent_name || event.source_app || "unknown";

      if (bucket) {
        bucket.count++;
        bucket.eventTypes[event.hook_event_type] = (bucket.eventTypes[event.hook_event_type] || 0) + 1;
        bucket.sessions[event.session_id] = (bucket.sessions[event.session_id] || 0) + 1;
        bucket.apps[appKey] = (bucket.apps[appKey] || 0) + 1;
        bucket.rawEvents.push(event);
      } else {
        dataPointsRef.current.push({
          timestamp: bucketTime,
          count: 1,
          eventTypes: { [event.hook_event_type]: 1 },
          sessions: { [event.session_id]: 1 },
          apps: { [appKey]: 1 },
          rawEvents: [event],
        });
      }
    }

    cleanOldData();
    forceUpdate((n) => n + 1);
  }, [currentConfig, agentIdParsed, getBucketTimestamp, cleanOldData]);

  const setTimeRange = useCallback(
    (range: TimeRange) => {
      setTimeRangeState(range);
    },
    []
  );

  // Reaggregate when time range changes
  useEffect(() => {
    reaggregateData();
  }, [timeRange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Slow UI refresh — updates React-dependent parts (pills, badges, counts) every 5s.
  // Canvas chart reads from refs directly and doesn't need this.
  useEffect(() => {
    const interval = setInterval(() => {
      cleanOldData();
      cleanOldEvents();
      forceUpdate((n) => n + 1);
    }, 5_000);
    return () => clearInterval(interval);
  }, [cleanOldData, cleanOldEvents]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const clearData = useCallback(() => {
    dataPointsRef.current = [];
    allEventsRef.current = [];
    eventBufferRef.current = [];
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    forceUpdate((n) => n + 1);
  }, []);

  // Create agent ID helper
  const createAgentId = (sourceApp: string, sessionId: string): string => {
    return `${sourceApp}:${sessionId.slice(0, 8)}`;
  };

  // Unique agents in current window
  const uniqueAgentIdsInWindow = useMemo(() => {
    const now = Date.now();
    const cutoff = now - currentConfig.duration;
    const agents = new Set<string>();
    allEventsRef.current.forEach((e) => {
      if (e.timestamp && e.timestamp >= cutoff) {
        agents.add(createAgentId(e.source_app, e.session_id));
      }
    });
    return Array.from(agents);
  }, [currentConfig.duration, dataPointsRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  // All unique agents ever seen
  const allUniqueAgentIds = useMemo(() => {
    const agents = new Set<string>();
    allEventsRef.current.forEach((e) => {
      agents.add(createAgentId(e.source_app, e.session_id));
    });
    return Array.from(agents);
  }, [dataPointsRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  const uniqueAgentCount = uniqueAgentIdsInWindow.length;

  const toolCallCount = useMemo(() => {
    return dataPointsRef.current.reduce((sum, dp) => sum + (dp.eventTypes?.PreToolUse || 0), 0);
  }, [dataPointsRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    timeRange,
    dataPoints: dataPointsRef.current,
    addEvent,
    getChartData,
    setTimeRange,
    clearData,
    currentConfig,
    uniqueAgentCount,
    uniqueAgentIdsInWindow,
    allUniqueAgentIds,
    toolCallCount,
    allEvents: allEventsRef.current,
  };
}
