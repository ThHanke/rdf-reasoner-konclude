import sys, os

FILES = [
    "Source/Reasoner/Classifier/COptimizedKPSetClassOntologyClassificationItem.cpp",
    "Source/Reasoner/Classifier/COptimizedKPSetRoleOntologyClassificationItem.cpp",
]

INC_OLD_CLASS = '#include "COptimizedKPSetClassOntologyClassificationItem.h"\n'
INC_OLD_ROLE = '#include "COptimizedKPSetRoleOntologyClassificationItem.h"\n'
INC_NEW = '#include "Utilities/Memory/CNewAllocationMemoryPoolProvider.h"\n'

DTOR_OLD = "for (auto* item : mSatTestItemContainer) { delete item; }\n"
DTOR_NEW = (
    "for (auto* item : mSatTestItemContainer) { delete item; }\n"
    "\t\t\t\t// pseudo model pools collected via addMemoryPools(): nothing else frees them\n"
    "\t\t\t\tif (CMemoryPool* pools = mMemoryPoolContainer.takeMemoryPools()) {\n"
    "\t\t\t\t\tCNewAllocationMemoryPoolProvider tmpProv;\n"
    "\t\t\t\t\ttmpProv.releaseMemoryPool(pools);\n"
    "\t\t\t\t}\n"
)


def modify(rel_path, content):
    nl = "\r\n" if "\r\n" in content else "\n"
    c = content.replace("\r\n", "\n")
    inc = INC_OLD_CLASS if "ClassOntology" in rel_path else INC_OLD_ROLE
    assert inc in c and DTOR_OLD in c, rel_path
    c = c.replace(inc, inc + INC_NEW, 1)
    c = c.replace(DTOR_OLD, DTOR_NEW, 1)
    return c.replace("\n", nl) if nl == "\r\n" else c


if __name__ == "__main__":
    if "--list-files" in sys.argv:
        for f in FILES:
            print(f)
        sys.exit(0)
    vendor_dir = sys.argv[1]
    for rel_path in FILES:
        full = os.path.join(vendor_dir, rel_path)
        with open(full, newline="") as fh:
            content = fh.read()
        new = modify(rel_path, content)
        if new != content:
            with open(full, "w", newline="") as fh:
                fh.write(new)
