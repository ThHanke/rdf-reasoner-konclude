#!/usr/bin/env bash
# scripts/generate-patches.sh
#
# Unit 3: Scan retained Konclude kernel sources, remove Qt container #include
# lines, add #include "QtCompat.h", generate a unified diff as
# patches/001-qt-compat-header.patch, then restore vendor/konclude/ to its
# original state so the submodule stays clean.
#
# Usage: run from the repository root (phase-1 worktree).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KONCLUDE_DIR="$REPO_ROOT/vendor/konclude"
SOURCE_DIR="$KONCLUDE_DIR/Source"
PATCHES_DIR="$REPO_ROOT/patches"

# ---------------------------------------------------------------------------
# Qt container headers we want to remove from retained sources
# ---------------------------------------------------------------------------
QT_CONTAINER_HEADERS=(
    "QHash"
    "QList"
    "QSet"
    "QStack"
    "QString"
    "QStringList"
    "QLinkedList"
    "QLatin1String"
    "QPair"
    "QVector"
    "QMap"
)

# Build grep pattern for detection
GREP_PATTERN=$(printf '#include <%s>\n' "${QT_CONTAINER_HEADERS[@]}" | paste -sd '|' -)

# ---------------------------------------------------------------------------
# Collect retained source files (mirrors CMakeLists.txt source list)
# ---------------------------------------------------------------------------
mapfile -t RETAINED_FILES < <(
    grep -rl \
        --include='*.h' --include='*.cpp' \
        -e '#include <QHash>' \
        -e '#include <QList>' \
        -e '#include <QSet>' \
        -e '#include <QStack>' \
        -e '#include <QString>' \
        -e '#include <QStringList>' \
        -e '#include <QLinkedList>' \
        -e '#include <QLatin1String>' \
        -e '#include <QPair>' \
        -e '#include <QVector>' \
        -e '#include <QMap>' \
        "$SOURCE_DIR/Reasoner/Kernel/" \
        "$SOURCE_DIR/Reasoner/Preprocess/" \
        "$SOURCE_DIR/Reasoner/Consistiser/" \
        "$SOURCE_DIR/Reasoner/Classifier/" \
        "$SOURCE_DIR/Reasoner/Ontology/" \
        "$SOURCE_DIR/Scheduler/" \
        "$SOURCE_DIR/Concurrent/" \
        2>/dev/null
    # Individual files from Triples and Generator
    for f in \
        "$SOURCE_DIR/Reasoner/Triples/CRedlandStoredTriplesData.h" \
        "$SOURCE_DIR/Reasoner/Triples/CRedlandStoredTriplesData.cpp" \
        "$SOURCE_DIR/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.h" \
        "$SOURCE_DIR/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp"; do
        if [[ -f "$f" ]]; then
            if grep -q \
                -e '#include <QHash>' \
                -e '#include <QList>' \
                -e '#include <QSet>' \
                -e '#include <QStack>' \
                -e '#include <QString>' \
                -e '#include <QStringList>' \
                -e '#include <QLinkedList>' \
                -e '#include <QLatin1String>' \
                -e '#include <QPair>' \
                -e '#include <QVector>' \
                -e '#include <QMap>' \
                "$f" 2>/dev/null; then
                echo "$f"
            fi
        fi
    done
)

echo "Found ${#RETAINED_FILES[@]} files to patch."

# ---------------------------------------------------------------------------
# Helper: modify a single file
#   - Remove Qt container #include lines
#   - Insert #include "QtCompat.h" before the first remaining #include line
# ---------------------------------------------------------------------------
patch_file() {
    local file="$1"
    local tmpfile
    tmpfile="$(mktemp)"

    # Track whether we've already inserted the QtCompat.h include
    local inserted=0
    local first_include_seen=0

    while IFS= read -r line || [[ -n "$line" ]]; do
        # Strip trailing CR (handle CRLF line endings)
        local stripped_line="${line%$'\r'}"

        # Check if this is a Qt container include to remove
        local is_qt_container=0
        for qt_hdr in "${QT_CONTAINER_HEADERS[@]}"; do
            if [[ "$stripped_line" == "#include <${qt_hdr}>" ]]; then
                is_qt_container=1
                break
            fi
        done

        if [[ "$is_qt_container" -eq 1 ]]; then
            # Insert QtCompat.h before the first removed Qt container include
            # (only once, and only if we haven't already)
            if [[ "$inserted" -eq 0 ]]; then
                echo '#include "QtCompat.h"' >> "$tmpfile"
                inserted=1
            fi
            # Skip (remove) the Qt container include line
            continue
        fi

        echo "$line" >> "$tmpfile"
    done < "$file"

    mv "$tmpfile" "$file"
}

# ---------------------------------------------------------------------------
# Apply patches to all retained files
# ---------------------------------------------------------------------------
for f in "${RETAINED_FILES[@]}"; do
    patch_file "$f"
done

echo "Applied QtCompat.h substitution to ${#RETAINED_FILES[@]} files."

# ---------------------------------------------------------------------------
# Generate unified diff
# ---------------------------------------------------------------------------
mkdir -p "$PATCHES_DIR"
(
    cd "$KONCLUDE_DIR"
    git diff > "$PATCHES_DIR/001-qt-compat-header.patch"
)

PATCH_LINES=$(wc -l < "$PATCHES_DIR/001-qt-compat-header.patch")
echo "Generated $PATCHES_DIR/001-qt-compat-header.patch ($PATCH_LINES lines)."

# ---------------------------------------------------------------------------
# Restore vendor/konclude/ to clean state
# ---------------------------------------------------------------------------
(
    cd "$KONCLUDE_DIR"
    git checkout -- .
)

echo "Restored vendor/konclude/ to clean state."
echo "Done."
