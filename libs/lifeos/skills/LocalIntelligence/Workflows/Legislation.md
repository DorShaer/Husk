# Legislation Workflow

Pending and enacted laws affecting the hometown — both city ordinances and state-level legislation with local impact.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running Legislation in LocalIntelligence"}' \
  > /dev/null 2>&1 &
```

Running **Legislation** in **LocalIntelligence**...

## Procedure

1. Resolve hometown via `Tools/Hometown.ts` → `{ city, state }`.
2. Run `bun run Tools/FetchLegislation.ts` — OpenStates API for state-level pending and recently enacted bills, Granicus/Legistar discovery for city council agenda items.
3. Return `FetchResult` partitioned into `pending` and `enacted` arrays inside `items`, with each item flagged via `metadata.status`.

## Sources

- OpenStates API (state legislature pending + enacted)
- Granicus / Legistar via well-known URL discovery
- City council meeting calendar (where exposed)
