---
category: domain
kind: index
publish: false
review_cadence: 90d
interview_phase: 2
last_updated: TBD
---

# Health

**Your health as a system.** The index for everything your DA tracks about your body, fitness, nutrition, and medical care. Always private — this domain never leaves your machine unless you explicitly flip a specific file's `publish:` flag.

## Current State

One paragraph on where your health is *right now*. Biomarkers trending, injuries active, medications, fitness level.

## Ideal State

One paragraph on where you want your health to be. What "working" looks like.

## Gap

What's between current and ideal? What's your DA's job in closing that gap?

## Files in This Domain

| File | Kind | Purpose |
|------|------|---------|
| `Metrics.md` | reference | Current biomarkers, weights, resting HR, HRV, VO2max, etc. |
| `Providers.md` | reference | PCP, specialists, dentist, optometrist — name, contact, last seen |
| `Medications.md` | collection | Current meds + supplements with dose/timing/purpose |
| `Conditions.md` | narrative | Ongoing health conditions and their management |
| `Fitness.md` | narrative | Current training program, goals, progress |
| `Nutrition.md` | narrative | Eating pattern, restrictions, what works |
| `History.md` | narrative | Significant health history your DA should know |
| `Labs/` | directory | Time-series: one file per lab panel, named `YYYY-MM.md` |

## Review Triggers

Your DA surfaces this domain when:

- New lab results arrive (update `Labs/`, flag changes against `Metrics.md`)
- Medication changes (update `Medications.md`)
- Training plan shifts (update `Fitness.md`)
- Any `review_cadence` expires (file becomes `overdue_review: true`)

---

*Setup tip: Start with `Metrics.md` and `Providers.md` — those two unlock most of what your DA needs to be useful. The rest accretes over time.*
