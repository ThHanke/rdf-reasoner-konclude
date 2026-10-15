#!/usr/bin/env bash
# baseline-info.sh — print the exact source/patch state a measurement was taken on.
# One JSON object on stdout. Used by repro-sample.sh so every sample is traceable.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
enabled="$(grep -v '^#' "$ROOT/patches/ENABLED" | sed 's/#.*//; s/[[:space:]]//g' | grep -v '^$' | sort | tr '\n' ',' | sed 's/,$//')"
vendor_hash="$(git -C "$ROOT/vendor/konclude" diff | sha256sum | cut -c1-12)"
src_dirty="$(git -C "$ROOT" status --porcelain -- src native patches | wc -l)"
override_hash="$(cat "$ROOT"/src/compat/overrides/*.cpp "$ROOT"/src/compat/QtCompat.h | sha256sum | cut -c1-12)"
printf '{"commit":"%s","enabled_patches":"%s","vendor_diff":"%s","override_hash":"%s","src_dirty_files":%s}\n' \
  "$(git -C "$ROOT" rev-parse --short HEAD)" "$enabled" "$vendor_hash" "$override_hash" "$src_dirty"
