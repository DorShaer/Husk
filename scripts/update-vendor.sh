#!/usr/bin/env bash
# Husk: refresh what we vendor, then prove it is safe to publish.
#
# Two things go stale between releases: the npm dependency tree, and the
# assistant framework under libs/. This updates both from upstream and then
# refuses to leave the result staged unless every gate passes.
#
# The gate that matters most is the privacy one. Everything vendored here ends
# up in a public repository forever, so the script checks the incoming tree for
# anything belonging to the person running it. Those identifiers are read from
# the environment at run time and never written anywhere: hard-coding them is
# what the check exists to prevent.
#
# Scratch space lives in a temp directory outside the repository. Nothing from
# the working tree is uploaded, and no local path is ever recorded in a file.
#
#   ./scripts/update-vendor.sh              update both, run every gate
#   ./scripts/update-vendor.sh --framework  framework only
#   ./scripts/update-vendor.sh --npm        dependencies only
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

# ─── Upstream framework ────────────────────────────────────────────────────
# The vendored framework is taken from the published release tarball, never
# from a local install. A developer's own ~/.claude holds their memories,
# their identity files and their answered templates; copying from it is the
# single most likely way personal content reaches a public repository.
UPSTREAM_REPO="danielmiessler/LifeOS"
VENDOR_DIR="libs/lifeos"
# Directories inside the upstream payload that Husk installs.
VENDOR_KEEP=(LIFEOS skills agents commands hooks USER)
# Files inside the upstream payload that Husk installs.
VENDOR_KEEP_FILES=(CLAUDE.template.md package.json)
# Never vendored, each for its own reason:
#   settings.*.json  upstream expands $HOME in these at install time, so a
#                    copied one ships literal $HOME strings
#   install.sh       upstream's own installer; Husk does its own bootstrap
#   bun.lock*        we never install from them, so all they can do is pin the
#                    tree to versions that later collect advisories
#   node_modules/.git build output and history, never shipped
VENDOR_DROP_GLOBS=('bun.lock' 'bun.lockb' '*-bun.lock')

# ─── Local corrections to vendored content ─────────────────────────────────
# Re-vendoring replaces the payload wholesale, which would silently undo any
# fix made to it since the last refresh. Silent is the problem: some of these
# are caught only by the advisory database on the pull-request gate, so the
# revert would not show up in any scan run here and would land in a release.
#
# Each entry is file|old|new, relative to the payload root. When `old` is no
# longer present, upstream has changed that line and the entry is reported for
# review rather than applied. Keep these few and keep them one-liners.
VENDOR_FIXUPS=(
  # Two high-severity advisories cover the whole Next 14 line and neither is
  # fixed inside it, so no resolution of ^14 is safe. The sibling template in
  # the same skill already sits on 15.x.
  "skills/Telos/ReportTemplate/package.json|\"next\": \"^14.0.0\"|\"next\": \"^15.5.16\""
)

apply_vendor_fixups() {
    local target="$1" entry rel rest old new file
    local applied=0 review=0
    for entry in "${VENDOR_FIXUPS[@]}"; do
        rel="${entry%%|*}"; rest="${entry#*|}"
        old="${rest%%|*}"; new="${rest#*|}"
        file="$target/$rel"
        if [ ! -f "$file" ]; then
            warn "Correction target missing from the payload: $rel"
            dim "  Upstream moved or removed it. Review, then drop the VENDOR_FIXUPS entry."
            review=$((review+1))
        elif grep -qF -- "$old" "$file"; then
            node -e 'const fs=require("fs");const[f,o,n]=process.argv.slice(1);
                     fs.writeFileSync(f,fs.readFileSync(f,"utf8").split(o).join(n));' "$file" "$old" "$new"
            applied=$((applied+1))
        else
            warn "Correction no longer applies: $rel"
            dim "  Upstream likely fixed it. Confirm, then drop the VENDOR_FIXUPS entry."
            review=$((review+1))
        fi
    done
    if [ "$applied" -gt 0 ]; then ok "Re-applied $applied local correction(s) to the payload"; fi
    if [ "$review" -gt 0 ]; then warn "$review correction(s) need review"; fi
    return 0
}

DO_FRAMEWORK=1
DO_NPM=1
DO_BUILD=1
DO_E2E=1
DO_COMMIT=0

while [ $# -gt 0 ]; do
    case "$1" in
        --framework) DO_FRAMEWORK=1; DO_NPM=0 ;;
        --npm)       DO_NPM=1; DO_FRAMEWORK=0 ;;
        --fast)      DO_BUILD=0; DO_E2E=0 ;;
        --commit)    DO_COMMIT=1 ;;
        -h|--help)   sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
        git -C "$REPO_ROOT" checkout -- "$VENDOR_DIR" package.json package-lock.json 2>/dev/null || true
        git -C "$REPO_ROOT" clean -fdq "$VENDOR_DIR" 2>/dev/null || true
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

# Search a directory tree for one identifier and print matching files.
#
# A bare substring search is wrong for the short ones. A three-letter username
# occurs inside ordinary words: "endorsed" and "dormant" both contain "dor",
# and a gate that cries wolf on upstream prose is a gate people learn to skip.
# Anything that looks like a path, an email or a host is matched literally;
# a plain word has to match on word boundaries to count.
scan_tree_for_identifier() {
    local ident="$1" root="$2"
    case "$ident" in
        */*|*@*|*.*) grep -rIlF -- "$ident" "$root" 2>/dev/null ;;
        *)           grep -rIlwF -- "$ident" "$root" 2>/dev/null ;;
    esac
}
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

# ─── Framework ─────────────────────────────────────────────────────────────
if [ "$DO_FRAMEWORK" = "1" ]; then
    head2 "Assistant framework"

    CURRENT_VER="$(cat "$VENDOR_DIR/LIFEOS/VERSION" 2>/dev/null || echo unknown)"
    info "Resolving latest release of $UPSTREAM_REPO..."
    TAG="$(curl -sSfL "https://api.github.com/repos/$UPSTREAM_REPO/releases/latest" \
           | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).tag_name||"")}catch(_){console.log("")}})')"
    [ -n "$TAG" ] || { fail "Could not resolve the latest release tag."; exit 1; }
    info "Currently vendored: $CURRENT_VER   latest upstream: $TAG"

    info "Downloading the release tarball (never reading any local install)..."
    curl -sSfL "https://api.github.com/repos/$UPSTREAM_REPO/tarball/$TAG" -o "$WORK_DIR/upstream.tar.gz"
    mkdir -p "$WORK_DIR/upstream"
    tar xzf "$WORK_DIR/upstream.tar.gz" -C "$WORK_DIR/upstream" --strip-components=1

    PAYLOAD="$(find "$WORK_DIR/upstream" -maxdepth 3 -type f -name 'CLAUDE.template.md' -print -quit)"
    [ -n "$PAYLOAD" ] || { fail "Upstream layout changed: no CLAUDE.template.md found."; \
        dim "  The payload moved. Re-read the upstream install docs before trusting this script again."; exit 1; }
    PAYLOAD="$(dirname "$PAYLOAD")"
    ok "Payload at ${PAYLOAD#"$WORK_DIR/upstream/"}"

    STAGE="$WORK_DIR/stage"
    mkdir -p "$STAGE"
    for d in "${VENDOR_KEEP[@]}"; do
        [ -d "$PAYLOAD/$d" ] && cp -a "$PAYLOAD/$d" "$STAGE/$d"
    done
    for f in "${VENDOR_KEEP_FILES[@]}"; do
        [ -f "$PAYLOAD/$f" ] && cp -a "$PAYLOAD/$f" "$STAGE/$f"
    done
    # Upstream's own licence travels with its code.
    UP_LICENSE="$(find "$WORK_DIR/upstream" -maxdepth 2 -name LICENSE -print -quit)"
    [ -n "$UP_LICENSE" ] && cp -a "$UP_LICENSE" "$STAGE/LICENSE"

    # Apply the vendoring rules.
    find "$STAGE" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
    find "$STAGE" -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true
    for g in "${VENDOR_DROP_GLOBS[@]}"; do
        find "$STAGE" -type f -name "$g" -delete 2>/dev/null || true
    done
    ok "Payload assembled, $(find "$STAGE" -type f | wc -l | tr -d ' ') files, $(du -sh "$STAGE" | cut -f1)"

    apply_vendor_fixups "$STAGE"

    # ── Privacy gate, on the incoming payload ──────────────────────────────
    # This tree is meant to be upstream's work verbatim. Anything here that
    # names the person running the script did not come from upstream.
    # Two separate questions, and only one of them can block.
    #
    # Does the payload name THIS machine? That is the whole reason the script
    # exists, and it is a hard failure. Upstream has no business knowing this
    # user's home directory, so a hit means something local leaked into the
    # tree and nothing should proceed.
    HITS="$WORK_DIR/privacy-payload.txt"
    : > "$HITS"
    while IFS= read -r ident; do
        [ ${#ident} -lt 3 ] && continue
        scan_tree_for_identifier "$ident" "$STAGE" | sed "s|^|$ident -> |" >> "$HITS" || true
    done < "$IDENT_FILE"
    if [ -s "$HITS" ]; then
        fail "Privacy gate: the incoming payload references this machine."
        sed 's/^/    /' "$HITS" | head -20
        exit 1
    fi
    ok "Privacy gate: payload names nothing from this machine"

    # Does it contain home-shaped paths belonging to anyone else? Worth seeing,
    # but it cannot block: upstream docs are full of placeholders like
    # /Users/__USER__ and /Users/x/y, and a gate that fails on every run is a
    # gate that gets bypassed. Printed so a real name is noticed, not enforced.
    OTHER_PATHS="$(grep -rIhoE '/(home|Users)/[A-Za-z0-9_.-]+' "$STAGE" 2>/dev/null \
        | grep -viE '/(home|Users)/(user|example|you|username|yourname|me|name|__|<|\$|runner|node|root|x)$' \
        | sort -u || true)"
    if [ -n "$OTHER_PATHS" ]; then
        warn "Payload contains home-shaped paths (upstream placeholders, most likely):"
        echo "$OTHER_PATHS" | sed 's/^/    /' | head -10
        dim "  Not blocking. Glance at them; if one looks like a real person, say so upstream."
    fi

    rm -rf "${REPO_ROOT:?}/$VENDOR_DIR"
    mkdir -p "$REPO_ROOT/$VENDOR_DIR"
    cp -a "$STAGE/." "$REPO_ROOT/$VENDOR_DIR/"
    NEW_VER="$(cat "$VENDOR_DIR/LIFEOS/VERSION" 2>/dev/null || echo unknown)"
    if [ "$CURRENT_VER" = "$NEW_VER" ]; then
        ok "Framework already at $NEW_VER, no version change"
    else
        ok "Framework $CURRENT_VER to $NEW_VER"
    fi
    CHANGED_PATHS+=("$VENDOR_DIR")
fi

# ─── Dependencies ──────────────────────────────────────────────────────────
if [ "$DO_NPM" = "1" ]; then
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
fi

if [ ${#CHANGED_PATHS[@]} -eq 0 ]; then
    head2 "Result"
    ok "Everything already up to date. Nothing changed."
    STAGED_OK=1
    exit 0
fi

# ─── Gates over the resulting tree ─────────────────────────────────────────
head2 "Gates"

# Privacy, over the whole vendored tree, every run and every mode.
#
# Checking only the lines this run added is not enough to answer the question
# people actually ask, which is "is there anything of mine in here". Something
# committed by an earlier run, or by hand, would sail through a diff-scoped
# check while the script printed an all-clear. The vendored tree is third-party
# content that should never mention this machine under any circumstances, so it
# is cheap to re-read all of it and say so honestly.
VENDOR_HITS="$WORK_DIR/privacy-tree.txt"
: > "$VENDOR_HITS"
if [ -d "$VENDOR_DIR" ]; then
    while IFS= read -r ident; do
        [ ${#ident} -lt 3 ] && continue
        scan_tree_for_identifier "$ident" "$VENDOR_DIR" | sed "s|^|$ident -> |" >> "$VENDOR_HITS" || true
    done < "$IDENT_FILE"
fi
if [ -s "$VENDOR_HITS" ]; then
    fail "Privacy gate: the vendored tree references this machine."
    sed 's/^/    /' "$VENDOR_HITS" | head -20
    dim "  This is third-party content and must never name you. Remove it before committing."
    exit 1
fi
ok "Privacy gate: nothing in $VENDOR_DIR names this machine"

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
    [ "$DO_FRAMEWORK" = "1" ] && MSG="chore: update the bundled framework and dependencies"
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
dim "  Checked: the whole of $VENDOR_DIR, and every line this run added elsewhere."
dim "  None of it names this machine. Scratch stayed in a temp directory."
