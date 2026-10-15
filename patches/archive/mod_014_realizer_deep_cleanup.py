"""
Patch 014 — fix mBackendAssocCacheReader leak in realizing item destructor.

COptimizedRepresentativeKPSetOntologyRealizingItem stores a raw pointer
mBackendAssocCacheReader (set via initRequirementConfigRealizingItem).
The destructor never deleted it, leaking the reader and keeping its
BackendAssCache slot reference alive across calls.

Each materialize() call creates a new realizing item → new reader → leaked
reader holds the prior slot alive → slot count grows → BackendAssCache
processing grows O(n_slots × n_individuals) → timer 15ms → 64335ms → hang.

Fix: initialize to nullptr in default constructor; delete in destructor.
"""
import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingItem.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

VENDOR_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("vendor/konclude")

# Initialize mBackendAssocCacheReader to nullptr in the default constructor.
# File has mixed line endings — constructor uses CRLF, destructor body uses LF+CRLF mix.
# Exact byte patterns verified from vendor file.
OLD_CTOR = (
    "\t\t\tCOptimizedRepresentativeKPSetOntologyRealizingItem::"
    "COptimizedRepresentativeKPSetOntologyRealizingItem() {\r\n"
    "\t\t\t}\r\n"
)
NEW_CTOR = (
    "\t\t\tCOptimizedRepresentativeKPSetOntologyRealizingItem::"
    "COptimizedRepresentativeKPSetOntologyRealizingItem() {\r\n"
    "\t\t\t\tmBackendAssocCacheReader = nullptr;\r\n"
    "\t\t\t}\r\n"
)

# Add delete mBackendAssocCacheReader at end of destructor.
# The last for-loop line ends with \n (LF), then blank CRLF, then closing } CRLF.
OLD_DTOR_END = (
    "\t\t\t\tfor (auto* v : mDataRoleNonDetCacheLabelItemSetHash) { delete v; }\n"
    "\r\n"
    "\t\t\t}\r\n"
)
NEW_DTOR_END = (
    "\t\t\t\tfor (auto* v : mDataRoleNonDetCacheLabelItemSetHash) { delete v; }\n"
    "\t\t\t\tdelete mBackendAssocCacheReader;\r\n"
    "\r\n"
    "\t\t\t}\r\n"
)


def modify(path, content):
    if path.endswith("RealizingItem.cpp"):
        assert OLD_CTOR in content, "CTOR anchor not found — check indentation/CRLF"
        content = content.replace(OLD_CTOR, NEW_CTOR, 1)
        assert OLD_DTOR_END in content, "DTOR anchor not found — check indentation/CRLF"
        content = content.replace(OLD_DTOR_END, NEW_DTOR_END, 1)
    return content


for rel in FILES:
    p = VENDOR_DIR / rel
    content = p.read_bytes().decode("utf-8")
    p.write_bytes(modify(rel, content).encode("utf-8"))
