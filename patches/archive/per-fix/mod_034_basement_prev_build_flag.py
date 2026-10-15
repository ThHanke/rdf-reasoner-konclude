import sys

FILES = ["Source/Reasoner/Ontology/COntologyDataBoxes.cpp"]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Upstream creates the working ontology by referencing a separate basement ontology
# (referenceDataBoxes copies the basic-build flag into mPrevOntBasicBuild), so the first
# update build runs with mInitialBuild == true and localises the top/bottom concept up front.
# The WASM wrapper applies the basement directly to the working ontology, so mPrevOntBasicBuild
# stayed false: setBuildContinuation() then left mInitialBuild false, the top concept was
# localised only at the end of the build and every concept built before (e.g. the operand of
# a unary minCardinality 1 = SOME r.Thing) kept pointing to the stale basement top concept,
# which has no process data (null deref in saturation).


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    return rep(content,
        "				mBasicBuild = basicBuild;\n				return this;\n",
        "				mBasicBuild = basicBuild;\n				if (basicBuild) {\n					mPrevOntBasicBuild = true;\n				}\n				return this;\n", path)


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
