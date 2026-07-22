# TrustedInputGate

Completing a flow that requires OS-level trusted input — a native app or web page that filters synthesized `CGEvent`s and only accepts events from real hardware (real HID source state). The rare case where the synthetic-first default fails by design.

**Try the default path first.** Synthetic events (the bridge's standard `click` / `type` / `keys`) work on almost everything. The browser-side equivalent — dispatched DOM events with `event.__interceptor_trust = true` — handles most `isTrusted`-checking webapps. Only escalate to `--trusted` after you've observed synthetic input failing.

## `--trusted` vs `--os`

v0.13.3 renamed `--os` to `--trusted` (canonical). `--os` is kept as a deprecated alias and emits a warning. Use `--trusted` in new code.

## When `--trusted` is the answer

Look for these symptoms:
- The synthetic call returns successfully but the target acts as if nothing happened.
- The target is a native gate that checks `CGEventSourceGetSourceStateID` against `kCGEventSourceStateHIDSystemState`.
- The target is a webapp that reads `isTrusted` via a cached per-instance own property captured at boot (bypassing the prototype override).
- A banking, payment, or anti-automation page rejects standard input.

In those cases, `--trusted` flips the bridge to post events through `CGEvent.post(.cghidEventTap)` with `kCGEventSourceStateHIDSystemState`. The OS treats it as real hardware input.

## Verify permissions first

```bash
interceptor macos trust
```

Response shape (0.16.9 keys are camelCase — `accessibility`, `screenRecording`, `microphone`; there is NO `inputMonitoring` field):
- `accessibility` — must be `granted`. Without it, `CGEvent` posting fails silently.
- `screenRecording` — granted enables capture; not strictly needed for input gates.
- `microphone` — separate consent, not required here.

If accessibility is `denied`, surface the deep link from `trust --walkthrough` so the user can grant it.

**This machine right now shows `accessibility: denied`** — so any `--trusted` / AX-input flow silently no-ops until the grant lands (this is the intended pitfall, not a bug). Probe `trust` before assuming a `--trusted` call did anything.

## The recipe

```bash
# Type with HID source state — looks like real keyboard input
interceptor macos type "..." --trusted

# Send keystrokes with HID source state
interceptor macos keys "Meta+S" --trusted

# Browser side — for sites that reject in-page synthetic events
interceptor act <ref> --trusted
```

These follow the user's current frontmost app (legacy HID semantics — that's how real keyboards work). For per-PID delivery, prefer the AX path with refs, or `--app` / `--pid` flagged input.

## Worked example

```bash
# 1. Navigate to the trusted-input page
interceptor open <trusted-input-fixture-url>

# 2. Identify the gate
interceptor read --tree-only

# 3. If standard `type` doesn't satisfy the gate, escalate:
interceptor macos keys "Tab" --trusted                  # focus the input
interceptor macos type "expected text" --trusted        # HID-level keystrokes

# 4. Verify the page accepted the input
interceptor read --text-only
```

Success criterion is whatever the gate reveals after acceptance — a "success" banner, a new DOM element, a network call. Read for it explicitly.

## Browser-side equivalent (when `--trusted` is overkill)

For webapps, the synthetic-events-with-trust-marker path is usually the right escalation, not `--trusted`. Dispatch via `eval --main`:

```javascript
const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
evt.__interceptor_trust = true;
element.dispatchEvent(evt);
```

Combined with the pre-load `userActivation` override (already installed via `inject-net.ts` at `document_start`), this handles transient-activation gates and per-event `isTrusted` checks without going to OS-level CGEvents. Only fall back to `--trusted` for native HID-source-state checks.

## Pitfalls

- **`--trusted` follows current frontmost.** Legacy "drive whatever's visible" semantics. If the user clicked away mid-flow, your keys go to the wrong app. Verify with `interceptor macos frontmost` immediately before each `--trusted` call.
- **Reaching for `--trusted` reflexively.** The historical reflex "site checks `isTrusted` → use `--trusted`" is no longer correct on most sites. The pre-load `userActivation` override + `__interceptor_trust` marker handles the vast majority. Measure first.
- **Forgetting Accessibility consent.** `CGEvent.post` silently no-ops without it. If a `--trusted` call returns success but nothing happens, check `trust` first.
- **Sensitive frontmost-app gate.** The bridge rejects `type` / `keys` / `click x,y` / `drag` when frontmost is a denylisted bundle (Keychain, 1Password, Dashlane, LastPass, Bitwarden, System Settings, Chase, Bank of America, Wells Fargo). Surface the rejection — do not bypass.

## Output format

Report:
- Why `--trusted` was needed (the observed symptom of synthetic failing)
- The exact call (`type` / `keys` / `act --trusted`)
- `frontmost` before and after each `--trusted` call (proof of correct targeting)
- The success indicator from the gate (banner text, new element, response status)
- Whether Accessibility TCC was granted before the call
