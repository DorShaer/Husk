"use client";

import { useEffect, useState } from "react";

// Scroll-to section nav for the columns view. One tab per TELOS primitive,
// in dependency order. Tabs whose anchor didn't render (fresh installs) are
// dropped. Clicking smooth-scrolls; a scrollspy keeps the active tab lit.

interface SectionTab {
  id: string;
  label: string;
}

const SECTION_TABS: readonly SectionTab[] = [
  { id: "sec-current",    label: "Current & Ideal" },
  { id: "sec-problems",   label: "Problems" },
  { id: "sec-mission",    label: "Mission" },
  { id: "sec-goals",      label: "Goals" },
  { id: "sec-metrics",    label: "Metrics" },
  { id: "sec-challenges", label: "Challenges" },
  { id: "sec-strategies", label: "Strategies" },
  { id: "sec-projects",   label: "Projects" },
  { id: "sec-team",       label: "Team" },
  { id: "sec-budget",     label: "Budget" },
];

export function SectionNav() {
  const [tabs, setTabs] = useState<SectionTab[]>([]);
  const [active, setActive] = useState<string | null>(null);

  // Keep only tabs whose anchor actually rendered.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const present = SECTION_TABS.filter((t) => document.getElementById(t.id));
    setTabs(present);
    if (present.length) setActive(present[0].id);
  }, []);

  // Scrollspy — light the tab whose section is highest in view.
  useEffect(() => {
    if (!tabs.length || typeof IntersectionObserver === "undefined") return;
    const els = tabs
      .map((t) => document.getElementById(t.id))
      .filter((e): e is HTMLElement => !!e);
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: 0 },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [tabs]);

  if (tabs.length < 2) return null;

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActive(id);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav className="telos-section-nav" aria-label="TELOS sections">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={"tsn-tab" + (t.id === active ? " on" : "")}
          onClick={() => go(t.id)}
          aria-current={t.id === active ? "true" : undefined}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
