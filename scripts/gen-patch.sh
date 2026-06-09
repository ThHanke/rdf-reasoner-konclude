#!/usr/bin/env bash
# scripts/gen-patch.sh — Generate an incremental patch for a single vendor file.
#
# Usage (from repo root):
#   scripts/gen-patch.sh <patch-name> <before-file> <vendor-relative-path>
#
# <patch-name>          Output file: patches/<patch-name>.patch
# <before-file>         Path to the file BEFORE your edit (save it before editing)
# <vendor-relative-path> Path relative to vendor/konclude/,
#                        e.g. Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp
#
# Workflow:
#   1. Apply all prior patches:  bash scripts/apply-patches.sh  (or ensure sentinel exists)
#   2. Save before state:        cp vendor/konclude/Source/.../file.cpp /tmp/before.cpp
#   3. Edit the vendor file
#   4. Generate patch:           bash scripts/gen-patch.sh NNN-name /tmp/before.cpp Source/.../file.cpp
#   5. Restore vendor file:      git -C vendor/konclude checkout -- Source/.../file.cpp
#   6. Verify patch applies:     bash scripts/apply-patches.sh  (after rm vendor/konclude/.patches-applied)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/patches"
VENDOR_DIR="${REPO_ROOT}/vendor/konclude"

PATCH_NAME="${1:-}"
BEFORE_FILE="${2:-}"
VENDOR_REL_PATH="${3:-}"

if [[ -z "${PATCH_NAME}" || -z "${BEFORE_FILE}" || -z "${VENDOR_REL_PATH}" ]]; then
    echo "Usage: $0 <patch-name> <before-file> <vendor-relative-path>" >&2
    echo "  patch-name:          e.g. 040-my-fix  (no .patch extension)" >&2
    echo "  before-file:         e.g. /tmp/before.cpp" >&2
    echo "  vendor-relative-path: e.g. Source/Reasoner/Consistiser/CTotallyPrecomputationThread.cpp" >&2
    exit 1
fi

AFTER_FILE="${VENDOR_DIR}/${VENDOR_REL_PATH}"
OUTPUT="${PATCHES_DIR}/${PATCH_NAME}.patch"

if [[ ! -f "${BEFORE_FILE}" ]]; then
    echo "ERROR: before-file not found: ${BEFORE_FILE}" >&2
    exit 1
fi
if [[ ! -f "${AFTER_FILE}" ]]; then
    echo "ERROR: after-file not found: ${AFTER_FILE}" >&2
    exit 1
fi

# Generate unified diff; diff exits 1 when files differ (expected)
diff -u "${BEFORE_FILE}" "${AFTER_FILE}" > "${OUTPUT}" || true

if [[ ! -s "${OUTPUT}" ]]; then
    echo "ERROR: no diff produced (files identical?)" >&2
    rm -f "${OUTPUT}"
    exit 1
fi

# Fix path headers: replace filesystem paths with a/... b/... vendor-relative paths
sed -i \
    -e "s|^--- ${BEFORE_FILE}|--- a/${VENDOR_REL_PATH}|" \
    -e "s|^+++ ${AFTER_FILE}|+++ b/${VENDOR_REL_PATH}|" \
    "${OUTPUT}"

echo "Generated: ${OUTPUT}  ($(wc -l < "${OUTPUT}") lines)"
echo ""
echo "Next steps:"
echo "  1. git -C vendor/konclude checkout -- ${VENDOR_REL_PATH}   # restore vendor"
echo "  2. rm vendor/konclude/.patches-applied"
echo "  3. bash scripts/apply-patches.sh                            # verify applies"
