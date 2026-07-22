/**
 * Deterministic creation/consumption classifier (v1, no model).
 *
 * This is the honest v1 proxy for challenge C1 (consumption vs creation): a static
 * app→kind map. The v2 local-model layer refines ambiguous cases (e.g. "research on
 * YouTube" vs "cat videos") — but the coarse app-level split is useful on its own and
 * needs zero inference. Edit these lists to taste; they are data, not logic.
 */
import type { BlockKind } from "./types.ts";

const CREATION = [
  "terminal", "iterm", "iterm2", "kitty", "ghostty", "alacritty", "warp",
  "code", "cursor", "vscode", "xcode", "zed", "nvim", "vim", "neovim",
  "logic", "logic pro", "descript", "ableton", "final cut", "davinci",
  "obsidian", "notion", "figma", "sketch", "pixelmator", "photoshop",
];

const CONSUMPTION = [
  "safari", "google chrome", "chrome", "arc", "dia", "firefox", "brave", "edge",
  "mail", "spark", "superhuman", "outlook",
  "messages", "slack", "discord", "telegram", "whatsapp", "signal",
  "twitter", "x", "youtube", "reddit", "instagram", "tiktok", "news",
];

/**
 * Classify a foreground app name into a creation/consumption/neutral bucket.
 * Case-insensitive substring match; unknown apps are neutral (never guessed).
 */
export function classifyApp(app: string): BlockKind {
  const a = app.trim().toLowerCase();
  if (!a) return "neutral";
  if (CREATION.some((k) => a === k || a.includes(k))) return "creation";
  if (CONSUMPTION.some((k) => a === k || a.includes(k))) return "consumption";
  return "neutral";
}
