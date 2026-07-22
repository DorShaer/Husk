"use client";

import { useRef, useEffect, useMemo } from "react";
import type { HookEvent } from "@/hooks/useAgentEvents";
import type { TimeRange } from "@/hooks/useChartData";
import EventRow from "./EventRow";
import IntensityBar from "./IntensityBar";
import { Box } from "lucide-react";

interface EventTimelineProps {
  events: HookEvent[];
  heatLevel?: { intensity: number; color: string; label: string };
  eventsPerMinute?: number;
  timeRange: TimeRange;
  timeRanges: TimeRange[];
  onSetTimeRange: (range: TimeRange) => void;
}

export default function EventTimeline({
  events,
  heatLevel,
  eventsPerMinute,
  timeRange,
  timeRanges,
  onSetTimeRange,
}: EventTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const sortedEvents = useMemo(() => {
    return events.slice().reverse();
  }, [events]);

  // Auto-scroll to top on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events.length]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Intensity Bar */}
      {heatLevel && (
        <IntensityBar
          intensity={heatLevel.intensity}
          color={heatLevel.color}
          label={heatLevel.label}
          eventsPerMinute={eventsPerMinute ?? 0}
          timeRange={timeRange}
          timeRanges={timeRanges}
          onSetTimeRange={onSetTimeRange}
        />
      )}

      {/* Column Headers */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs font-medium text-[var(--ink-3)] uppercase tracking-wide">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <span className="w-20">Agent</span>
          <span className="w-24">Hook</span>
          <span className="w-20">Tool</span>
          <span className="flex-1">Details</span>
        </div>
        <span className="w-16 text-right">Time</span>
      </div>

      {/* Scrollable Event List */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-2">
        {sortedEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="bg-white/[0.03] p-6 rounded-2xl mb-4">
              <Box size={40} className="text-[var(--line-2)]" />
            </div>
            <p className="text-base font-medium text-[var(--ink-2)] mb-1">No events yet</p>
            <p className="text-sm text-[var(--line-2)]">Events will appear here as they stream in</p>
          </div>
        ) : (
          <div className="space-y-1.5 divide-y divide-[rgba(107,128,171,0.1)]">
            {sortedEvents.map((event) => (
              <EventRow key={`${event.id}-${event.timestamp}`} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
