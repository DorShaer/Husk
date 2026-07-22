# DispatchAppleEvent

Sending an Apple Event to a named macOS app — open a URL in Brave, read the active tab URL, make a new tab, get a list of running documents in TextEdit, dispatch any AppleScript verb against a specific bundle. Apple Events deliver to the target app without bringing it to the foreground.

**Do not include `activate` in the AppleScript block.** That's the single most common mistake. `activate` is what foregrounds the app — the whole reason you're using `intent dispatch` is to avoid that.

## The recipe

```bash
interceptor macos intent dispatch --bundle <id> --script '<applescript>'
```

The `<id>` is the bundle identifier (look up via `interceptor macos apps` if you don't know it). The `<applescript>` is a single line or block that runs in the context of the target app.

## Common bundle ids

| App | Bundle id |
|---|---|
| Brave Browser | `com.brave.Browser` |
| Google Chrome | `com.google.Chrome` |
| Safari | `com.apple.Safari` |
| Mail | `com.apple.mail` |
| Notes | `com.apple.Notes` |
| Finder | `com.apple.finder` |
| Music | `com.apple.Music` |

## Worked examples

```bash
# Open a URL in Brave (no activation)
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application id "com.brave.Browser" to open location "https://example.com"'

# Read the active tab URL of Brave
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to URL of active tab of front window'

# New tab in Brave to a specific URL
interceptor macos intent dispatch --bundle com.brave.Browser \
  --script 'tell application "Brave Browser" to tell front window to make new tab with properties {URL:"https://example.com"}'

# Compose a Mail message
interceptor macos intent dispatch --bundle com.apple.mail \
  --script 'tell application "Mail" to make new outgoing message with properties {subject:"hi", content:"body"}'
```

None of those touch the user's frontmost app.

## TCC: first dispatch prompts for Apple Events consent

The first time the bridge sends an Apple Event to a given target app, macOS prompts the user with a consent dialog. Subsequent dispatches are silent. To pre-prompt for several apps in one go:

```bash
interceptor macos intent warmup com.brave.Browser com.apple.mail com.apple.Notes
```

Fires a no-op event against each bundle id and surfaces all consent prompts up front — better UX than tripping them mid-workflow.

## Pitfalls

- **`activate` in the script.** Removes the entire benefit. Strip it.
- **`tell application "X" to launch then open …`.** `launch` without `activate` is generally fine, but on cold-launch some AppKit apps still self-activate via `kAEOpenApplication`. If you need a guaranteed-cold-launch with no focus change, this is a platform limitation, not an interceptor bug.
- **AppleScript disabled in the target app.** Some apps gate scripting behind a preference (Microsoft Office's "Allow AppleScript" toggle). Surface the error to the user; don't silently fall back.
- **Quoting.** AppleScript strings use double quotes, so wrap the whole `--script` in single quotes. If the script itself needs single quotes, escape with `'\''`.

## Output format

Report:
- The bundle id and script that ran
- The return value (URL, title, message id, etc.)
- Frontmost app before and after — proof that focus did not change
- If a TCC consent dialog appeared: surface that to the user and confirm after they answered
