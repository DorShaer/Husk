# Elections Workflow

Upcoming elections, ballot measures, and candidate fields for the hometown.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running Elections in LocalIntelligence"}' \
  > /dev/null 2>&1 &
```

Running **Elections** in **LocalIntelligence**...

## Procedure

1. Resolve hometown via `Tools/Hometown.ts`.
2. Run `bun run Tools/FetchElections.ts` — Ballotpedia API for upcoming elections in the city's jurisdiction, county registrar discovery for polling places where present.
3. Return `FetchResult`.

## Sources

- Ballotpedia API — upcoming elections, candidates, ballot measures
- Vote.gov state-by-state registration links
- County registrar of voters (best-effort URL discovery)
