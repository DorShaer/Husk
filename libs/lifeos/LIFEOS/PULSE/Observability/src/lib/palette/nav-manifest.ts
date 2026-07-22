// Single source of truth for Pulse's page manifest.
// AppHeader renders the nav from these arrays; the command palette derives its
// page commands from them. Adding a page here updates both surfaces.
import {
  Activity,
  BarChart3,
  Boxes,
  Bot,
  BookOpen,
  Brain,
  Briefcase,
  Clapperboard,
  Container,
  DollarSign,
  FolderGit2,
  FolderKanban,
  Gauge,
  Gem,
  Home,
  Library,
  MapPin,
  Radar,
  ShieldCheck,
  Sparkles,
  Target,
  TreePine,
  TrendingUp,
  UsersRound,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Palette-only match aliases; the nav bar ignores this field. */
  keywords?: string[];
}

// ── Tier 1 — the persistent global nav (Life sections + System home).
// This is the ONLY always-visible menu. Everything else is contextual.
export const tier1Nav: NavItem[] = [
  { href: "/telos", label: "TELOS", icon: Target, keywords: ["goals", "mission", "problems"] },
  { href: "/work", label: "WORK", icon: FolderKanban, keywords: ["kanban", "sessions", "tasks"] },
  { href: "/content", label: "CONTENT", icon: Clapperboard, keywords: ["videos", "pipeline", "conveyor"] },
  { href: "/projects", label: "PROJECTS", icon: FolderGit2, keywords: ["repos", "sites"] },
  { href: "/health", label: "HEALTH", icon: Activity, keywords: ["sleep", "fitness"] },
  { href: "/finances", label: "FINANCES", icon: DollarSign, keywords: ["money", "burn", "expenses", "revenue"] },
  { href: "/business", label: "BUSINESS", icon: Briefcase, keywords: ["company", "newsletter"] },
  { href: "/growth", label: "GROWTH", icon: TrendingUp, keywords: ["metrics", "subscribers", "audience"] },
  { href: "/local", label: "LOCAL", icon: MapPin, keywords: ["civic", "crime", "city"] },
  { href: "/assets", label: "ASSETS", icon: Boxes, keywords: ["gear", "inventory"] },
  { href: "/knowledge", label: "KNOWLEDGE", icon: Library, keywords: ["wiki", "notes", "archive"] },
  { href: "/amber", label: "AMBER", icon: Gem, keywords: ["ideas", "capture"] },
];

// ── Meta — pinned in the header's right cluster on EVERY page, outside both
// tiers. Agents is the view of the system working on itself, so it never
// scrolls away and never depends on which plane you're in.
export const metaNav: NavItem[] = [
  { href: "/agents", label: "AGENTS", icon: UsersRound, keywords: ["system", "vitals", "runs", "meta"] },
];

// Where the pinned SYSTEM mode-switch lands (Agents moved out to metaNav).
export const systemHome = "/assistant";

// ── Tier 2 — contextual. These machine pages render as a second row ONLY when
// you are inside System. They used to be a permanent second global menu.
export const systemNav: NavItem[] = [
  { href: "/assistant", label: "Assistant", icon: Bot, keywords: ["chat", "ask"] },
  { href: "/bunker", label: "Bunker", icon: Container, keywords: ["apps", "chassis"] },
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/hooks", label: "Hooks", icon: Webhook },
  { href: "/memory/graph", label: "Memory", icon: Brain, keywords: ["graph"] },
  { href: "/conduit", label: "Conduit", icon: Radar, keywords: ["sensors"] },
  { href: "/hypotheses", label: "Hypotheses", icon: Sparkles },
  { href: "/arbol", label: "Arbol", icon: TreePine, keywords: ["workers", "pipeline"] },
  { href: "/security", label: "Security", icon: ShieldCheck, keywords: ["monitoring"] },
  { href: "/performance", label: "Perf", icon: BarChart3, keywords: ["performance", "latency"] },
  { href: "/usage", label: "Usage", icon: Gauge, keywords: ["tokens", "cost"] },
  { href: "/docs", label: "Docs", icon: BookOpen, keywords: ["documentation", "wiki"] },
];

const homeEntry: NavItem = { href: "/", label: "Home", icon: Home, keywords: ["dashboard", "pulse"] };

/** Every page the palette can jump to, in display order. */
export const paletteEntries: NavItem[] = [homeEntry, ...tier1Nav, ...metaNav, ...systemNav];
