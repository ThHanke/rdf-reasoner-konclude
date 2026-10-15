import sys

FILES = [
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Upstream precedence bug: `*mergingOperationLimit-- <= 0` parses as
# `*(mergingOperationLimit--) <= 0`: it decrements the POINTER, not the counter.
# Nested calls then read the previous stack slot (uninitialized / layout dependent
# value) as the operation limit, so trivial concept-instance merging decisions depend
# on stack contents (ASan: stack-buffer-overflow at offset -8 of mergeOperationLimit).
OLD = "mergingOperationLimit && *mergingOperationLimit-- <= 0"
NEW = "mergingOperationLimit && (*mergingOperationLimit)-- <= 0"


def modify(path, content):
    if path.endswith("COptimizedRepresentativeKPSetOntologyRealizingThread.cpp"):
        if content.count(OLD) != 5:
            raise ValueError(f"{path}: expected 5 occurrences, found {content.count(OLD)}")
        return content.replace(OLD, NEW)
    return content


if __name__ == "__main__" and len(sys.argv) > 1:
    from pathlib import Path
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        p = vendor_dir / rel_path
        content = p.read_text(encoding="utf-8")
        new_content = modify(rel_path, content)
        if new_content != content:
            p.write_text(new_content, encoding="utf-8")
            print(f"  modified: {rel_path}")
