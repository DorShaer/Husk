# Arrests Workflow

Recent arrests in the hometown via publicly published police/sheriff blotters.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running Arrests in LocalIntelligence"}' \
  > /dev/null 2>&1 &
```

Running **Arrests** in **LocalIntelligence**...

## Procedure

1. Resolve hometown via `Tools/Hometown.ts` → `{ city, county }`.
2. Run `bun run Tools/FetchArrests.ts` — county sheriff blotter discovery (if a public page exists), local PD daily-log discovery.
3. Return `FetchResult`. Many cities will return `source_status: "unavailable"` — that is correct; do not invent.

## Sources

- County sheriff booking log (best-effort URL discovery)
- City PD daily blotter (best-effort URL discovery)
- Patch crime tag for the city as a soft fallback

## Constraints

- Only data published by official agencies on public pages.
- No paid people-search aggregators.
- No bypassing CAPTCHAs or paywalls.
