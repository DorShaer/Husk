#!/usr/bin/env bash
# Husk one-line installer. Meant to be run straight from the network:
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/DorShaer/Husk@main/scripts/install.sh | bash
#
# It picks the best install path for the machine it lands on:
#   - Debian / Ubuntu (apt) -> add the signed apt repo, `apt install husk`
#     (this is the recommended path: `apt upgrade` keeps Husk current)
#   - other Linux           -> download the latest AppImage from Releases
#   - macOS                 -> download the latest .dmg and copy Husk.app in
#   - anything else          -> clone the repo and run install.sh from source
set -euo pipefail

OWNER="DorShaer"
REPO="Husk"
PAGES="https://dorshaer.github.io/Husk"
API="https://api.github.com/repos/${OWNER}/${REPO}"

C_OK=$'\033[0;32m'; C_INFO=$'\033[0;36m'; C_WARN=$'\033[1;33m'; C_RST=$'\033[0m'
info() { printf '%s▸%s %s\n' "$C_INFO" "$C_RST" "$1"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RST" "$1"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_RST" "$1" >&2; }
die()  { warn "$1"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

# sudo() wrapper: use sudo when not already root, else run as-is.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# latest_asset_url <regex> -> the first Release asset download URL matching it.
latest_asset_url() {
  curl -fsSL "${API}/releases/latest" \
    | grep -oE "https://[^\"']+$1" \
    | head -n1
}

# verify_sha256 <file> <asset-name>: fetch the release SHA256SUMS and check
# the file against it. Skips (with a warning) if the sums file is absent.
verify_sha256() {
  local file="$1" name="$2" sums
  sums="$(curl -fsSL "$(latest_asset_url 'SHA256SUMS')" 2>/dev/null || true)"
  if [ -z "$sums" ]; then warn "no SHA256SUMS published; skipping checksum"; return 0; fi
  local want got
  want="$(printf '%s\n' "$sums" | awk -v n="$name" '$2==n||$2=="*"n {print $1}' | head -n1)"
  [ -n "$want" ] || { warn "no checksum entry for $name; skipping"; return 0; }
  got="$(sha256sum "$file" | awk '{print $1}')"
  [ "$want" = "$got" ] || die "checksum mismatch for $name"
  ok "checksum verified"
}

install_apt() {
  info "Debian/Ubuntu detected, using the signed apt repository"
  need curl || die "curl is required"
  as_root install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
  curl -fsSL "${PAGES}/husk.gpg" | as_root gpg --dearmor --yes -o /usr/share/keyrings/husk.gpg
  echo "deb [signed-by=/usr/share/keyrings/husk.gpg] ${PAGES}/apt stable main" \
    | as_root tee /etc/apt/sources.list.d/husk.list >/dev/null
  as_root apt-get update
  as_root apt-get install -y husk
  ok "Husk installed. Run 'husk', or launch it from your applications menu."
  info "Updates arrive with 'sudo apt upgrade'."
}

install_appimage() {
  info "Installing the latest AppImage"
  need curl || die "curl is required"
  local url name tmp dest bindir
  url="$(latest_asset_url 'linux-x86_64\.AppImage')"
  [ -n "$url" ] || die "no AppImage found in the latest release"
  name="$(basename "$url")"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url" -o "$tmp/$name"
  verify_sha256 "$tmp/$name" "$name"
  bindir="$HOME/.local/bin"; mkdir -p "$bindir"
  dest="$HOME/.local/share/husk/$name"
  mkdir -p "$(dirname "$dest")"
  install -m 0755 "$tmp/$name" "$dest"
  ln -sf "$dest" "$bindir/husk"
  ok "Installed to $dest (symlinked as ~/.local/bin/husk)"
  case ":$PATH:" in *":$bindir:"*) : ;; *) warn "add $bindir to your PATH";; esac
  need fusermount || need fusermount3 || warn "AppImage needs FUSE; install libfuse2 if it fails to launch"
}

install_macos() {
  info "Installing the latest macOS build"
  need curl || die "curl is required"
  local arch url name tmp mnt app
  arch="$(uname -m)"; [ "$arch" = "arm64" ] || arch="x64"
  url="$(latest_asset_url "mac-${arch}\\.dmg")"
  [ -n "$url" ] || die "no .dmg found for arch ${arch}"
  name="$(basename "$url")"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url" -o "$tmp/$name"
  verify_sha256 "$tmp/$name" "$name"
  mnt="$(hdiutil attach -nobrowse -quiet "$tmp/$name" | awk '/Volumes/{print $3; exit}')"
  app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -n1)"
  [ -n "$app" ] || { hdiutil detach -quiet "$mnt"; die "no .app inside the dmg"; }
  rm -rf "/Applications/Husk.app"
  cp -R "$app" /Applications/
  hdiutil detach -quiet "$mnt"
  ok "Installed to /Applications/Husk.app"
}

install_source() {
  info "Falling back to a source install"
  need git || die "git is required for the source install"
  local dir="$HOME/.husk-src"
  if [ -d "$dir/.git" ]; then git -C "$dir" pull --ff-only; else
    git clone --depth 1 "https://github.com/${OWNER}/${REPO}.git" "$dir"; fi
  ( cd "$dir" && ./install.sh )
}

main() {
  case "$(uname -s)" in
    Linux)
      if need apt-get && need dpkg; then install_apt
      else install_appimage; fi ;;
    Darwin) install_macos ;;
    *) install_source ;;
  esac
}

main "$@"
