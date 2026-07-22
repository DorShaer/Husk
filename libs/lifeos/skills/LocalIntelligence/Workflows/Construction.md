# Construction Workflow

New construction permits and major build-outs in the principal's hometown.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running Construction in LocalIntelligence"}' \
  > /dev/null 2>&1 &
```

Running **Construction** in **LocalIntelligence**...

## Procedure

1. Resolve hometown via `Tools/Hometown.ts`.
2. Run `bun run Tools/FetchConstruction.ts` — pulls Census Building Permits Survey for the metro area, attempts the city's open-data permits endpoint via well-known patterns (`/permits.json`, `/api/permits`, Accela `apo/...`), and looks for planning-commission agenda items.
3. Return `FetchResult` shape: `{ items, source_status, errors? }`.
4. Surface up to 7 items in chat with title, date, source.

## Sources

- US Census Building Permits Survey (monthly, metro-level)
- City open-data portal — best-effort URL discovery
- Planning commission agendas via Granicus/Legistar discovery
