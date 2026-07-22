# Officials Workflow

Movements and news for the city's elected and appointed officials — mayor, council, city manager, school board.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running Officials in LocalIntelligence"}' \
  > /dev/null 2>&1 &
```

Running **Officials** in **LocalIntelligence**...

## Procedure

1. Resolve hometown via `Tools/Hometown.ts`.
2. Run `bun run Tools/FetchOfficials.ts` — Ballotpedia API for the city's officeholders, plus Google News topic search keyed on `"<official-name> <city>"`.
3. Return `FetchResult`.

## Sources

- Ballotpedia API — officeholders, terms, recent coverage
- Google News topic search per official
- City press releases (RSS where present)
