#!/usr/bin/env bash
# build-upstream.sh — build PRISTINE upstream Konclude (real Qt, none of our patches/shims) as the
# determinism / correctness oracle. Output: $DEST/b/Debug/Konclude (default DEST=~/konclude-orig).
#
# Needs: Qt5 dev (qmake, qtbase5-dev; xml+network+concurrent), librdf/raptor2/rasqal dev, ~4 GB free
# while building (~800 MB after: delete $DEST/b/release object files, keep the binary).
#
# Only the build files are adapted, never the sources:
#   - source = `git archive HEAD` of vendor/konclude (the pinned submodule commit, patches not applied)
#   - Konclude.pri uses Windows path separators (`\Source\X`) that qmake on Linux does not resolve
#     (no moc output -> link errors); convert them to `/`
#   - bundled static libs/jemalloc are absent from the archive: link system librdf/rasqal/raptor2
#   - sources include <Redland.h>; system header is redland.h -> shim dir with a symlink
#   - debug flags comparable to our native harness: -g3 -O1 -fno-omit-frame-pointer
# Usage: scripts/oracle/build-upstream.sh [DEST]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-$HOME/konclude-orig}"
need_gb=4
free_gb=$(df -BG --output=avail "$(dirname "$DEST")" | tail -1 | tr -dc '0-9')
[ "$free_gb" -ge "$need_gb" ] || { echo "refusing: need ${need_gb} GB free, have ${free_gb} GB" >&2; exit 1; }
command -v qmake >/dev/null || { echo "qmake not found (install qtbase5-dev)" >&2; exit 1; }
[ -x "$DEST/b/Debug/Konclude" ] && { echo "already built: $DEST/b/Debug/Konclude"; exit 0; }

rm -rf "$DEST"; mkdir -p "$DEST"
git -C "$ROOT/vendor/konclude" archive HEAD | tar -x -C "$DEST"
cd "$DEST"
mkdir shim; ln -s /usr/include/redland.h shim/Redland.h
sed -E 's#\\([A-Za-z])#/\1#g' Konclude.pri > Konclude.pri.tmp && mv Konclude.pri.tmp Konclude.pri
python3 - "$DEST" <<'PY'
import sys
dest = sys.argv[1]
s = open('Konclude.pro').read()
s = s.replace("PRE_TARGETDEPS = gitbuild\n", "")
s = s.replace("DESTDIR = ./Release", "DESTDIR = ./Debug").replace("CONFIG += release console", "CONFIG += debug console")
s = s.replace("# QMAKE_CXXFLAGS += -ggdb",
              "QMAKE_CXXFLAGS += -g3 -O1 -fno-omit-frame-pointer -fpermissive\nQMAKE_CXXFLAGS_DEBUG -= -O0")
s = '\n'.join(l for l in s.split('\n') if not l.startswith(('unix: LIBS', 'unix: INCLUDEPATH', 'unix: DEPENDPATH')))
s += ("\nunix: INCLUDEPATH += /usr/include/raptor2 /usr/include/rasqal " + dest + "/shim\n"
      "unix: LIBS += -lrdf -lrasqal -lraptor2 -lz -lltdl -ldl\n")
open('Konclude-debug.pro', 'w').write(s)
PY
mkdir b && cd b && qmake ../Konclude-debug.pro
make -j"$(nproc)"
echo "built: $DEST/b/Debug/Konclude  (you may rm -rf $DEST/b/release to reclaim ~2 GB)"
