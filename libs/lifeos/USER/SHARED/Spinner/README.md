---
provenance: template
---

# Spinner

**Purpose:** Static assets for the LifeOS status spinner — animation frames, color palettes, icons, and verb lists used to render activity indicators.

**What lives here:** Asset files grouped by type (frames for the animation cycle, palette files for color rotations, icon mappings for tool/skill associations, and verb lists for the human-readable activity strings). The statusline and other UI components read these at render time to keep spinner output consistent across the system.

**How it gets populated:** By skills automatically — the components that render spinners ship their default assets here at install time. The user can edit these files to customize colors, swap icon sets, or extend the verb list without touching the rendering code.

**Sample state for fresh installs:** Just this README. Spinner assets land here when the relevant skill installs them.
