#!/usr/bin/env bash
# Husk installer download-and-verify helpers. Sourced by install.sh.
#
# Pinning policy: the SHA256 constants in install.sh pin a specific
# upstream revision of any script we fetch. We download to a temp file
# and check its hash against the pinned value before executing.
#
# Updating a pin: review the upstream script you intend to allow, run
#   curl -fsSL <url> | sha256sum
# and replace the matching constant in install.sh.

# verify_sha256 <file> <expected-hex>
# Exit 0 if the file's SHA-256 equals expected, non-zero otherwise.
# Returns 2 on missing tool or unreadable file, 1 on mismatch.
verify_sha256() {
    local file="$1"
    local expected="$2"
    if [ -z "$file" ] || [ -z "$expected" ]; then
        return 2
    fi
    if [ ! -r "$file" ]; then
        return 2
    fi
    local actual=""
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$file" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$file" | awk '{print $1}')
    else
        return 2
    fi
    [ "$actual" = "$expected" ]
}

# download_and_verify <url> <expected-sha256> <out-file>
# curls url into out-file, then verifies. On any failure, removes the
# out-file and returns non-zero so the caller can refuse to proceed.
download_and_verify() {
    local url="$1"
    local expected="$2"
    local out="$3"
    if ! command -v curl >/dev/null 2>&1; then
        return 2
    fi
    if ! curl -fsSL --max-time 30 "$url" -o "$out"; then
        rm -f "$out"
        return 1
    fi
    if ! verify_sha256 "$out" "$expected"; then
        rm -f "$out"
        return 1
    fi
}
