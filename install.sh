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
# Every path here is idempotent, and any failure reverts what it changed.
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

# One temp dir for the whole run, at global scope so the EXIT trap can still
# see it. A function-local would be out of scope by the time the trap fires,
# and under `set -u` an unset name aborts the trap itself.
TMP=""
cleanup() { [ -n "${TMP:-}" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT
mktmp() { TMP="$(mktemp -d)"; }

# Root is optional. Callers check have_root first and pick a user-space path
# when it is unavailable, so as_root only runs where privileges exist.
have_root() { [ "$(id -u)" -eq 0 ] || need sudo; }
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif need sudo; then sudo "$@"
  else die "this step needs root, but neither root nor sudo is available"; fi
}

# Linux ships `sha256sum`, macOS ships `shasum`. Accept whichever is present.
sha256_of() {
  if need sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif need shasum;    then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}

# --------------------------------------------------------------------------
# Release resolution
#
# Resolve the tag from the /releases/latest redirect rather than api.github.com.
# The JSON API allows 60 unauthenticated requests per hour per IP, a budget that
# is easily exhausted behind NAT or on CI. The redirect is unmetered.
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

# Download an asset and verify it against the release's SHA256SUMS. A missing or
# unmatched checksum is fatal: we never install bytes we could not verify.
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

  # apt consumes a dearmored (binary) keyring directly, which is how the key is
  # published. Accept an ASCII-armored key too, and only then pull in gnupg to
  # convert it, since a minimal Debian or Ubuntu image ships without gpg.
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

  # Revert the repo change if apt cannot read it or the package will not install.
  # A stale husk.list would otherwise fail every later `apt update` on the box.
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
# Fedora / RHEL
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

  # Install under a stable, version-less filename. electron-updater replaces the
  # AppImage in place only when the existing filename carries no version
  # (AppImageUpdater.doInstall); given a versioned name it writes the new build
  # under a new name and unlinks the old one, orphaning every launcher that
  # points at it. The stable name is what keeps in-app updates working.
  dest="$HOME/.local/share/husk/Husk.AppImage"
  bindir="$HOME/.local/bin"
  mkdir -p "$(dirname "$dest")" "$bindir"
  install -m 0755 "$TMP/$name" "$dest"
  ln -sf "$dest" "$bindir/husk"

  # Register a launcher, so the AppImage is reachable from the applications menu
  # and not only from the shell.
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

  # AppImages need libfuse2 specifically. Probe for the library rather than the
  # fusermount binary, since a system can ship fusermount3 (libfuse3) without it.
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

  # Take the whole /Volumes/... path rather than a whitespace-delimited field,
  # so a volume name containing a space still resolves to the full mount point.
  mnt="$(hdiutil attach -nobrowse -readonly "$TMP/$name" | grep -o '/Volumes/.*' | tail -n1)"
  [ -n "$mnt" ] || die "could not mount ${name}"
  # shellcheck disable=SC2064
  trap "hdiutil detach -quiet '$mnt' >/dev/null 2>&1 || true; cleanup" EXIT

  app="$(find "$mnt" -maxdepth 1 -name '*.app' | head -n1)"
  [ -n "$app" ] || die "no .app inside the dmg"

  # /Applications is not writable for non-admin or managed accounts, so fall back
  # to the per-user Applications folder.
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

  # The build is not notarized, so Gatekeeper quarantines it on download and
  # refuses to open it. Clear the flag, which is safe here because the bytes were
  # checksum-verified above.
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
      # Only x86_64 Linux builds are published. Stop early on anything else rather
      # than installing a binary the machine cannot execute.
      case "$arch" in
        x86_64|amd64) : ;;
        *) die "Husk has no ${arch} Linux build yet (x86_64 only). Watch ${RELEASES} for arm64, or build from source: https://github.com/${OWNER}/${REPO}" ;;
      esac

      # WSL reports a Linux kernel, but the desktop belongs to Windows, so the
      # Windows build is the one that can render a window.
      if grep -qi microsoft /proc/version 2>/dev/null; then
        warn "This looks like WSL. Husk is a desktop app, so install the Windows build instead."
        warn "In PowerShell, run:  irm ${PAGES}/install.ps1 | iex"
        die "aborting the WSL install"
      fi

      # The Linux binaries are glibc-linked and cannot run against musl.
      if [ -f /etc/alpine-release ]; then
        die "Husk's Linux builds are glibc-only and cannot run on musl (Alpine). Use a glibc distro, or run Husk inside a distrobox/container."
      fi

      # System package managers need root. Without it, use the AppImage, which
      # installs entirely inside $HOME.
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
