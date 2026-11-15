#!/bin/bash
set -euo pipefail

# Usage: build-notifier-macos.sh <output-directory> <arm64|amd64>
# Output: <output-directory>/AliceRealm Notifications.app
if [[ $# != 2 || "$(uname -s)" != Darwin ]]; then
  echo 'usage (on macOS): build-notifier-macos.sh <output-directory> <arm64|amd64>' >&2
  exit 1
fi
case "$2" in
  arm64) architecture=arm64 ;;
  amd64) architecture=x86_64 ;;
  *) echo 'unsupported macOS architecture' >&2; exit 1 ;;
esac
script_dir="$(cd "$(dirname "$0")" && pwd)"
source_dir="$script_dir/../internal/desktopnotify/macos"
if [[ -z "${ALICEREALM_NOTIFIER_VERSION:-}" ]]; then
  source "$script_dir/../.cli.config"
  ALICEREALM_NOTIFIER_VERSION="$NOTIFIER_VERSION"
fi
if [[ ! "$ALICEREALM_NOTIFIER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Notification helper version must be a stable semantic version.' >&2
  exit 1
fi
output_dir="$1/AliceRealm Notifications.app"
mkdir -p "$output_dir/Contents/MacOS" "$output_dir/Contents/Resources"
cp "$source_dir/Info.plist" "$output_dir/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $ALICEREALM_NOTIFIER_VERSION" "$output_dir/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $ALICEREALM_NOTIFIER_VERSION" "$output_dir/Contents/Info.plist"
icon_work="$(mktemp -d "${TMPDIR:-/tmp}/alicerealm-icon.XXXXXX")"
trap 'rm -rf "$icon_work"' EXIT
mkdir "$icon_work/AliceRealm.iconset"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$source_dir/Icon.png" \
    --out "$icon_work/AliceRealm.iconset/icon_${size}x${size}.png" >/dev/null
  /usr/bin/sips -z "$((size * 2))" "$((size * 2))" "$source_dir/Icon.png" \
    --out "$icon_work/AliceRealm.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$icon_work/AliceRealm.iconset" \
  -o "$output_dir/Contents/Resources/AliceRealm.icns"
/usr/bin/xcrun swiftc -O -target "$architecture-apple-macosx11.0" \
  -module-cache-path "${TMPDIR:-/tmp}/alicerealm-swift-module-cache" \
  -framework AppKit -framework UserNotifications \
  "$source_dir/main.swift" -o "$output_dir/Contents/MacOS/AliceRealmNotifications"
# Ad-hoc signing is for locally built test bundles. Release builds provide a
# Developer ID identity and notarize the containing distributable separately.
signing_args=(--force --options runtime --sign "${ALICEREALM_NOTIFIER_SIGN_IDENTITY:--}")
if [[ "${ALICEREALM_NOTIFIER_SIGN_IDENTITY:--}" != - ]]; then
  signing_args+=(--timestamp)
fi
/usr/bin/codesign "${signing_args[@]}" "$output_dir"
/usr/bin/codesign --verify --deep --strict "$output_dir"
printf '%s\n' "$output_dir"
