#!/usr/bin/env bash
# Downloads the pre-built Linux Konclude binary from GitHub Releases.
# Run once per developer machine; binary is gitignored.
# Usage: bash scripts/acquire-native-konclude.sh

set -euo pipefail

RELEASE_VERSION="v0.7.0-1138"
ASSET_NAME="Konclude-${RELEASE_VERSION}-Linux-x64-GCC-Static-Qt5.12.10"
DOWNLOAD_URL="https://github.com/konclude/Konclude/releases/download/${RELEASE_VERSION}/${ASSET_NAME}.zip"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARIES_DIR="${REPO_ROOT}/vendor/konclude/Binaries"
TARGET="${BINARIES_DIR}/Konclude"

mkdir -p "${BINARIES_DIR}"

if [[ -x "${TARGET}" ]]; then
  echo "Konclude binary already present at ${TARGET}"
  "${TARGET}" --version 2>&1 | head -3 || true
  exit 0
fi

TMP_ZIP="$(mktemp /tmp/konclude-XXXXXX.zip)"
trap 'rm -f "${TMP_ZIP}"' EXIT

echo "Downloading Konclude ${RELEASE_VERSION} ..."
curl -fL --progress-bar "${DOWNLOAD_URL}" -o "${TMP_ZIP}"

echo "Extracting ..."
unzip -p "${TMP_ZIP}" "${ASSET_NAME}/Binaries/Konclude" > "${TARGET}"
chmod +x "${TARGET}"

echo "Installed: ${TARGET}"
"${TARGET}" --version 2>&1 | head -3 || true
echo "Done."
