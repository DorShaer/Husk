"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { localOnlyApiCall } from "@/lib/local-api";

// ─── Full HookEvent (matches Observability server payload) ───

export interface HookEvent {
  id: number;
  source_app: string;
  session_id: string;
  hook_event_type: string;
  payload: Record<string, any>;
  summary?: string;
  timestamp?: number;
  model_name?: string;
  agent_name?: string;
}

// Simplified event (backward-compat)
export interface AgentEvent {
  id: number;
  source_app: string;
  session_id: string;
  hook_event_type: string;
  summary?: string;
  timestamp?: number;
  agent_name?: string;
}

export interface BackgroundTask {
  taskId: string;
  sessionId: string;
  agentId: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  lastActivity: number;
  description: string;
  outputPreview: string;
  eventCount: number;
  taskType: "bash" | "agent" | "unknown";
}

// ─── Hook (HTTP polling only — no WebSocket) ───

export function useAgentEvents(maxEvents = 500) {
  const [events, setEvents] = useState<HookEvent[]>([]);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const eventIdRef = useRef(0);
  const seenIdsRef = useRef(new Set<string>());

  const poll = useCallback(async () => {
    try {
      const data = await localOnlyApiCall<{ events: Array<Record<string, any>> }>("/api/agents");
      if (data.events?.length) {
        const newEvents: HookEvent[] = [];
        for (const e of data.events) {
          const key = `${e.timestamp}|${e.session_id}|${e.hook_event_type}|${e.source_app}`;
          if (!seenIdsRef.current.has(key)) {
            seenIdsRef.current.add(key);
            newEvents.push({
              ...e,
              id: eventIdRef.current++,
              payload: e.payload || {},
            } as HookEvent);
          }
        }

        // Trim seen set
        if (seenIdsRef.current.size > maxEvents * 2) {
          seenIdsRef.current = new Set(
            data.events.map((e: Record<string, any>) => `${e.timestamp}|${e.session_id}|${e.hook_event_type}|${e.source_app}`)
          );
        }

        if (newEvents.length > 0) {
          setEvents((prev) => [...prev, ...newEvents].slice(-maxEvents));
        }
        setIsConnected(true);
      }
    } catch {
      setIsConnected(false);
    }
  }, [maxEvents]);

  useEffect(() => {
    let active = true;

    const startPolling = async () => {
      await poll();
      if (active) {
        pollTimerRef.current = setTimeout(startPolling, 3_000);
      }
    };

    startPolling();
    return () => {
      active = false;
      clearTimeout(pollTimerRef.current);
    };
  }, [poll]);

  return { events, tasks, isConnected };
}
