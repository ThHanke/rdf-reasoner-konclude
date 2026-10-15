#!/usr/bin/env bash
# apply-patches.sh — Apply all patches in patches/ to vendor/konclude/
# Idempotent: skips patches that are already applied (sentinel file guards re-runs).
# Called automatically at CMake configure time via execute_process in CMakeLists.txt.
# Can also be run manually: bash scripts/apply-patches.sh
#
# Options:
#   --force   Reset vendor/konclude to clean state first (git checkout -- .),
#             remove the sentinel, then apply all patches from scratch.
#             Use this after adding or modifying patch files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/konclude"
PATCHES_DIR="${REPO_ROOT}/patches"
SENTINEL="${VENDOR_DIR}/.patches-applied"

FORCE=0
for arg in "$@"; do
    if [ "$arg" = "--force" ]; then
        FORCE=1
    fi
done

if [ "${FORCE}" -eq 1 ]; then
    echo "Forcing reset: restoring vendor/konclude to clean state..."
    git -C "${VENDOR_DIR}" checkout -- .
    rm -f "${SENTINEL}"
    echo "Sentinel removed."
fi

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

# ENABLED allowlist: when patches/ENABLED exists, only apply patches listed there.
# Each line in ENABLED is a patch basename prefix (e.g. "028" or "028-atomic-stpu-tags").
# Lines starting with # are ignored. Misspelled names produce a warning.
ENABLED_FILE="${PATCHES_DIR}/ENABLED"
declare -A ENABLED_SET=()
USE_ENABLED=0
if [ -f "${ENABLED_FILE}" ]; then
    USE_ENABLED=1
    while IFS= read -r line; do
        # Strip comments and whitespace
        line="${line%%#*}"
        line="${line//[[:space:]]/}"
        [ -z "${line}" ] && continue
        ENABLED_SET["${line}"]=1
    done < "${ENABLED_FILE}"
    echo "ENABLED allowlist active: ${#ENABLED_SET[@]} entries."
fi

# Collect sorted patch files.
mapfile -t PATCHES < <(find "${PATCHES_DIR}" -maxdepth 1 -name '*.patch' | sort)

if [ "${#PATCHES[@]}" -eq 0 ]; then
    echo "No patches to apply."
    touch "${SENTINEL}"
    exit 0
fi

APPLIED_COUNT=0
for PATCH in "${PATCHES[@]}"; do
    PATCH_NAME="$(basename "${PATCH}")"
    PATCH_BASE="${PATCH_NAME%.patch}"

    # ENABLED allowlist filter
    if [ "${USE_ENABLED}" -eq 1 ]; then
        MATCHED=0
        for KEY in "${!ENABLED_SET[@]}"; do
            if [[ "${PATCH_BASE}" == "${KEY}"* || "${PATCH_BASE}" == *"${KEY}"* ]]; then
                MATCHED=1
                break
            fi
        done
        if [ "${MATCHED}" -eq 0 ]; then
            echo "SKIP: ${PATCH_NAME} (not in ENABLED)"
            continue
        fi
    fi

    # Check if already applied.
    if git -C "${VENDOR_DIR}" apply --check --reverse --ignore-whitespace "${PATCH}" 2>/dev/null; then
        echo "SKIP: ${PATCH_NAME} (already applied)"
        APPLIED_COUNT=$((APPLIED_COUNT + 1))
        continue
    fi
    # Check if it applies cleanly.
    if git -C "${VENDOR_DIR}" apply --check --ignore-whitespace "${PATCH}" 2>/dev/null; then
        if ! git -C "${VENDOR_DIR}" apply --ignore-whitespace "${PATCH}" 2>/tmp/apply_error.log; then
            echo "ERROR: ${PATCH_NAME} failed to apply." >&2
            cat /tmp/apply_error.log >&2
            exit 1
        fi
        echo "APPLIED: ${PATCH_NAME}"
        APPLIED_COUNT=$((APPLIED_COUNT + 1))
    else
        echo "ERROR: ${PATCH_NAME} cannot be applied cleanly." >&2
        echo "SUGGEST: Try 'git -C vendor/konclude apply --reject ${PATCH}' to investigate." >&2
        exit 1
    fi
done

# Warn about ENABLED entries that matched no patch file
if [ "${USE_ENABLED}" -eq 1 ]; then
    for KEY in "${!ENABLED_SET[@]}"; do
        FOUND=0
        for PATCH in "${PATCHES[@]}"; do
            PATCH_BASE="$(basename "${PATCH}" .patch)"
            if [[ "${PATCH_BASE}" == "${KEY}"* || "${PATCH_BASE}" == *"${KEY}"* ]]; then
                FOUND=1; break
            fi
        done
        if [ "${FOUND}" -eq 0 ]; then
            echo "WARN: ENABLED entry '${KEY}' matched no patch file — possible typo." >&2
        fi
    done
    echo "Total patches applied/skipped-as-applied: ${APPLIED_COUNT} of ${#ENABLED_SET[@]} enabled."
fi

touch "${SENTINEL}"
echo "Done."
