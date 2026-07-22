# Business Workflow

New business openings, closures, and notable license events in the principal's hometown.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running Business in LocalIntelligence"}' \
  > /dev/null 2>&1 &
```

Running **Business** in **LocalIntelligence**...

## Procedure

1. Resolve hometown via `Tools/Hometown.ts`.
2. Run `bun run Tools/FetchBusiness.ts` — attempts city open-data business-license endpoint discovery, falls back to county clerk DBA filings if exposed.
3. Return `FetchResult`.

## Sources

- City open-data business-license dataset (best-effort URL discovery)
- County clerk DBA / fictitious business name filings
- Local Chamber of Commerce member announcements (RSS where present)
