"""
Patch 012 — realizer cleanup after triple extraction.

Adds CRealizerThread::clearRealizingItems() which deletes all COntologyRealizingItem
objects stored in mOntItemHash and clears the hash.  Called from KoncludeReasoner.cpp
at the end of buildInferredTripleBuffer() once all role/individual instance data has
been read into the result buffer and is no longer needed.

This ensures each materialize call starts with a completely clean slate — no residual
isInitializing flags, no stale candidate lists, no old iterator state — regardless of
what happened in earlier calls.
"""
import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Realizer/CRealizerThread.h",
    "Source/Reasoner/Realizer/CRealizerThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)


# ── CRealizerThread.h ─────────────────────────────────────────────────────────
# Add clearRealizingItems() declaration to the public interface, after
# callbackRealized (last public virtual method).

_H_OLD = """\t\t\t\t\tvirtual bool callbackRealized(CConcreteOntology* ontology, CCallbackData* callback);

\t\t\t\t\tvirtual CRealizationMessageObserver* tellRealizationMessage"""

_H_NEW = """\t\t\t\t\tvirtual bool callbackRealized(CConcreteOntology* ontology, CCallbackData* callback);

\t\t\t\t\t// Free all COntologyRealizingItem objects in mOntItemHash.  Safe to call
\t\t\t\t\t// after pthread_join (thread stopped) once triples have been extracted.
\t\t\t\t\tvirtual void clearRealizingItems();

\t\t\t\t\tvirtual CRealizationMessageObserver* tellRealizationMessage"""

# ── CRealizerThread.cpp ───────────────────────────────────────────────────────
# Implement clearRealizingItems() right after the destructor.

_CPP_OLD = """\t\t\tCRealizerThread::~CRealizerThread() {
\t\t\t\tstopThread();
\t\t\t}"""

_CPP_NEW = """\t\t\tCRealizerThread::~CRealizerThread() {
\t\t\t\tstopThread();
\t\t\t\tclearRealizingItems();
\t\t\t}

\t\t\tvoid CRealizerThread::clearRealizingItems() {
\t\t\t\tfor (auto it = mOntItemHash.begin(); it != mOntItemHash.end(); ++it) {
\t\t\t\t\tdelete it.value();
\t\t\t\t}
\t\t\t\tmOntItemHash.clear();
\t\t\t}"""


def modify(path, content):
    if path.endswith("CRealizerThread.h"):
        assert _H_OLD in content, "H anchor not found — check indentation"
        return content.replace(_H_OLD, _H_NEW, 1)
    if path.endswith("CRealizerThread.cpp"):
        assert _CPP_OLD in content, "CPP anchor not found — check indentation"
        return content.replace(_CPP_OLD, _CPP_NEW, 1)
    return content


if __name__ == "__main__":
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        full_path = vendor_dir / rel_path
        content = full_path.read_text(encoding="utf-8")
        modified = modify(str(full_path), content)
        if modified != content:
            full_path.write_text(modified, encoding="utf-8")
