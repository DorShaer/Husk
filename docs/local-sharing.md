# Local sharing

Open **Preferences > Sharing** to import or export a local bundle or choose a scanner.

## Import an item

1. Choose **Import bundle** and select a Husk bundle JSON file.
2. For a workflow, choose the project folder where it will run.
3. Read the review dialog. It shows the publisher, signature state, declared permissions, scanner findings and the files being installed. Expand a filename to read its contents.
4. Choose **Install** or **Install after review** to proceed, or **Cancel** to leave it uninstalled.

The review shows four possible scan states:

| Result | Behavior |
| --- | --- |
| Clear | The scanner found no reportable findings. Installation still requires a click. |
| Review | Inspect the findings and files, then explicitly confirm or cancel. |
| Block | Installation is refused. The dialog offers Close. |
| Unscanned | No usable report was produced. Treat the item as needing review; installation requires explicit confirmation. |

No scanner configured, a timeout, a process failure or an unreadable report produces Unscanned. A verified signature identifies a configured publisher; it does not establish that an item is safe. Declared permissions describe the publisher's claims, not an operating-system sandbox.

Husk stages files in a private temporary folder. It checks the staged content after scanning and immediately before installation. A changed item is refused and must be imported again. Canceling, navigating away or closing the window cancels pending approval and removes its staging folder.

The same review applies when installing an agent pack, importing a workflow artifact, or installing a pasted MCP set. Creating a local item through its editor remains a local authoring operation.

## Export an item

1. Choose the item type: Skill, Agent, Workflow or Prompt.
2. Select a local item from the Item picker.
3. Choose **Export bundle** and save the JSON file.

Exports include supporting skill files. They currently use an unsigned local-publisher manifest and conservatively declare command, network and file access. Recipients review those declarations alongside the content and scanner report. Bundle files are stored as private data; scripts should be invoked through an explicit interpreter rather than relying on an executable bit.

The bundle validator accepts relative regular-file paths, verifies every SHA-256 hash and an optional Ed25519 publisher signature, and checks kind-specific layouts. Limits are 200 files, 512 KiB per file, 4 MiB of decoded content and an 8 MiB bundle envelope. Links, path traversal and reserved platform filenames are refused.

## Use a local scanner

Choose an executable under **Local scanner**. Husk invokes it without a shell:

```text
<scanner> scan --artifact <staged-folder> --format json --output <report-file>
```

The timeout is 30 seconds. Reports must contain a `vulnerabilities` array, or `null` for no findings. Each finding can include `id`, `title`, `severity`, `category`, `description`, `evidence` and `location`. Optional top-level fields are `verdict` (`block`, `review`, `clear`) and `capabilities` (`commands`, `hosts`, `files` arrays).

When a verdict is absent, HIGH or CRITICAL findings with a WG1-prefixed id block installation; other findings require review. A numeric nonzero exit code can still accompany a valid blocking report. A killed scanner, timeout or unreadable output is Unscanned. Cached results depend on both the staged content hash and the scanner executable's size and modification time.

Husk's security scanner supports this contract in its artifact mode. The ordinary workflow-only mode does not substitute for it. The scanner is external to the Husk package and must be selected separately.

## Publisher trust

Optional bundle publisher trust is configured through `trustedPublishers` in the local config, as an array of `{ "name": "Publisher", "publicKey": "base64 SPKI DER Ed25519 key" }`. Obtain that public key from a publisher you already trust. An unknown but valid signature is labeled Untrusted; an invalid signature is refused.
