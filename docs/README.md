# Husk documentation

Deeper reading than the project README. Pick a topic.

| Doc | What it covers |
|-----|----------------|
| [installation.md](installation.md) | Per-OS install, packaging, dev mode, auto-update behavior, uninstall. |
| [build-from-source.md](build-from-source.md) | Step-by-step: prerequisites, clone, build, run, package, troubleshoot. |
| [architecture.md](architecture.md) | Chat view and its three agent protocols, process model, IPC surface, packaging layout, where data lives on disk. |
| [agents.md](agents.md) | Follow background agents in the live map, check their activity, and answer requests. |
| [chat-continuation.md](chat-continuation.md) | Switch CLIs, carry conversations across agents, answer agent questions, handle context and usage warnings, and inspect turn changes. |
| [multi-vendor-routing.md](multi-vendor-routing.md) | Choose CLI vendors and models for chats, Autopilot jobs, and workflow steps. |
| [skills-and-prompts.md](skills-and-prompts.md) | Why skills and prompts are separate pages, the two-pane Skills browser, importing, and the curated default prompts. |
| [mcp.md](mcp.md) | MCP integration: catalog, custom install (stdio + HTTP/SSE), live health, the JSON paste path. |
| [workflow-registries.md](workflow-registries.md) | The Marketplace: the registry index format, what a catalog can and cannot say, publishing a workflow, and how a listed digest is read. |
| [contributing.md](contributing.md) | Repo layout, dev workflow, conventional commits, security CI, how to ship a release. |

Project-level docs that live at the repo root:

- [`../README.md`](../README.md): entry point, screenshots, quick install.
- [`../SECURITY.md`](../SECURITY.md): threat model and how to report a security issue.
- [`../LICENSE`](../LICENSE): Elastic License 2.0.

Images used by the project README live under [`images/`](images/).
