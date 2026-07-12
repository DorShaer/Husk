#!/usr/bin/env bash
# Husk one-line installer. Meant to be run straight from the network:
#
#   curl -fsSL https://dorshaer.github.io/Husk/install.sh | bash
#
# It picks the best install path for the machine it lands on:
#   - Debian / Ubuntu (apt) -> add the signed apt repo, `apt install husk`
#     (this is the recommended path: `apt upgrade` keeps Husk current)
#   - Fedora / RHEL (dnf)   -> install the .rpm from Releases
#   - other glibc Linux     -> download the latest AppImage
#   - macOS                 -> download the latest .dmg and copy Husk.app in
#   - anything else         -> explain what to run instead
#
# Everything here is idempotent: re-running is safe, and a failure never leaves
# the machine half-configured.
set -euo pipefail

OWNER="DorShaer"
REPO="Husk"
PAGES="https://dorshaer.github.io/Husk"
RELEASES="https://github.com/${OWNER}/${REPO}/releases"

C_OK=$'\033[0;32m'; C_INFO=$'\033[0;36m'; C_WARN=$'\033[1;33m'; C_RST=$'\033[0m'
info() { printf '%s▸%s %s\n' "$C_INFO" "$C_RST" "$1"; }
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RST" "$1"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_RST" "$1" >&2; }
die()  { warn "$1"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

# One temp dir for the whole run, declared at global scope on purpose. A
# `local tmp` inside a function is already out of scope when the EXIT trap
# fires, and under `set -u` that made the trap itself abort with
# "tmp: unbound variable" - turning every SUCCESSFUL install into exit 1.
TMP=""
cleanup() { [ -n "${TMP:-}" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT
mktmp() { TMP="$(mktemp -d)"; }

# Root access is optional, not assumed. When neither root nor sudo exists we
# do not die with a raw "sudo: command not found"; callers fall back to a
# user-space install instead.
have_root() { [ "$(id -u)" -eq 0 ] || need sudo; }
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif need sudo; then sudo "$@"
  else die "this step needs root, but neither root nor sudo is available"; fi
}

# macOS ships `shasum`, not GNU coreutils' `sha256sum`. Calling the wrong one
# blew up the checksum step on every Mac before it ever reached the install.
sha256_of() {
  if need sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif need shasum;    then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}

# --------------------------------------------------------------------------
# Release resolution
#
# Deliberately avoids api.github.com: unauthenticated it allows 60 requests
# per hour per IP, which quietly breaks installs behind corporate NAT, on CI,
# and on shared networks. The /releases/latest redirect is unmetered and hands
# us the tag directly.
# --------------------------------------------------------------------------
TAG=""
resolve_tag() {
  [ -n "$TAG" ] && return 0
  local effective
  effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASES}/latest" 2>/dev/null || true)"
  TAG="${effective##*/}"
  case "$TAG" in
    v[0-9]*) ok "Latest release: $TAG" ;;
    *) die "could not determine the latest Husk release. Check your network, or grab a build from ${RELEASES}" ;;
  esac
}

asset_url() { printf '%s/download/%s/%s\n' "$RELEASES" "$TAG" "$1"; }

# Download an asset and verify it against the release's SHA256SUMS. A missing
# checksum is now fatal rather than a shrug: the install page promises
# "checksums verified", so skipping verification silently would make that a lie.
fetch_verified() {
  local name="$1" dest="$2" sums want got
  info "Downloading ${name}"
  curl -fSL --progress-bar "$(asset_url "$name")" -o "$dest" \
    || die "download failed for ${name}. Check your network, or grab it from ${RELEASES}"

  sums="$(curl -fsSL "$(asset_url SHA256SUMS)" 2>/dev/null || true)"
  [ -n "$sums" ] || die "could not fetch SHA256SUMS for ${TAG}; refusing to install an unverified binary"
  want="$(printf '%s\n' "$sums" | awk -v n="$name" '$2==n||$2=="*"n {print $1}' | head -n1)"
  [ -n "$want" ] || die "no checksum published for ${name}; refusing to install an unverified binary"
  got="$(sha256_of "$dest")" || die "no sha256 tool found (need sha256sum or shasum)"
  [ "$want" = "$got" ] || die "checksum mismatch for ${name} (expected ${want}, got ${got}). Not installing."
  ok "Checksum verified"
}

# --------------------------------------------------------------------------
# Debian / Ubuntu: signed apt repo
# --------------------------------------------------------------------------
install_apt() {
  info "Debian/Ubuntu detected, using the signed apt repository"
  local keyring="/usr/share/keyrings/husk.gpg" list="/etc/apt/sources.list.d/husk.list"
  local raw="$TMP/husk.key" bin="$TMP/husk.gpg"

  curl -fsSL "${PAGES}/husk.gpg" -o "$raw" || die "could not fetch the signing key from ${PAGES}/husk.gpg"

  # The key is published dearmored, which apt consumes as-is. Older published
  # keys were ASCII-armored, so handle both and pull in gnupg only when we
  # actually have to convert. Unconditionally piping through `gpg --dearmor`
  # is what made a bare debian/ubuntu image die with "gpg: command not found"
  # before doing any work at all.
  if head -c 30 "$raw" | grep -q 'BEGIN PGP'; then
    if ! need gpg; then
      info "Installing gnupg (needed to convert the ASCII-armored signing key)"
      as_root apt-get update -qq || true
      as_root apt-get install -y gnupg || die "could not install gnupg, which is required to add the signing key"
    fi
    gpg --dearmor < "$raw" > "$bin" || die "could not dearmor the signing key"
  else
    cp "$raw" "$bin"
  fi

  as_root install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
  as_root install -m 0644 "$bin" "$keyring"
  printf 'deb [signed-by=%s] %s/apt stable main\n' "$keyring" "$PAGES" > "$TMP/husk.list"
  as_root install -m 0644 "$TMP/husk.list" "$list"

  # If the repo is unreachable or the package will not install, put the machine
  # back exactly as we found it. A stale husk.list otherwise poisons every
  # future `apt update` the user runs, for every package they own.
  if ! as_root apt-get update; then
    as_root rm -f "$list" "$keyring"
    die "apt could not read the Husk repository; reverted the change. Try the AppImage: ${RELEASES}"
  fi
  if ! as_root apt-get install -y husk; then
    as_root rm -f "$list" "$keyring"
    die "apt failed to install husk; reverted the repository change. Try the AppImage: ${RELEASES}"
  fi

  ok "Husk installed. Run 'husk', or launch it from your applications menu."
  info "Updates arrive with 'sudo apt upgrade'."
}

# --------------------------------------------------------------------------
# Fedora / RHEL: the .rpm we were publishing but never installing
# --------------------------------------------------------------------------
install_rpm() {
  info "Fedora/RHEL detected, installing the .rpm"
  resolve_tag
  local name="husk-${TAG}-linux-x86_64.rpm"
  fetch_verified "$name" "$TMP/$name"
  if need dnf; then as_root dnf install -y "$TMP/$name"
  else as_root yum install -y "$TMP/$name"; fi
  ok "Husk installed. Run 'husk', or launch it from your applications menu."
}

# --------------------------------------------------------------------------
# Portable AppImage (no root required)
# --------------------------------------------------------------------------
install_appimage() {
  info "Installing the latest AppImage"
  resolve_tag
  local name dest bindir desktop icon
  name="husk-${TAG}-linux-x86_64.AppImage"
  fetch_verified "$name" "$TMP/$name"

  # Install under a STABLE, version-less filename. This is load bearing:
  # electron-updater only overwrites the AppImage in place when the existing
  # filename carries no version (AppImageUpdater.doInstall). Given a versioned
  # name it writes the new build beside the old one, deletes the old file, and
  # every launcher pointing at it breaks. A stable name is what makes in-app
  # auto-update actually work.
  dest="$HOME/.local/share/husk/Husk.AppImage"
  bindir="$HOME/.local/bin"
  mkdir -p "$(dirname "$dest")" "$bindir"
  install -m 0755 "$TMP/$name" "$dest"
  ln -sf "$dest" "$bindir/husk"

  # Give AppImage users a launcher. Without this, Husk installed as a command
  # only, so anyone expecting a desktop app found nothing in their menu.
  icon="$HOME/.local/share/icons/hicolor/256x256/apps/husk.png"
  desktop="$HOME/.local/share/applications/husk.desktop"
  mkdir -p "$(dirname "$icon")" "$(dirname "$desktop")"
  ( cd "$TMP" && "$dest" --appimage-extract 'usr/share/icons/hicolor/256x256/apps/husk.png' >/dev/null 2>&1 || true )
  if [ -f "$TMP/squashfs-root/usr/share/icons/hicolor/256x256/apps/husk.png" ]; then
    cp "$TMP/squashfs-root/usr/share/icons/hicolor/256x256/apps/husk.png" "$icon"
  fi
  cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Husk
GenericName=AI Agent Shell
Comment=Desktop home for CLI AI agents
Exec=$dest
Icon=$icon
Terminal=false
Categories=Development;Utility;
StartupWMClass=Husk
EOF
  chmod +x "$desktop"
  if need update-desktop-database; then update-desktop-database "$(dirname "$desktop")" 2>/dev/null || true; fi

  ok "Installed to $dest"
  ok "Launcher added: search 'Husk' in your applications menu"

  # AppImages need libfuse2 specifically. Testing for the `fusermount` binary
  # was a false negative on Ubuntu 24.04, which ships fusermount3 (libfuse3) and
  # no libfuse2: the check passed, then the app refused to launch.
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    warn "AppImages need libfuse2. If Husk will not start, install it:"
    warn "  Debian/Ubuntu: sudo apt install libfuse2"
    warn "  Fedora:        sudo dnf install fuse-libs"
  fi
  case ":$PATH:" in
    *":$bindir:"*) : ;;
    *) warn "$bindir is not on your PATH. To run 'husk' from a terminal, add to your shell rc:"
       warn "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
}

# --------------------------------------------------------------------------
# macOS
# --------------------------------------------------------------------------
install_macos() {
  info "Installing the latest macOS build"
  resolve_tag
  local arch name mnt app target
  arch="$(uname -m)"; [ "$arch" = "arm64" ] || arch="x64"
  name="husk-${TAG}-mac-${arch}.dmg"
  fetch_verified "$name" "$TMP/$name"

  # `awk '{print $3}'` broke on the real volume name: electron-builder titles the
  # volume "Husk <version>", and the space made awk hand back "/Volumes/Husk".
  # Take the whole /Volumes/... path instead of a whitespace-delimited field.
  mnt="$(hdiutil attach -nobrowse -readonly "$TMP/$name" | grep -o '/Volumes/.*' | tail -n1)"
  [ -n "$mnt" ] || die "could not mount ${name}"
  # shellcheck disable=SC2064
  trap "hdiutil detach -quiet '$mnt' >/dev/null 2>&1 || true; cleanup" EXIT

  app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -n1)"
  [ -n "$app" ] || die "no .app inside the dmg"

  # Prefer /Applications but fall back to ~/Applications rather than dying on a
  # managed or non-admin Mac, where /Applications is not user-writable.
  if [ -w /Applications ]; then
    target="/Applications"
  else
    target="$HOME/Applications"
    mkdir -p "$target"
    warn "/Applications is not writable; installing to $target instead"
  fi

  rm -rf "${target:?}/Husk.app"
  cp -R "$app" "$target/"
  hdiutil detach -quiet "$mnt" >/dev/null 2>&1 || true
  trap cleanup EXIT

  # Husk is not notarized yet, so Gatekeeper quarantines the download and shows
  # "Husk is damaged and can't be opened". Clearing the flag on a binary whose
  # checksum we just verified is the difference between a working install and
  # one that looks broken on first launch.
  xattr -dr com.apple.quarantine "$target/Husk.app" 2>/dev/null || true

  ok "Installed to $target/Husk.app"
  info "Launch it from Spotlight (Cmd+Space) or Launchpad."
  warn "Husk is not code-signed yet. If macOS still blocks it, open System Settings > Privacy & Security and click 'Open Anyway'."
}

# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------
main() {
  need curl || die "curl is required. Install it and re-run this command."
  mktmp

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin)
      install_macos
      ;;
    Linux)
      # Only x86_64 Linux builds exist today. Every other arch previously got an
      # x86_64 binary and an "exec format error" at launch, or an apt repo with
      # no installation candidate. Say so once, clearly.
      case "$arch" in
        x86_64|amd64) : ;;
        *) die "Husk has no ${arch} Linux build yet (x86_64 only). Watch ${RELEASES} for arm64, or build from source: https://github.com/${OWNER}/${REPO}" ;;
      esac

      # WSL runs a Linux kernel, but the GUI belongs to Windows. Installing the
      # Linux build here yields a desktop app that may never render a window.
      if grep -qi microsoft /proc/version 2>/dev/null; then
        warn "This looks like WSL. Husk is a desktop app, so install the Windows build instead."
        warn "In PowerShell, run:  irm ${PAGES}/install.ps1 | iex"
        die "aborting the WSL install"
      fi

      # Our Linux binaries are glibc-linked, so musl distros cannot run them no
      # matter how we install. Alpine used to get an AppImage it could never exec.
      if [ -f /etc/alpine-release ]; then
        die "Husk's Linux builds are glibc-only and cannot run on musl (Alpine). Use a glibc distro, or run Husk inside a distrobox/container."
      fi

      # System package managers need root. Rather than dying with a raw
      # "sudo: command not found", fall back to the AppImage, which installs
      # entirely inside $HOME and needs no privileges at all.
      if ! have_root; then
        warn "No root access (no sudo). Falling back to a user-space AppImage install."
        install_appimage
      elif need apt-get && need dpkg; then install_apt
      elif need dnf || need yum;      then install_rpm
      else install_appimage; fi
      ;;
    *)
      warn "Unsupported platform: ${os}. Husk supports Linux, macOS, and Windows."
      die "On Windows, run this in PowerShell:  irm ${PAGES}/install.ps1 | iex"
      ;;
  esac
}

main "$@"
