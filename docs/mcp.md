# MCP servers

MCP (Model Context Protocol) is the open spec Anthropic published for connecting AI agents to external tools, data, and APIs. Husk's MCP page is the easy way to install and manage MCP servers without editing JSON or knowing the protocol.

## What MCP actually adds

The agents Husk runs can already read files, write files, run shell, fetch URLs, and call git. MCP servers are not "enabling" those things. They are **specializations** that give the agent typed tools for a specific domain. The catalog descriptions reflect that honestly:

| Server | What it adds (not what it enables) |
|--------|-----------------------------------|
| Filesystem (sandbox) | Restricts the agent to one folder you pick. Tighter than the default. |
| Memory | Structured key-value memory across conversations. Cleaner than ad-hoc notes files. |
| GitHub | Typed GitHub API tools (search code, list issues, open PRs) over a personal token. No `gh` CLI required. |
| Time | Timezone-aware time tools. |
| Fetch | URL fetcher with HTML-to-text extraction. Cleaner than parsing raw HTML. |
| Brave Search | Structured web search results without scraping a search page. |

## The page

```
MCP servers               ↻  ＋ Add custom server

INSTALLED
  ●  Loaded · live in current chat
     memory       npx -y @modelcontextprotocol/server-memory      [● connected]   [toggle]  [×]

  ●  Applying · agent reload pending
     bright       HTTP · https://app.example.com/mcp              [checking…]    [toggle]  [×]

AVAILABLE
  [Filesystem]  [Memory installed]  [GitHub]  [Time]  [Fetch]  [Brave Search]
```

Three semantic sections in "Installed":

- **Loaded** — green dot. Enabled AND in the snapshot taken when the current agent process started. These are live in the chat right now.
- **Applying** — amber dot. Enabled now but added or re-enabled since launch. Husk silently restarts the agent to load them; the dot becomes green when the new session starts.
- **Inactive** — grey dot. Toggled off. Persisted in `_huskMcpDisabled` inside `~/.claude.json` so re-enabling is one click and zero retyping.

Plus a per-row connection state pill: `connected` / `failed` / `needs auth` / `checking…`. Source: a `claude mcp list` shell-out, parsed and cached in the renderer.

## Installing a curated server

Click any catalog card. If the server needs configuration (a folder for Filesystem, an API key for GitHub or Brave Search), the modal prompts inline. Submit, Husk:

1. Validates the inputs.
2. Writes a clean entry into `~/.claude.json` `mcpServers`.
3. chmods the file to `0600` (it now holds your token).
4. Silently restarts the agent so the new server loads.
5. Re-runs `mcp:health` and flips the row's status pill from `checking…` to `connected` when claude reports the server up.

You never touch JSON.

## Custom MCP install

Top-right of the MCP page: `＋ Add custom server`. Modal opens with a "Paste JSON instead" path on top and a transport-aware form below.

**Two transports:**

- **Local command (stdio)** — for npm-installed servers like the catalog ones, but for any package, including private. Form: server name, command, arguments (one per line), env vars (`KEY=value`, one per line).

  Stored shape:
  ```json
  "my-server": { "command": "npx", "args": ["-y", "@my-org/my-mcp-server"], "env": { "API_KEY": "..." } }
  ```

- **Remote (HTTP / SSE)** — for hosted MCP servers. Form: server name, URL, transport type, headers (`Header: value`, one per line).

  Stored shape:
  ```json
  "my-server": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  ```

**Paste JSON instead** flips the modal to a single textarea. Paste any of:

```json
{ "my-server": { "type": "http", "url": "...", "headers": {...} } }
{ "type": "http", "url": "...", "headers": {...} }
{ "command": "npx", "args": [...], "env": {...} }
{ "name": { "command": "npx", "args": [...], "env": {...} } }
```

Husk parses (forgiving of trailing commas and the optional outer wrapper key), routes to the correct transport tab, and prefills the form. You review, then click Install.

## Connection health

Husk shells out to `claude mcp list` shortly after each install/toggle/remove and again every time the MCP page opens. The output is parsed into a per-server status. You see the live result as a small uppercase pill next to the server name:

| State | When | Color |
|-------|------|-------|
| `CONNECTED` | server is alive and the agent can call its tools | emerald |
| `FAILED` | claude reported a connection error (bad URL, bad token) | rose |
| `NEEDS AUTH` | server requires an OAuth flow (e.g. claude.ai connectors) | amber |
| `CHECKING…` | probe in flight | grey, italic |

This is the difference between "I configured it" (green section dot, "loaded") and "the agent can actually reach it" (per-row pill). Both are true configuration metadata; only the per-row pill is connectivity.

## On-disk format

Husk reads and writes claude's standard `~/.claude.json` user config. Disabled servers move to a Husk-private `_huskMcpDisabled` key inside the same file (claude ignores unknown keys), so re-enabling never asks for re-configuration.

Both `mcpServers` and `_huskMcpDisabled` follow the standard MCP entry shape, so an `~/.claude.json` written by Husk is readable by any MCP-aware tool, and an MCP entry someone else dropped in is readable by Husk.
