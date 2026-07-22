# ReadAxTree

Reading the accessibility tree of a macOS app without bringing it to the foreground. Use this when you need to know what's in another app's UI — a button label, window title, a text field's current value, the structure of a menu — and the app may be backgrounded, occluded, or just not focused.

**The bridge handles Electron's AX wake-up for you.** Electron apps (Slack, Discord, Cursor, Brave, Notion, VS Code) gate their AX tree on visibility for performance. Interceptor fires `AXManualAccessibility` to wake them up — no focus change.

## The recipe

```bash
interceptor macos tree --app "Cursor" --filter interactive --depth 6
```

That call:
1. Resolves "Cursor" to a running app and its main window.
2. Fires `AXManualAccessibility = true` on the app element (Chromium-specific signal — wakes the tree without activating).
3. Walks the AX tree to depth 6.
4. Filters to interactive elements only.
5. Returns refs (`e5`, `e7`, …) and labels.

## Important — wake-up signal

The bridge uses `AXManualAccessibility` exclusively. **`AXEnhancedUserInterface` was removed** because it foregrounded AppKit apps (it's the "VoiceOver is active" flag, which AppKit interprets as "raise main window"). Don't expect or set it. Stale guidance from old code is wrong.

For apps that gate AX on visibility (Signal is the classic example), `AXManualAccessibility` may not be enough. The bridge cannot beat a deliberately-paused process loop. In that case: brief-raise the app, capture `frontmost` first, do the read, then `app activate <previous-frontmost>` to restore. Surface the focus change to the user.

## Filter options

- `--filter interactive` — clickable, editable, focusable elements only. Default for "find me something to act on".
- `--filter all` — every element, including decorative. Bigger output.

The `tree` verb advertises only `--filter interactive|all` in the 0.16.9 usage line. There is no `--filter labels` value — don't pass it. For "what does this window say", use `--filter all` and read the labels off the returned nodes.

## Depth tuning

Default 4–6 is enough for most apps. Increase when:
- The target is a deep menu (`--depth 10` or more for nested submenus).
- You need to descend into a sidebar's nested rows (`--depth 8`).

Decrease when you only need the window-level structure (`--depth 2`).

## Worked examples

```bash
# What's in the main Slack window?
interceptor macos tree --app "Slack" --filter interactive --depth 6

# Read just the menu bar of Brave
interceptor macos menu --app "Brave Browser"

# Find the AX ref of a specific button without scanning the whole tree
interceptor macos find "Send" --app "Slack" --role button

# Look at one ref in detail
interceptor macos inspect e7
```

## Pitfalls

- **Reading too deep on a chatty app.** `--depth 20 --filter all` on VS Code returns thousands of nodes. Start narrow.
- **Refs from a stale tree.** AXObserver invalidates refs when the app rebuilds part of its tree. If `act <ref>` returns "stale ref", re-run `tree`.
- **"No visible windows" ≠ "not running".** A menu-bar-only app (tray app, Discord-in-tray) has no AX window but is still running. Use `interceptor macos apps` to confirm.

## Output format

Report:
- The app you read
- Number of nodes returned (sanity check)
- Refs and labels relevant to what the user asked
- Frontmost app before and after — proof that focus did not change
