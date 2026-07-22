---
provenance: template
last_updated: 1970-01-01T00:00:00Z
last_updated_by: bootstrap-template
convention: pai-freshness-v1
---

# Projects

> Bootstrap default — functional before interview. Run `/interview` (projects phase) to personalize.
>
> ⚠ INTERVIEW REQUIRED — run `/interview` to populate this file with your real identity content. The DA loads it at every session start; without your content, the model operates on placeholders.

A compact table of every project you work on. The DA reads this at startup to route aliases ("my blog" → specific repo) and pick the right context for any project reference.

## Projects Table

| Project | Path | URL | Deploy | Stack |
|---------|------|-----|--------|-------|
| (interview — first project) | `~/code/example` | example.com | `bun run deploy` | TS, React |

## Routing Aliases

When you say... | The DA routes to...
---|---
"my site", "the blog" | (interview — primary site)
"the workspace", "that project" | (interview — main active project)

---
*Interview asks about your active projects one at a time and appends rows to the table. Aliases help the DA route natural language ("check the blog deploy") to the right codebase. Keep this current — it's cheap to maintain incrementally, expensive to reconstruct.*
