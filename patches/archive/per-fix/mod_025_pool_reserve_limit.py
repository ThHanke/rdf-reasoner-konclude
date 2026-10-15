import sys

S = "Source/Scheduler/"
FILES = [
    S + "CTaskProcessorThread.cpp",
    S + "CTaskProcessorSchedulerThread.cpp",
    S + "CTaskProcessorCompletorThread.cpp",
    S + "CSingleThreadTaskProcessorUnit.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Upstream keeps up to 80000 (30000 for the single thread unit) free ~44 KB memory pools per
# task processor thread: ~3.5 GB retained per thread, never returned (fine for a one-shot process,
# fatal for a long-lived one: ~1.4 GB stays after one Roberts call, 4 GiB wasm heap runs out).
# Keep a small reserve (1024 pools, ~45 MB) and hand the rest back to the allocator.

def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("CSingleThreadTaskProcessorUnit.cpp"):
        return rep(content, "(mMemoryPoolProvider,30000,30)", "(mMemoryPoolProvider,1024,30)", path)
    return rep(content, "(mMemoryPoolProvider,80000,30)", "(mMemoryPoolProvider,1024,30)", path)


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
