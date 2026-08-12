#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_icon="$project_dir/build/icon-source.png"
rendered_icon="$project_dir/build/icon.png"
iconset_dir="$project_dir/build/icon.iconset"

if [[ ! -f "$source_icon" ]]; then
  echo "Missing source artwork: $source_icon" >&2
  exit 1
fi

mkdir -p "$project_dir/build"
rm -rf "$iconset_dir"
mkdir -p "$iconset_dir"

xcrun swift "$project_dir/scripts/render-macos-icon.swift" "$source_icon" "$rendered_icon"

for size in 16 32 128 256 512; do
  double_size=$((size * 2))
  sips -z "$size" "$size" "$rendered_icon" --out "$iconset_dir/icon_${size}x${size}.png" >/dev/null
  sips -z "$double_size" "$double_size" "$rendered_icon" --out "$iconset_dir/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil --convert icns --output "$project_dir/build/icon.icns" "$iconset_dir"
rm -rf "$iconset_dir"

echo "Created build/icon.png and build/icon.icns"
