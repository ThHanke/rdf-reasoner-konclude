#!/usr/bin/env bash
# apply-patches.sh — Apply all patches in patches/ to vendor/konclude/
# Idempotent: skips patches that are already applied.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/konclude"
PATCHES_DIR="${REPO_ROOT}/patches"

# Ensure the submodule is populated
git -C "${REPO_ROOT}" submodule update --init

if [ ! -d "${VENDOR_DIR}" ]; then
    echo "ERROR: vendor/konclude directory not found after submodule update." >&2
    exit 1
fi

# Validate patches directory exists
if [ ! -d "${PATCHES_DIR}" ]; then
    echo "PATCHES_DIR not found: ${PATCHES_DIR}"
    exit 0
fi

# Collect sorted patch files
mapfile -t PATCHES < <(find "${PATCHES_DIR}" -maxdepth 1 -name '*.patch' | sort)

if [ "${#PATCHES[@]}" -eq 0 ]; then
    echo "No patches to apply."
    exit 0
fi

for PATCH in "${PATCHES[@]}"; do
    PATCH_NAME="$(basename "${PATCH}")"
    # Check if already applied
    if git -C "${VENDOR_DIR}" apply --check --reverse "${PATCH}" 2>/dev/null; then
        echo "SKIP: ${PATCH_NAME} (already applied)"
        continue
    fi
    # Check if it can be applied cleanly
    if git -C "${VENDOR_DIR}" apply --check "${PATCH}" 2>/dev/null; then
        if ! git -C "${VENDOR_DIR}" apply "${PATCH}" 2>/tmp/apply_error.log; then
            echo "ERROR: ${PATCH_NAME} failed to apply (check succeeded but apply failed)." >&2
            cat /tmp/apply_error.log >&2
            exit 1
        fi
        echo "APPLIED: ${PATCH_NAME}"
    else
        echo "ERROR: ${PATCH_NAME} malformed or cannot be applied cleanly." >&2
        echo "SUGGEST: Try 'git apply --reject ${PATCH}' to investigate." >&2
        exit 1
    fi
done

echo "Done."
