import sys, os

FILES = ["Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp"]

OLD = (
    "\t\t\t\t\tlibrdf_stream* stream = librdf_model_find_statements(model, partial_statement);\n"
    "\t\t\t\t\tif (!stream) {\n"
    "\t\t\t\t\t\treturn false;\n"
    "\t\t\t\t\t} else {\n"
    "\t\t\t\t\t\tnewTriplesMapped = true;\n"
)
NEW = (
    "\t\t\t\t\tlibrdf_stream* stream = librdf_model_find_statements(model, partial_statement);\n"
    "\t\t\t\t\tif (!stream) {\n"
    "\t\t\t\t\t\tlibrdf_free_statement(partial_statement);\n"
    "\t\t\t\t\t\treturn false;\n"
    "\t\t\t\t\t} else {\n"
    "\t\t\t\t\t\t// only an existence probe: a stream left open pins the model's storage, so the whole Redland\n"
    "\t\t\t\t\t\t// model would survive librdf_free_model (per-ontology leak of the triple hashes)\n"
    "\t\t\t\t\t\tlibrdf_free_stream(stream);\n"
    "\t\t\t\t\t\tlibrdf_free_statement(partial_statement);\n"
    "\t\t\t\t\t\tnewTriplesMapped = true;\n"
)


OLD2 = (
    "\t\t\t\t\t\tcint64 count = 0;\n"
    "\t\t\t\t\t\tgetOWLClassInstanceNodesStream()->forEach([&](librdf_node* node) {\n"
    "\t\t\t\t\t\t\tcount++;\n"
    "\t\t\t\t\t\t});\n"
)
NEW2 = (
    "\t\t\t\t\t\tcint64 count = 0;\n"
    "\t\t\t\t\t\t// the wrapper owns an open librdf stream that pins the model storage: release it\n"
    "\t\t\t\t\t\treleaseRedlandNodeStreamWrapper(getOWLClassInstanceNodesStream()->forEach([&](librdf_node* node) {\n"
    "\t\t\t\t\t\t\tcount++;\n"
    "\t\t\t\t\t\t}));\n"
)


def modify(rel_path, content):
    nl = "\r\n" if "\r\n" in content else "\n"
    c = content.replace("\r\n", "\n")
    assert OLD in c and OLD2 in c, rel_path
    c = c.replace(OLD, NEW, 1).replace(OLD2, NEW2, 1)
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
