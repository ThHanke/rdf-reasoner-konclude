#!/usr/bin/env bash
# scripts/new-multi-file-patch.sh — Create a patch spanning multiple vendor files.
#
# Usage:
#   bash scripts/new-multi-file-patch.sh <patch-number> <name> <python-script>
#
# Arguments:
#   <patch-number>   Three-digit patch number, e.g. 020
#   <name>           Patch name slug, e.g. alif-debug-logging
#   <python-script>  Python script that modifies vendor files in-place.
#                    Receives one arg: the vendor/konclude root directory.
#
# Unlike new-vendor-patch.sh (which uses clean git state as base), this script
# diffs against the CURRENT vendor state — which includes all previously applied
# patches. This is the correct approach when your patch builds on earlier patches.
#
# The script:
#   1. Ensures all existing patches are applied (sentinel check)
#   2. Copies current vendor files that will be modified (as .orig)
#   3. Runs the Python script to modify vendor files in-place
#   4. Generates unified diffs for all changed files
#   5. Concatenates into one patch file
#   6. Restores vendor files to pre-modification state
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/konclude"
PATCHES_DIR="${REPO_ROOT}/patches"
SENTINEL="${VENDOR_DIR}/.patches-applied"

if [ $# -lt 3 ]; then
    echo "Usage: $0 <patch-number> <name> <python-script>" >&2
    exit 1
fi

PATCH_NUM="$1"
PATCH_NAME="$2"
PYTHON_SCRIPT="$3"

if ! [[ "$PATCH_NUM" =~ ^[0-9]{3}$ ]]; then
    echo "ERROR: patch-number must be exactly 3 digits" >&2
    exit 1
fi

if [ ! -f "${PYTHON_SCRIPT}" ]; then
    echo "ERROR: python script not found: ${PYTHON_SCRIPT}" >&2
    exit 1
fi

# Ensure patches are applied
if [ ! -f "${SENTINEL}" ]; then
    echo "Applying existing patches first..."
    bash "${SCRIPT_DIR}/apply-patches.sh"
fi

PATCH_FILE="${PATCHES_DIR}/${PATCH_NUM}-${PATCH_NAME}.patch"

# The python script declares which files it will modify via a MODIFIED_FILES list.
# We discover changes by comparing before/after states of ALL vendor files the
# script touches. The python script receives the vendor dir as argv[1] and
# modifies files in-place.

# Step 1: Record checksums of all vendor .cpp and .h files (limited to likely targets)
TRACKING_DIR="$(mktemp -d)"
trap 'rm -rf "${TRACKING_DIR}"' EXIT

# Let the python script declare which files it modifies by printing them to stdout
# before "---" delimiter, then performing modifications.
# Actually simpler: snapshot all files in the Consistiser directory (or wherever),
# then diff after.

# Ask the python script for file list
FILE_LIST="$(python3 "${PYTHON_SCRIPT}" --list-files 2>/dev/null || true)"

if [ -z "${FILE_LIST}" ]; then
    echo "ERROR: python script must support --list-files to declare modified files" >&2
    exit 1
fi

# Step 2: Copy originals
while IFS= read -r rel_path; do
    src="${VENDOR_DIR}/${rel_path}"
    dst="${TRACKING_DIR}/${rel_path}"
    mkdir -p "$(dirname "${dst}")"
    cp "${src}" "${dst}"
done <<< "${FILE_LIST}"

# Step 3: Run the modification script
# Wrap in a function so we can always restore on failure
run_and_diff() {
    python3 "${PYTHON_SCRIPT}" "${VENDOR_DIR}"

    # Step 4: Generate diffs
    > "${PATCH_FILE}"
    while IFS= read -r rel_path; do
        orig="${TRACKING_DIR}/${rel_path}"
        mod="${VENDOR_DIR}/${rel_path}"
        # diff returns 1 when files differ — that's expected, not an error
        local diff_out
        diff_out="$(diff -u "${orig}" "${mod}" || true)"
        if [ -n "${diff_out}" ]; then
            echo "${diff_out}" \
                | sed \
                    -e "s|^--- ${orig}.*|--- a/${rel_path}|" \
                    -e "s|^+++ ${mod}.*|+++ b/${rel_path}|" \
                >> "${PATCH_FILE}"
        fi
    done <<< "${FILE_LIST}"
}

# Always restore vendor files, even on error
restore_vendor() {
    while IFS= read -r rel_path; do
        if [ -f "${TRACKING_DIR}/${rel_path}" ]; then
            cp "${TRACKING_DIR}/${rel_path}" "${VENDOR_DIR}/${rel_path}"
        fi
    done <<< "${FILE_LIST}"
}

if ! run_and_diff; then
    echo "ERROR: modification script failed. Restoring vendor files." >&2
    restore_vendor
    rm -f "${PATCH_FILE}"
    exit 1
fi

# Step 5: Restore vendor files to original state
restore_vendor

if [ ! -s "${PATCH_FILE}" ]; then
    echo "No changes detected. Removing empty patch file."
    rm -f "${PATCH_FILE}"
    exit 0
fi

LINES="$(wc -l < "${PATCH_FILE}")"
echo "Generated: ${PATCH_FILE} (${LINES} lines)"

# Step 6: Validate it applies
if git -C "${VENDOR_DIR}" apply --check --ignore-whitespace "${PATCH_FILE}" 2>/dev/null; then
    echo "Patch validates cleanly against current vendor state."
else
    echo "WARNING: Patch does not apply cleanly." >&2
    echo "The vendor state may have changed. Run 'make reset-patches' first." >&2
fi

echo "Done. Next steps:"
echo "  1. Review: cat '${PATCH_FILE}'"
echo "  2. Apply: make reset-patches"
echo "  3. Build: make build-wasm"
