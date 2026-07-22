# DriveBackgroundedApp

Clicking, typing, sending keys, or dragging against a macOS app that is not frontmost — and you must not bring it to the foreground. Use this when the user says "scroll Mail", "type into TextEdit without switching to it", "click that button in Signal while I keep working", or any task where the target app is occluded, hidden, or just not focused.

**Do not call `interceptor macos app activate` before the input.** That defeats the entire purpose. The bridge has dedicated background-routing paths (AX press, AX value-set, `CGEvent.postToPid`) that deliver input to a specific PID without changing what the user is looking at.

## The two routing paths

| You provide | What the bridge does | Frontmost changes? |
|---|---|---|
| A ref (`e5`, `e2_7`) | `AXUIElementPerformAction(kAXPressAction)` or `AXUIElementSetAttributeValue` — pure AX, no event posting | No |
| `--app "X"` or `--pid <n>` (no ref) | Synthesized `CGEvent.postToPid(pid_t)` — events delivered to that PID | No |
| Neither | Falls back to `cghidEventTap` (legacy "drive whatever's frontmost") | Whatever's frontmost gets it |

**Always prefer refs.** Strongest signal of intent, no focus needed, live-verified to leave frontmost untouched.

## AX value-set is gated to text-bearing roles

`AXTextField`, `AXTextArea`, `AXSearchField`, `AXComboBox`. Other roles fall back to synthesized key events posted via `postToPid` of the ref's owning PID. You usually don't need to think about this — the bridge routes for you — but it's why typing into a Cocoa text field "just works" and typing into a custom drawn control doesn't.

## Reading the routing tag

Every input verb returns a routing tag in its success message. **Always check it.**

- `"ax-pressed ref"` — pure AX press. No event posting. Fastest, most reliable.
- `"ax-set value (N chars)"` — AX value-set. N matches the string length.
- `"clicked at (x, y) → pid=NNNN"` — synthesized CGEvent posted to a specific PID. Good — no focus change.
- `"clicked at (x, y) → frontmost"` — synthesized CGEvent on the system HID tap. **Legacy fallback.** If you see this when you expected per-PID delivery, the target wasn't resolvable. Pass `--app` or `--pid` explicitly.

## Worked example: type into a backgrounded TextEdit

```bash
# Whatever's frontmost stays frontmost. We populate TextEdit silently.
interceptor macos open "TextEdit"                          # no activation; reads AX state
interceptor macos focused --app "TextEdit"                 # → ref e1 = AXTextArea
interceptor macos type e1 "hello, background world"        # → "ax-set value (21 chars)"
interceptor macos value e1                                 # confirms text landed
interceptor macos frontmost                                # unchanged
```

The final `frontmost` call is the proof of correctness — same app before and after.

## Worked example: scroll Mail without touching it

```bash
interceptor macos scroll down 400 --app "Mail" --times 5 --interval-ms 80
interceptor macos frontmost                                # unchanged
```

`postToPid` delivers wheel events directly to Mail's process. Cocoa and most Electron apps handle this fine in the background.

## Worked example: click into Signal (Electron, occluded)

```bash
interceptor macos tree --app "Signal" --filter interactive   # AX tree auto-wakes via AXManualAccessibility
interceptor macos act e7                                     # AX press on the ref — "ax-pressed ref"
```

## Pitfalls

- **Chromium-occluded event delivery.** Chromium pauses its event loop when fully occluded. Scroll/click sometimes won't process until the window is at least partially visible. If you see a no-op against an occluded Chromium app, brief-raise (capture frontmost first, raise the target, do the input, restore the previous frontmost), or ask the user to bring it forward.
- **Legacy fallback.** A bare `interceptor macos click 100,200` with no ref / `--app` / `--pid` follows the user's current frontmost. Documented behavior, but almost never what you want.
- **AX value-set replaces existing text.** To append, read `value <ref>` first, concatenate, then `type <ref> "<combined>"`.
- **Stale refs after a redraw.** AXObserver invalidates refs when the app rebuilds part of its tree. If `act <ref>` returns "stale ref", re-run `tree --app "X"` or `focused --app "X"`.

## Output format

Report:
- The routing tag returned by each input verb (`ax-pressed ref`, `ax-set value (N chars)`, `→ pid=NNNN`)
- What you intended vs what landed (verify with `value <ref>` for text, `read` / `tree` for clicks)
- Frontmost app before and after — proof that focus did not change
- If `→ frontmost` appeared when you didn't want it: which call, and the corrected invocation with `--app` or `--pid`
