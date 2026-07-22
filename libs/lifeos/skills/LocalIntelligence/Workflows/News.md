# News Workflow

Local news headlines for the hometown.

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running News in LocalIntelligence"}' \
  > /dev/null 2>&1 &
```

Running **News** in **LocalIntelligence**...

## Procedure

1. Resolve hometown via `Tools/Hometown.ts`.
2. Run `bun run Tools/FetchNews.ts` — pulls Patch RSS at `https://patch.com/<state-slug>/<city-slug>/feed`, falls back to a Google News topic search for `"<city>, <state>"`.
3. Return `FetchResult`.

## Sources

- Patch RSS (canonical URL, falls back gracefully)
- Google News topic search
- Optional regional outlet RSS via `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LocalIntelligence/PREFERENCES.md`
