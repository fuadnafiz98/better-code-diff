#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_app="$project_dir/release/mac-arm64/Horus.app"
user_applications="${HOME}/Applications"
target_app="$user_applications/Horus.app"
staged_app="$user_applications/.Horus.installing.$$"
backup_app="$user_applications/.Horus.previous.$$"
legacy_app="/Applications/Horus.app"
previous_app="$user_applications/Better Code Diff.app"
trash_dir="${HOME}/.Trash"
bundle_id="com.fuadnafiz.horus"
previous_bundle_id="com.fuadnafiz.bettercodediff"

if [[ ! -d "$source_app" ]]; then
  echo "Missing packaged app: $source_app" >&2
  echo "Run 'bun run dist:mac' first." >&2
  exit 1
fi

source_bundle_id="$(defaults read "$source_app/Contents/Info.plist" CFBundleIdentifier)"
if [[ "$source_bundle_id" != "$bundle_id" ]]; then
  echo "Unexpected bundle identifier: $source_bundle_id" >&2
  exit 1
fi

cleanup() {
  if [[ -d "$staged_app" ]]; then
    mv "$staged_app" "$trash_dir/Horus incomplete install.$$"
  fi

  if [[ -d "$backup_app" && ! -d "$target_app" ]]; then
    mv "$backup_app" "$target_app"
  fi
}
trap cleanup EXIT

mkdir -p "$user_applications" "$trash_dir"

pkill -x "Horus" 2>/dev/null || true
pkill -x "Horus Helper" 2>/dev/null || true
pkill -x "Horus Helper (Renderer)" 2>/dev/null || true
pkill -x "Better Code Diff" 2>/dev/null || true
pkill -x "Better Code Diff Helper" 2>/dev/null || true
pkill -x "Better Code Diff Helper (Renderer)" 2>/dev/null || true

ditto "$source_app" "$staged_app"

# electron-builder with CSC_IDENTITY_AUTO_DISCOVERY=false leaves the stock
# Electron linker signature (Identifier=Electron, no sealed resources). Launch
# Services then fails Gatekeeper's first check on a 300 MB bundle — that is the
# long dock bounce when Raycast opens a just-replaced build.
codesign --force --deep --sign - "$staged_app"

staged_bundle_id="$(defaults read "$staged_app/Contents/Info.plist" CFBundleIdentifier)"
if [[ "$staged_bundle_id" != "$bundle_id" ]]; then
  echo "Staged app failed bundle validation." >&2
  exit 1
fi

if [[ -d "$target_app" ]]; then
  mv "$target_app" "$backup_app"
fi

mv "$staged_app" "$target_app"

if [[ -d "$backup_app" ]]; then
  mv "$backup_app" "$trash_dir/Horus previous.$$"
fi

if [[ -d "$legacy_app" ]]; then
  legacy_bundle_id="$(defaults read "$legacy_app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
  if [[ "$legacy_bundle_id" == "$bundle_id" ]]; then
  mv "$legacy_app" "$trash_dir/Horus legacy.$$"
  fi
fi

if [[ -d "$previous_app" ]]; then
  installed_bundle_id="$(defaults read "$previous_app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
  if [[ "$installed_bundle_id" == "$previous_bundle_id" ]]; then
    mv "$previous_app" "$trash_dir/Better Code Diff replaced by Horus.$$"
  fi
fi

mv "$source_app" "$trash_dir/Horus build.$$"

trap - EXIT

version="$(defaults read "$target_app/Contents/Info.plist" CFBundleShortVersionString)"
echo "Installed Horus $version in $target_app."
