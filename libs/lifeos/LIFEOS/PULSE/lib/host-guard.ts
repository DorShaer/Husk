/**
 * host-guard — anti-DNS-rebinding Host-header allowlist for the loopback Pulse server.
 *
 * Loopback binding alone does NOT protect a browser-triggerable service: a malicious page
 * the user visits can DNS-rebind its own hostname to 127.0.0.1 and drive Pulse's routes as
 * same-origin. The defence is a Host-header check — a real loopback client always sends
 * `Host: 127.0.0.1[:port]` or `localhost[:port]`; a rebinding attack sends the attacker's
 * hostname. We reject anything that isn't loopback. (Pattern from T3MP3ST src/server.ts:245-253.)
 *
 * Three deliberate carve-outs:
 *  - a missing/empty Host header is ALLOWED — header-less local CLIs (the menu-bar app,
 *    `curl localhost:PORT/notify`) legitimately omit it, exactly like T3MP3ST's carve-out.
 *  - when the server is bound to all interfaces (LIFEOS_PULSE_BIND_ALL=1, an explicit opt-in
 *    for phone/fleet LAN access), the guard is disabled by the caller — LAN clients send a
 *    non-loopback Host by design.
 *  - LIFEOS_PULSE_EXTRA_HOSTS (comma-separated) lets a user allow their own trusted
 *    /etc/hosts aliases that resolve to 127.0.0.1 (e.g. `pai`), so `http://pai:PORT` works.
 *    Opt-in, empty by default, and the port check below still applies. It slightly widens
 *    the rebinding surface to those exact names, so keep it to aliases only you control.
 *
 * The 127 match is a FULL DOTTED QUAD (`^127(?:\.\d{1,3}){3}$`), never a `/^127\./` prefix —
 * a prefix would let `127.0.0.1.evil.com` through, which is the exact rebinding shape.
 */
function extraAllowedHosts(): string[] {
  const raw = process.env.LIFEOS_PULSE_EXTRA_HOSTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isLoopbackHostHeader(hostHeader: string | null | undefined, port: number): boolean {
  if (!hostHeader || !hostHeader.trim()) return true; // header-less local CLI — allowed
  const h = hostHeader.trim().toLowerCase();

  // Split host and optional :port. IPv6 literals are bracketed: [::1]:PORT.
  let bare: string;
  let portPart: string | null = null;
  const v6 = h.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (v6) {
    bare = v6[1];
    portPart = v6[2] ?? null;
  } else {
    const m = h.match(/^([^:]+)(?::(\d+))?$/);
    if (!m) return false;
    bare = m[1];
    portPart = m[2] ?? null;
  }

  const isLoopback =
    bare === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(bare) || // full quad, NOT a 127. prefix
    bare === "[::1]" ||
    bare === "::1" ||
    extraAllowedHosts().includes(bare); // user-trusted local aliases (opt-in)
  if (!isLoopback) return false;

  // If a port is present it must be ours (defence in depth; absent port is fine).
  if (portPart !== null && parseInt(portPart, 10) !== port) return false;
  return true;
}
