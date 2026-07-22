#!/bin/bash
# LifeOS Pulse Menu Bar — Build Script
# Compiles PulseMenuBar.swift into a macOS .app bundle

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="LifeOS Pulse"
BINARY_NAME="LifeOS Pulse"
SWIFT_FILE="$SCRIPT_DIR/PulseMenuBar.swift"
BUILD_DIR="$SCRIPT_DIR/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"

echo "Building $APP_NAME..."

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Compile Swift
swiftc \
    -o "$BUILD_DIR/$BINARY_NAME" \
    "$SWIFT_FILE" \
    -framework AppKit \
    -framework Foundation \
    -O \
    -whole-module-optimization

echo "Compiled binary."

# Create .app bundle structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Move binary into bundle
mv "$BUILD_DIR/$BINARY_NAME" "$APP_BUNDLE/Contents/MacOS/$BINARY_NAME"

# Write Info.plist
cat > "$APP_BUNDLE/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>LifeOS Pulse</string>
    <key>CFBundleDisplayName</key>
    <string>LifeOS Pulse</string>
    <key>CFBundleIdentifier</key>
    <string>com.lifeos.pulse-menubar</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleExecutable</key>
    <string>LifeOS Pulse</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Copy icon into bundle Resources
cp "$SCRIPT_DIR/icon.png" "$APP_BUNDLE/Contents/Resources/icon.png" 2>/dev/null || true
cp "$SCRIPT_DIR/icon@2x.png" "$APP_BUNDLE/Contents/Resources/icon@2x.png" 2>/dev/null || true

echo "Created $APP_BUNDLE"
echo "Build complete."
