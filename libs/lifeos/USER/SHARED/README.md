---
provenance: template
---

# SHARED

**Purpose:** Cross-skill static assets that multiple components reference — color palettes, animation frames, icon mappings, verb lists, and similar shared resources.

**What lives here:** Subdirs grouped by asset family. The default install includes `Spinner/` for status-spinner assets used by the statusline and other UI components. Add a new subdir here only when two or more components legitimately need the same static resource — otherwise keep the asset local to the skill that owns it.

**How it gets populated:** By the user explicitly, or by skills that contribute shared assets at install time. Adding a new shared resource is a deliberate act: it implies a contract that consuming components agree to read from the same location.

**Sample state for fresh installs:** Just this README plus the `Spinner/` subdir. Real content appears as you use LifeOS.
