// Programmatic open channel for the command palette (e.g. the WikiSidebar
// search button). A window event keeps callers decoupled from the component.

export const PALETTE_OPEN_EVENT = "pulse:palette:open";

export type PaletteScope = "pages" | "wiki" | null;

export function openPalette(scope: PaletteScope = null) {
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT, { detail: { scope } }));
}
