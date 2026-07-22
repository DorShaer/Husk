# Four-Tier URL Content Scraping

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the FourTierScrape workflow in the BrightData skill to scrape URL content"}' \
  > /dev/null 2>&1 &
```

Running **FourTierScrape** in **BrightData**...

---

**Deliverable:** the URL's content in clean markdown, labeled with which tier retrieved it. Start cheap, escalate only on failure — the tier that succeeds first is the answer. Tier table (tool + cost) is in `SKILL.md`.

## Pre-check: Cloudflare markdown negotiation

Before the tier chain, probe for server-side markdown via Cloudflare's [Markdown for Agents](https://blog.cloudflare.com/markdown-for-agents/). Non-Cloudflare sites ignore the header and return HTML — zero downside.

```bash
curl -sL -H "Accept: text/markdown" "[URL]" | head -5
```

**Markdown detected (any of these) → use the body directly, skip the tiers:**
1. `Content-Type` header contains `text/markdown`
2. `x-markdown-tokens` header present (capture it as token-count metadata)
3. Body starts with YAML frontmatter (`---`) or a markdown heading (`# `) instead of `<!DOCTYPE`/`<html` — Cloudflare's CDN sometimes reports `content-type: text/html` even when the body is markdown

~80% fewer tokens than HTML-to-markdown conversion, ~1-3s, free. HTML or error → proceed to Tier 1.

## Tier 1 — WebFetch

WebFetch the URL with prompt "Extract all content from this page and convert to markdown". Success → Output. Blocked/timeout → Tier 2.

## Tier 2 — curl with Chrome headers

The `Sec-Fetch-*` headers are the load-bearing part for bypassing basic detection; `--compressed` handles gzip/br like a real browser.

```bash
curl -L -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -H "Accept: text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, */*;q=0.7" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Accept-Encoding: gzip, deflate, br" \
  -H "DNT: 1" \
  -H "Connection: keep-alive" \
  -H "Upgrade-Insecure-Requests: 1" \
  -H "Sec-Fetch-Dest: document" \
  -H "Sec-Fetch-Mode: navigate" \
  -H "Sec-Fetch-Site: none" \
  -H "Sec-Fetch-User: ?1" \
  -H "Cache-Control: max-age=0" \
  --compressed \
  "[URL]"
```

HTML returned → convert to markdown → Output. Empty/blocked/JS-required → Tier 3.

## Tier 3 — Interceptor (real Chrome)

Renders JavaScript, handles cookies/sessions, real browser fingerprint. Playwright is banned across LifeOS.

```bash
interceptor open "<url>"        # renders JS, returns tree + flat text
interceptor read --text-only    # extract rendered text
```

Rendered text → convert to markdown → Output. CAPTCHA / advanced bot detection → Tier 4.

## Tier 4 — Bright Data MCP

Residential proxies, automatic CAPTCHA solving, headless render. Last resort — has usage costs.

```
mcp__Brightdata__scrape_as_markdown  with URL: [user-provided URL]
```

Success → Output. Failure here is rare and means the site is down, login-gated, paywalled, or geo-restricted — report that to the user with the URL to double-check.

## Output

Present the markdown content, prefixed with which tier succeeded (and, for Tier 3/4, a one-line note on why escalation was needed). Verify the content is readable, matches the URL, and has no major missing sections.

```markdown
Successfully retrieved content from [URL] using Tier [1/2/3/4]

[Content in markdown format...]
```

## Related

- `Crawl.md` — multi-page site crawling (calls this workflow for its starting URL and as fallback).
