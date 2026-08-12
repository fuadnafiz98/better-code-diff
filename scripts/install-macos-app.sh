#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_app="$project_dir/release/mac-arm64/Better Code Diff.app"
target_app="/Applications/Better Code Diff.app"
staged_app="/Applications/.Better Code Diff.installing.$$"
backup_app="/Applications/.Better Code Diff.previous.$$"
bundle_id="com.fuadnafiz.bettercodediff"

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
    rm -rf "$staged_app"
  fi

  if [[ -d "$backup_app" && ! -d "$target_app" ]]; then
    mv "$backup_app" "$target_app"
  fi
}
trap cleanup EXIT

osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 || true

ditto "$source_app" "$staged_app"

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
  rm -rf "$backup_app"
fi

trap - EXIT

version="$(defaults read "$target_app/Contents/Info.plist" CFBundleShortVersionString)"
open "$target_app"
echo "Installed and opened Better Code Diff $version from the latest local build."
