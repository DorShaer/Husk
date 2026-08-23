# Workflow registries

The Marketplace on the Workflows page browses catalogs of workflows other people
publish. A catalog is one HTTPS URL to one JSON file. There is no account, no
upload endpoint and no server run by Husk: publishing is committing a file to a
repository, and subscribing is pasting that repository's raw URL.

Anyone can run a registry. Husk ships with one configured and it can be removed
like any other.

## What a registry buys, and what it does not

A registry tells Husk where a workflow file is. That is the whole of it.

The file it points at goes through exactly the same path as a `.husk.json` you
picked off your own disk: the same validator, the same preflight against your
machine, the same install sheet, and the same consent gate the first time you
press Run. A registry cannot introduce a step, an agent, an MCP server or a
permission, because none of those are things an index can say. It can only name
a file that still has to survive the gate.

Three rules follow from treating the index as a file a stranger wrote:

- **One registry means one host.** An entry's `artifact` is resolved against the
  index URL and must land on the same origin. A catalog cannot source its files
  from somewhere you did not agree to when you subscribed.
- **HTTPS only, on every hop**, with no credentials in the URL.
- **A stated digest that does not match is a refusal, not a warning.** Husk
  hashes the bytes it received and compares. Contradicted evidence is worse than
  absent evidence, so the install stops rather than proceeding with a caveat.

A digest is not a signature. It says the catalog and the file agree, which rules
out the file changing underneath a catalog nobody updated. It says nothing about
who wrote either one. Husk never prints the word "verified" for this, and
neither should a catalog.

Everything else an entry says (name, description, author, step count, agents,
dates) is a claim by whoever wrote the index. The Marketplace labels those rows
`listed here` for exactly that reason.

## The index format

```json
{
  "kind": "husk.registry",
  "schemaVersion": 1,
  "name": "Husk Workflows",
  "updatedAt": "2026-08-23T00:00:00Z",
  "workflows": [
    {
      "id": "security-triage",
      "name": "Security triage",
      "description": "Fans four scanners out over a checkout, then gates on what they found.",
      "author": "dorshaer",
      "tags": ["security", "review"],
      "agents": ["claude", "codex"],
      "steps": 7,
      "updatedAt": "2026-08-18T00:00:00Z",
      "artifact": "workflows/security-triage.husk.json",
      "sha256": "9f2c…"
    }
  ]
}
```

### Envelope

| Field | Required | Notes |
|-------|----------|-------|
| `kind` | yes | Must be the literal `husk.registry`. |
| `schemaVersion` | yes | A JSON number, currently `1`. A string is refused. An index declaring a higher version is refused whole rather than partially read. |
| `name` | no | Shown above the grid. Clipped at 80 characters. |
| `updatedAt` | no | ISO instant. |
| `workflows` | yes | At most 500 entries. |

### Entry

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Slug: lowercase letters, digits and hyphens, starting and ending alphanumeric, up to 64 characters. Unique within the index; a duplicate is skipped rather than allowed to shadow the first. |
| `name` | yes | Clipped at 80 characters. |
| `artifact` | yes | Relative to the index URL, or an absolute HTTPS URL on the same origin. |
| `description` | no | Clipped at 400 characters, shown over at most three lines. |
| `author` | no | Clipped at 60 characters. |
| `tags` | no | Up to 8 slugs of up to 24 characters. They become the filter chips. |
| `agents` | no | Up to 6. Names Husk cannot run are dropped rather than shown, since the row exists to tell a reader whether this will run on their machine. |
| `steps` | no | Integer, 0 to 64. |
| `updatedAt` | no | ISO instant. Sorts the grid, newest first; entries without one sort last, by name. |
| `sha256` | no | Lowercase or uppercase hex digest of the artifact file's bytes. Strongly recommended: without it nothing attests to which bytes were meant. |

A row missing `id`, `name` or `artifact` is skipped, and the count of skipped
rows is shown above the grid rather than swallowed. An index whose every row is
unreadable is refused rather than shown as an empty catalog.

Ceilings: an index is at most 512 KB; a workflow file is at most 1 MB.

## Publishing a workflow

1. On the Workflows page, open a workflow's menu and choose **Export**. That
   writes a `.husk.json` containing the graph, its fingerprint, what it needs in
   order to run, and optionally the run log.
2. Commit that file to a repository.
3. Add an entry for it to your `index.json`, with `sha256` set to the digest of
   the exported file:

   ```sh
   shasum -a 256 workflows/security-triage.husk.json
   ```

4. Serve the index over HTTPS. A raw file URL from a public git host works with
   no further setup, as long as the workflow files are on the same host.

Re-exporting a workflow changes its bytes, so the digest changes with it. An
index whose digest is stale will refuse the install rather than serve the newer
file quietly, which is the intended behavior: update the index in the same
commit as the file.

## Subscribing

Workflows → **Marketplace** → **Registries** → paste the index URL → **Add**.

Registries are stored in `config.workflowRegistries`. Removing the one Husk
ships with is an ordinary removal; there is no special case for it.

## Reading a catalog

- The line above the grid names the catalog, the host it came from, how many
  workflows it lists, and how many rows this build could not read.
- The chip on a card says `digest listed` when the entry carries a `sha256`. The
  bytes are checked against it before the file is read as a workflow.
- The line along the bottom of every card says `listed here`, which is the
  reminder that the figures above it are the publisher's claims.
- **Get** hands the entry to the install sheet. Nothing is written until you
  choose a directory there and press Install, and nothing runs until you agree
  to the prompts at the consent gate.
