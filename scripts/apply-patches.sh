#!/usr/bin/env bash
# apply-patches.sh — Apply all patches in patches/ to vendor/konclude/
# Idempotent: skips patches that are already applied.
#
# Host workflow (git available):
#   Run this script directly; uses `git apply` which handles git-generated patches.
#   Creates vendor/konclude/.patches-applied sentinel when done.
#
# Docker workflow (git context unavailable):
#   Mount the worktree at /src. The sentinel file from the host run is visible.
#   The script exits early if the sentinel exists, skipping all patching.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/konclude"
PATCHES_DIR="${REPO_ROOT}/patches"
SENTINEL="${VENDOR_DIR}/.patches-applied"

# Fast path: patches already applied (sentinel present).
if [ -f "${SENTINEL}" ]; then
    echo "Patches already applied (sentinel found), skipping."
    exit 0
fi

# Ensure the submodule is populated.
if [ ! -f "${VENDOR_DIR}/Konclude.pro" ]; then
    echo "Populating vendor/konclude submodule..."
    git -C "${REPO_ROOT}" submodule update --init
fi

if [ ! -d "${VENDOR_DIR}" ]; then
    echo "ERROR: vendor/konclude directory not found." >&2
    exit 1
fi

# Validate patches directory exists.
if [ ! -d "${PATCHES_DIR}" ]; then
    echo "PATCHES_DIR not found: ${PATCHES_DIR}"
    touch "${SENTINEL}"
    exit 0
fi

# Collect sorted patch files.
mapfile -t PATCHES < <(find "${PATCHES_DIR}" -maxdepth 1 -name '*.patch' | sort)

if [ "${#PATCHES[@]}" -eq 0 ]; then
    echo "No patches to apply."
    touch "${SENTINEL}"
    exit 0
fi

for PATCH in "${PATCHES[@]}"; do
    PATCH_NAME="$(basename "${PATCH}")"
    # Check if already applied.
    if git -C "${VENDOR_DIR}" apply --check --reverse "${PATCH}" 2>/dev/null; then
        echo "SKIP: ${PATCH_NAME} (already applied)"
        continue
    fi
    # Check if it applies cleanly.
    if git -C "${VENDOR_DIR}" apply --check "${PATCH}" 2>/dev/null; then
        if ! git -C "${VENDOR_DIR}" apply "${PATCH}" 2>/tmp/apply_error.log; then
            echo "ERROR: ${PATCH_NAME} failed to apply." >&2
            cat /tmp/apply_error.log >&2
            exit 1
        fi
        echo "APPLIED: ${PATCH_NAME}"
    else
        echo "ERROR: ${PATCH_NAME} cannot be applied cleanly." >&2
        echo "SUGGEST: Try 'git -C vendor/konclude apply --reject ${PATCH}' to investigate." >&2
        exit 1
    fi
done

touch "${SENTINEL}"
echo "Done."
