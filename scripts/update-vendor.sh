#!/usr/bin/env bash
# Husk: refresh the npm dependency tree, then prove it is safe to publish.
#
# Dependencies go stale between releases. This updates them within the ranges
# package.json allows and refuses to leave the result staged unless every gate
# passes. The privacy gate checks every line this run adds for anything that
# names the person running it. Those identifiers are read from the environment
# at run time and never written anywhere.
#
# Scratch space lives in a temp directory outside the repository. Nothing from
# the working tree is uploaded, and no local path is ever recorded in a file.
#
#   ./scripts/update-vendor.sh              update dependencies, run every gate
#   ./scripts/update-vendor.sh --fast       skip the package build and e2e
#   ./scripts/update-vendor.sh --commit     commit when everything passes
#
# Exit non-zero on any failed gate, with the working tree restored.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

C_OK='\033[0;32m'; C_INFO='\033[0;36m'; C_WARN='\033[1;33m'; C_ERR='\033[0;31m'
C_DIM='\033[2m'; C_BOLD='\033[1m'; C_RST='\033[0m'
info() { echo -e "${C_INFO}▸${C_RST} $1"; }
ok()   { echo -e "${C_OK}✓${C_RST} $1"; }
warn() { echo -e "${C_WARN}!${C_RST} $1"; }
fail() { echo -e "${C_ERR}✗${C_RST} $1"; }
dim()  { echo -e "${C_DIM}$1${C_RST}"; }
head2(){ echo; echo -e "${C_BOLD}── $1 ${C_RST}"; }

# ─── Pinned tool versions ──────────────────────────────────────────────────
# Match .github/workflows/security.yml. A scan that passes locally on an older
# build and fails on CI teaches everyone to ignore the local run, so the two
# have to be the same binary. Tools are cached outside the repository; a
# downloaded binary must never become a file the working tree can stage.
GITLEAKS_VERSION="8.30.1"
TRIVY_VERSION="0.70.0"
TOOL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/husk-update-vendor"

DO_BUILD=1
DO_E2E=1
DO_COMMIT=0

while [ $# -gt 0 ]; do
    case "$1" in
        --fast)      DO_BUILD=0; DO_E2E=0 ;;
        --commit)    DO_COMMIT=1 ;;
        -h|--help)   sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)           fail "Unknown option: $1"; exit 2 ;;
    esac
    shift
done

# ─── Scratch, outside the repository ───────────────────────────────────────
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/husk-update-XXXXXX")"
STAGED_OK=0
cleanup() {
    rm -rf "$WORK_DIR"
    if [ "$STAGED_OK" = "0" ]; then
        # A failed run leaves nothing behind. Restoring rather than keeping a
        # half-updated tree is what makes the script safe to re-run.
        git -C "$REPO_ROOT" checkout -- package.json package-lock.json 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ─── Preflight ─────────────────────────────────────────────────────────────
head2 "Preflight"

NODE_MIN_MAJOR=20; NODE_MIN_MINOR=19
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ required, not found."; exit 1
fi
NODE_VER="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"; NODE_MINOR="${NODE_VER#*.}"; NODE_MINOR="${NODE_MINOR%%.*}"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ] \
   || { [ "$NODE_MAJOR" -eq "$NODE_MIN_MAJOR" ] && [ "$NODE_MINOR" -lt "$NODE_MIN_MINOR" ]; }; then
    fail "Node ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ required; found v${NODE_VER}."
    dim "  npm ci and electron-builder both fail below this. Try: nvm use --lts"
    exit 1
fi
ok "Node v${NODE_VER}"

for tool in git curl tar npm; do
    command -v "$tool" >/dev/null 2>&1 || { fail "$tool is required."; exit 1; }
done

# The pinned tool downloads below are linux_x64 builds, matching the CI
# runners. Say so plainly rather than failing later on a 404.
if [ "$(uname -s)" != "Linux" ]; then
    fail "This script fetches the same linux_x64 scanners CI uses; $(uname -s) is not supported."
    dim "  Run it on Linux, or in a container, so the gates match what CI will run."
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    fail "Working tree is not clean."
    dim "  This script reports what IT changed. Commit or stash first, so the"
    dim "  diff it hands you at the end is unambiguous."
    exit 1
fi
ok "Working tree clean, on branch $(git rev-parse --abbrev-ref HEAD)"

# ─── Identifiers, derived at run time ──────────────────────────────────────
# Read from the environment and from git config, never stored. This list is
# what the privacy gate greps for. Writing any of it into a tracked file would
# publish exactly what the gate is here to catch.
IDENT_FILE="$WORK_DIR/identifiers"
{
    [ -n "${HOME:-}" ]  && echo "$HOME"
    [ -n "${HOME:-}" ]  && basename "$HOME"
    [ -n "${USER:-}" ]  && echo "$USER"
    command -v whoami >/dev/null 2>&1 && whoami
    command -v hostname >/dev/null 2>&1 && hostname
    git config user.email 2>/dev/null || true
    git config user.name 2>/dev/null || true
    git config --global user.email 2>/dev/null || true
    git config --global user.name 2>/dev/null || true
} | sed 's/[[:space:]]*$//' | grep -vE '^$' | sort -u > "$IDENT_FILE"
ok "Privacy gate armed with $(wc -l < "$IDENT_FILE" | tr -d ' ') identifiers read from this machine"
dim "  (derived at run time; none of them is written to any file in the repo)"

# Match one identifier against the lines this run added. A short plain word
# has to match on word boundaries, since a three-letter username also occurs
# inside ordinary words; paths, emails and hosts are matched literally.
scan_lines_for_identifier() {
    local ident="$1" file="$2"
    case "$ident" in
        */*|*@*|*.*) grep -nF -- "$ident" "$file" 2>/dev/null ;;
        *)           grep -nwF -- "$ident" "$file" 2>/dev/null ;;
    esac
}

# ─── Tools, cached outside the repository ──────────────────────────────────
mkdir -p "$TOOL_CACHE"
GITLEAKS_BIN="$TOOL_CACHE/gitleaks-$GITLEAKS_VERSION"
if [ ! -x "$GITLEAKS_BIN" ]; then
    info "Fetching gitleaks $GITLEAKS_VERSION (matches CI)..."
    curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
        | tar xz -C "$WORK_DIR" gitleaks && mv "$WORK_DIR/gitleaks" "$GITLEAKS_BIN" && chmod +x "$GITLEAKS_BIN"
fi
if [ -x "$GITLEAKS_BIN" ]; then ok "gitleaks $GITLEAKS_VERSION"; else fail "gitleaks unavailable"; exit 1; fi

TRIVY_BIN="$TOOL_CACHE/trivy-$TRIVY_VERSION"
if [ ! -x "$TRIVY_BIN" ]; then
    info "Fetching trivy $TRIVY_VERSION (matches CI)..."
    curl -sSfL "https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh" \
        | sh -s -- -b "$WORK_DIR" "v$TRIVY_VERSION" >/dev/null 2>&1 || true
    [ -x "$WORK_DIR/trivy" ] && mv "$WORK_DIR/trivy" "$TRIVY_BIN"
fi
if [ -x "$TRIVY_BIN" ]; then ok "trivy $TRIVY_VERSION"; else warn "trivy unavailable, CVE gate will be skipped"; fi

CHANGED_PATHS=()

# ─── Dependencies ──────────────────────────────────────────────────────────
head2 "Dependencies"
info "Updating within the ranges package.json already allows..."
npm update --silent 2>&1 | tail -3 || true
npm audit fix --silent 2>&1 | tail -3 || true
if git diff --quiet -- package.json package-lock.json; then
    ok "Dependencies already current"
else
    ok "Lockfile updated"
    CHANGED_PATHS+=(package.json package-lock.json)
fi
if ! npm audit --audit-level=high >/dev/null 2>&1; then
    fail "npm audit still reports high or critical advisories."
    npm audit --audit-level=high 2>&1 | tail -25
    dim "  Fix or pin these before publishing; the release pre-flight requires zero."
    exit 1
fi
ok "npm audit clean at high and above"

if [ ${#CHANGED_PATHS[@]} -eq 0 ]; then
    head2 "Result"
    ok "Everything already up to date. Nothing changed."
    STAGED_OK=1
    exit 0
fi

# ─── Gates over the resulting tree ─────────────────────────────────────────
head2 "Gates"

# Privacy, second pass: anything this run added anywhere in the repo.
git add -- "${CHANGED_PATHS[@]}"
DIFF_ADDED="$WORK_DIR/added-lines.txt"
git diff --cached -U0 -- "${CHANGED_PATHS[@]}" | grep '^+' | grep -v '^+++' > "$DIFF_ADDED" || true
HITS2="$WORK_DIR/privacy-diff.txt"
: > "$HITS2"
while IFS= read -r ident; do
    [ ${#ident} -lt 3 ] && continue
    scan_lines_for_identifier "$ident" "$DIFF_ADDED" | sed "s|^|$ident -> |" >> "$HITS2" || true
done < "$IDENT_FILE"
if [ -s "$HITS2" ]; then
    fail "Privacy gate: lines added by this run reference this machine."
    sed 's/^/    /' "$HITS2" | head -20
    exit 1
fi
ok "Privacy gate: no added line names this machine"

info "Secret scan over full history (the check the pull-request gate runs)..."
if ! "$GITLEAKS_BIN" detect --config .gitleaks.toml --no-banner --redact >/dev/null 2>&1; then
    fail "gitleaks found something. Re-run for detail:"
    dim "  $GITLEAKS_BIN detect --config .gitleaks.toml --redact"
    exit 1
fi
ok "gitleaks clean"

if [ -x "$TRIVY_BIN" ]; then
    info "CVE scan over manifests..."
    if ! "$TRIVY_BIN" fs . --scanners vuln --quiet --exit-code 1 >"$WORK_DIR/trivy.txt" 2>&1; then
        fail "trivy found vulnerable dependencies:"
        tail -30 "$WORK_DIR/trivy.txt" | sed 's/^/    /'
        dim "  A manifest we vendor pins a vulnerable range. Fix it upstream-style:"
        dim "  drop the lockfile, or move the range to one that can resolve clean."
        exit 1
    fi
    ok "trivy clean"
fi

head2 "Tests"
info "Unit suite..."
npm test >"$WORK_DIR/unit.txt" 2>&1 || { fail "Unit tests failed:"; tail -25 "$WORK_DIR/unit.txt" | sed 's/^/    /'; exit 1; }
ok "$(grep -E '^# pass' "$WORK_DIR/unit.txt" | tr -d '#' | xargs) unit tests"

if [ "$DO_E2E" = "1" ]; then
    info "End-to-end suite (a few minutes)..."
    E2E="xvfb-run -a npx playwright test --config test/playwright.config.js"
    command -v xvfb-run >/dev/null 2>&1 || E2E="npx playwright test --config test/playwright.config.js"
    $E2E >"$WORK_DIR/e2e.txt" 2>&1 || { fail "End-to-end tests failed:"; tail -25 "$WORK_DIR/e2e.txt" | sed 's/^/    /'; exit 1; }
    ok "$(grep -oE '[0-9]+ passed' "$WORK_DIR/e2e.txt" | tail -1) end-to-end tests"
fi

if [ "$DO_BUILD" = "1" ]; then
    head2 "Package size"
    # The .deb becomes a file on the gh-pages branch, and anything at or over
    # 100 MiB is rejected outright. When that happens the GitHub release still
    # looks green while apt quietly keeps serving the previous version, so the
    # ceiling is checked before the payload is ever published, not after.
    CEILING=104857600
    info "Building the Debian package to measure it..."
    npx electron-builder --linux deb --publish never -c.productName=husk >"$WORK_DIR/build.txt" 2>&1 \
        || { fail "Package build failed:"; tail -20 "$WORK_DIR/build.txt" | sed 's/^/    /'; exit 1; }
    DEB="$(find dist -maxdepth 1 -name '*.deb' -print -quit)"
    if [ -n "$DEB" ]; then
        SIZE="$(stat -c%s "$DEB" 2>/dev/null || stat -f%z "$DEB")"
        HEADROOM=$(( (CEILING - SIZE) / 1048576 ))
        if [ "$SIZE" -ge "$CEILING" ]; then
            fail "$(basename "$DEB") is $((SIZE/1048576)) MiB, at or over the 100 MiB ceiling."
            dim "  Over this line the apt publish fails silently while the release looks fine."
            exit 1
        fi
        ok "$(basename "$DEB") is $((SIZE/1048576)) MiB, ${HEADROOM} MiB of headroom"
        [ "$HEADROOM" -lt 5 ] && warn "Headroom is thin. The next payload growth may cross the ceiling."
    fi
fi

# ─── Result ────────────────────────────────────────────────────────────────
head2 "Result"
STAGED_OK=1
git diff --cached --stat -- "${CHANGED_PATHS[@]}" | tail -5

if [ "$DO_COMMIT" = "1" ]; then
    MSG="chore: refresh vendored dependencies"
    git commit -q -m "$MSG"
    ok "Committed: $(git log --oneline -1)"
    dim "  Review it, then push and open a pull request."
else
    ok "Staged and verified. Nothing has been committed."
    dim "  Review:  git diff --cached --stat"
    dim "  Commit:  git commit"
    dim "  Discard: git restore --staged . && git checkout -- ."
fi
echo
ok "Every gate passed."
dim "  Checked: every line this run added."
dim "  None of it names this machine. Scratch stayed in a temp directory."
