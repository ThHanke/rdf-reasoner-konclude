import sys, os

FILES = ["Source/Reasoner/Triples/CRedlandStoredTriplesData.cpp"]

OLD = "CRedlandStoredTriplesData::~CRedlandStoredTriplesData() {\n"
NEW = (
    "CRedlandStoredTriplesData::~CRedlandStoredTriplesData() {\n"
    "\t\t\t\t// statement copies kept for indexing (the indexer frees them and clears the linker once it ran);\n"
    "\t\t\t\t// they belong to this data's world, so free them before the world\n"
    "\t\t\t\twhile (mStatementLinker) {\n"
    "\t\t\t\t\tlibrdf_free_statement(mStatementLinker->getData());\n"
    "\t\t\t\t\tCXLinker<librdf_statement*>* tmpStatementLinker = mStatementLinker;\n"
    "\t\t\t\t\tmStatementLinker = mStatementLinker->getNext();\n"
    "\t\t\t\t\tdelete tmpStatementLinker;\n"
    "\t\t\t\t}\n"
)


def modify(rel_path, content):
    nl = "\r\n" if "\r\n" in content else "\n"
    c = content.replace("\r\n", "\n")
    assert OLD in c, rel_path
    c = c.replace(OLD, NEW, 1)
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
