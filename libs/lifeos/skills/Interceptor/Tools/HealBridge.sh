#!/usr/bin/env bash
# HealBridge.sh — detect a loaded-but-dead Interceptor bridge LaunchAgent and
# restart it exactly once. Used only by macOS computer-use (macos_*) paths;
# browser screenshots do NOT need the bridge.
#
# "Loaded" != "running": launchctl can show the agent loaded while the process
# is dead. Probe the actual process via `interceptor status` (the bridge: block),
# not `launchctl list`. The agent runs the .app bundle binary
# (~/.local/share/interceptor/interceptor-bridge.app/Contents/MacOS/interceptor-bridge),
# NOT /usr/local/bin/interceptor-bridge (stale copy).
#
# Exit codes: 0 bridge running (already, or after restart); 1 restart attempted
# but still not running; 2 unsupported OS / interceptor missing.

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    echo "HealBridge.sh: bridge is macOS-only ($(uname -s) unsupported)" >&2
    exit 2
fi

if ! command -v interceptor >/dev/null 2>&1; then
    echo "HealBridge.sh: interceptor not found on PATH" >&2
    exit 2
fi

LABEL="com.interceptor.bridge"
UID_NUM="$(id -u)"

bridge_running() {
    # The `bridge:` block in `interceptor status` reads "running" with a pid when
    # the process is alive. Anything else (not running / missing block) = dead.
    interceptor status 2>&1 \
        | awk '/^bridge:/{inblk=1} inblk && /running/{print "running"; exit}' \
        | grep -q running
}

if bridge_running; then
    echo "[HealBridge] bridge already running" >&2
    exit 0
fi

echo "[HealBridge] bridge not running — kickstart -k gui/$UID_NUM/$LABEL" >&2
launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

# Give launchd a moment to (re)spawn, then re-probe once.
n=0
while [ "$n" -lt 10 ]; do
    if bridge_running; then
        echo "[HealBridge] bridge running after kickstart" >&2
        exit 0
    fi
    n=$((n + 1))
    sleep 0.3
done

cat >&2 <<EOF
[HealBridge] FAIL: bridge still not running after one kickstart.

REMEDIATION:
  - launchctl print "gui/$UID_NUM/$LABEL" | grep -E 'state|program|pid'
  - A SIGKILLed bridge with a stale ad-hoc signature restart-loops every ~5s
    (ThrottleInterval). Re-sign the .app MacOS binary:
      ~/.local/share/interceptor/interceptor-bridge.app/Contents/MacOS/interceptor-bridge
    (NOT the stale /usr/local/bin copy), then bootout + re-bootstrap the agent.
EOF
exit 1
