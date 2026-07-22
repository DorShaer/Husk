#!/usr/bin/env bun
/**
 * Website Health Check — Script-type job
 *
 * Zero AI cost: HTTP GET → check status → notify on failure.
 *
 * Output: failure details or NO_ACTION
 */

// Sites to health-check. Override via LIFEOS_PULSE_HEALTH_SITES env var
// (comma-separated "name|url" pairs, e.g. "blog|https://blog.example.com,api|https://api.example.com").
// Empty default ships in the public release; principals add their own sites.
const SITES = (process.env.LIFEOS_PULSE_HEALTH_SITES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [name, url] = entry.split("|").map((s) => s.trim())
    return { name: name || url, url }
  })
  .filter((s) => s.url)

interface HealthResult {
  name: string
  ok: boolean
  status?: number
  error?: string
  responseMs: number
}

async function checkSite(site: { name: string; url: string }): Promise<HealthResult> {
  const start = Date.now()
  try {
    const resp = await fetch(site.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    })
    return {
      name: site.name,
      ok: resp.ok,
      status: resp.status,
      responseMs: Date.now() - start,
    }
  } catch (err) {
    return {
      name: site.name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      responseMs: Date.now() - start,
    }
  }
}

async function main() {
  const results = await Promise.all(SITES.map(checkSite))
  const failures = results.filter((r) => !r.ok)

  if (failures.length === 0) {
    console.log("NO_ACTION")
    return
  }

  const lines = failures.map((f) => {
    if (f.error) return `${f.name}: DOWN (${f.error})`
    return `${f.name}: HTTP ${f.status} (${f.responseMs}ms)`
  })

  console.log(`Site health alert:\n${lines.join("\n")}`)
}

main().catch((err) => {
  console.error(`health-check error: ${err}`)
  console.log("NO_ACTION")
})
