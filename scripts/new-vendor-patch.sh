#!/usr/bin/env bash
# scripts/new-vendor-patch.sh — Create a new vendor patch from a Python modification script.
#
# Usage:
#   bash scripts/new-vendor-patch.sh <patch-number> <vendor-relative-path> <python-script>
#
# Arguments:
#   <patch-number>        Three-digit patch number, e.g. 042
#   <vendor-relative-path>  Path inside vendor/konclude, e.g.
#                          Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp
#   <python-script>       Python script that reads from stdin (original file) and
#                         writes the modified content to stdout.  Receives no args.
#                         If omitted, opens the file in $EDITOR for manual editing.
#
# The script:
#   1. Extracts the CLEAN version of the vendor file (git show HEAD:path)
#   2. Applies <python-script> (or editor) to produce the modified version
#   3. Generates a unified diff and saves it as patches/<patch-number>-*.patch
#   4. Validates the patch applies cleanly against the current vendor state
#
# The generated patch name will prompt the user for a short description.
#
# Example:
#   bash scripts/new-vendor-patch.sh 042 \
#     Source/Reasoner/Consistiser/CPrecomputationThread.cpp \
#     scripts/mods/add-yield.py
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/konclude"
PATCHES_DIR="${REPO_ROOT}/patches"

if [ $# -lt 2 ]; then
    echo "Usage: $0 <patch-number> <vendor-relative-path> [python-script]" >&2
    exit 1
fi

PATCH_NUM="$1"
VENDOR_PATH="$2"
PYTHON_SCRIPT="${3:-}"

# Validate patch number format
if ! [[ "$PATCH_NUM" =~ ^[0-9]{3}$ ]]; then
    echo "ERROR: patch-number must be exactly 3 digits, e.g. 042" >&2
    exit 1
fi

# Check vendor path exists in git
if ! git -C "${VENDOR_DIR}" show "HEAD:${VENDOR_PATH}" > /dev/null 2>&1; then
    echo "ERROR: '${VENDOR_PATH}' not found in vendor/konclude HEAD" >&2
    exit 1
fi

# Extract clean version
ORIG_TMP="$(mktemp --suffix=".orig.cpp")"
MOD_TMP="$(mktemp --suffix=".mod.cpp")"
trap 'rm -f "${ORIG_TMP}" "${MOD_TMP}"' EXIT

git -C "${VENDOR_DIR}" show "HEAD:${VENDOR_PATH}" > "${ORIG_TMP}"
cp "${ORIG_TMP}" "${MOD_TMP}"

# Apply modifications
if [ -n "${PYTHON_SCRIPT}" ]; then
    if [ ! -f "${PYTHON_SCRIPT}" ]; then
        echo "ERROR: python script not found: ${PYTHON_SCRIPT}" >&2
        exit 1
    fi
    python3 "${PYTHON_SCRIPT}" < "${ORIG_TMP}" > "${MOD_TMP}"
else
    EDITOR="${EDITOR:-vi}"
    echo "Opening ${VENDOR_PATH##*/} in ${EDITOR} — save and exit to generate patch."
    "${EDITOR}" "${MOD_TMP}"
fi

# Check if anything changed
if diff -q "${ORIG_TMP}" "${MOD_TMP}" > /dev/null 2>&1; then
    echo "No changes detected. Exiting without creating a patch."
    exit 0
fi

# Prompt for description
read -r -p "Short patch description (hyphen-separated, e.g. add-yield-after-calcjob): " DESC
if [ -z "${DESC}" ]; then
    DESC="vendor-change"
fi
PATCH_FILE="${PATCHES_DIR}/${PATCH_NUM}-${DESC}.patch"

# Generate unified diff with vendor-relative paths
diff -u "${ORIG_TMP}" "${MOD_TMP}" \
    | sed \
        -e "s|^--- ${ORIG_TMP}.*|--- a/${VENDOR_PATH}|" \
        -e "s|^+++ ${MOD_TMP}.*|+++ b/${VENDOR_PATH}|" \
    > "${PATCH_FILE}"

echo "Generated: ${PATCH_FILE}"

# Validate it applies cleanly (against current HEAD, which may already have earlier patches)
if git -C "${VENDOR_DIR}" apply --check --ignore-whitespace "${PATCH_FILE}" 2>/dev/null; then
    echo "Patch validates cleanly against vendor/konclude HEAD."
else
    echo "WARNING: Patch does not apply cleanly against clean vendor HEAD." >&2
    echo "This is expected if earlier patches must be applied first." >&2
    echo "Run 'bash scripts/apply-patches.sh --force' to test the full chain." >&2
fi

echo "Done. Next steps:"
echo "  1. Review: cat '${PATCH_FILE}'"
echo "  2. Test full chain: bash scripts/apply-patches.sh --force"
echo "  3. Run: npm run patch-wasm && npm test"
echo "  4. Commit: git add patches/ && git commit"
