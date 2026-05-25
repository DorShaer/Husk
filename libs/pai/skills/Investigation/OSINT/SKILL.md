---
name: OSINT
description: Structured OSINT investigations — people lookup, company intel, investment due diligence, entity/threat intel, domain recon, organization research using public sources with ethical authorization framework. USE WHEN OSINT, due diligence, background check, research person, company intel, investigate, company lookup, domain lookup, entity lookup, organization lookup, threat intel, discover OSINT sources.
---

## Customization

**Before executing, check for user customizations at:**
`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/OSINT/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

~/.claude/MEMORY/WORK/$(jq -r '.work_dir' ~/.claude/MEMORY/STATE/current-work.json)/YYYY-MM-DD-HHMMSS_osint-[target]/
```

**Archived reports:**
```
~/.claude/History/research/YYYY-MM/[target]-osint/
```

---

## Ethical Guardrails

**ALLOWED:** Public sources only - websites, social media, public records, search engines, archived content

**PROHIBITED:** Private data, unauthorized access, social engineering, purchasing breached data, ToS violations

See `EthicalFramework.md` for complete requirements.

---

**Version:** 3.0 (SOURCES.JSON Integration)
**Last Updated:** February 2026
