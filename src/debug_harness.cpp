// debug_harness.cpp — sequential-call hang reproducer for native GDB debugging.
//
// Reproduces the pattern from explanation-persistence.test.ts:
//   calls 1–2: classify (simple TBox)
//   calls 3–4: realization (Roberts family)
//   call  5:   classify (simple TBox)
//   call  6:   classify (Roberts TBox — classifyProperties equivalent)
//   calls 7–8: realization (Roberts family) ← call 7 hangs with patches 000–008
//
// Build: cmake -B build-native -f CMakeLists-native.cmake . && cmake --build build-native -j4
// Run:   ./build-native/konclude_debug
// GDB:   gdb ./build-native/konclude_debug   (set breakpoints then 'run')
//
// State JSON is written to /tmp/konclude-state-N-PHASE.json after each step.

#include "KoncludeReasoner.h"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <fstream>
#include <sstream>
#include <sys/stat.h>

// ── Fixture loader ────────────────────────────────────────────────────────────

static std::string readFile(const char* path) {
    std::ifstream f(path);
    if (!f) {
        fprintf(stderr, "HARNESS: cannot open fixture: %s\n", path);
        exit(1);
    }
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Minimal TBox: Animal ⊑ Thing, Dog ⊑ Animal
static const char* SIMPLE_TBOX_NT =
    "<http://h.test/> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Ontology> .\n"
    "<http://h.test/Animal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .\n"
    "<http://h.test/Dog> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .\n"
    "<http://h.test/Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://h.test/Animal> .\n";

// ── State dump ────────────────────────────────────────────────────────────────

static void writeState(const KoncludeReasoner& r, int callNum, const char* phase) {
    const char* json = r.dumpState(phase);
    char path[256];
    snprintf(path, sizeof(path), "/tmp/konclude-state-%d-%s.json", callNum, phase);
    FILE* f = fopen(path, "w");
    if (f) { fputs(json, f); fputc('\n', f); fclose(f); }
    fprintf(stderr, "STATE[%d/%s]: %s\n", callNum, phase, json);
}

// ── One sequential call ───────────────────────────────────────────────────────

static bool doCall(KoncludeReasoner& r, int callNum,
                   const std::string& nt, bool withRealization) {
    fprintf(stderr, "\n=== CALL %d (realization=%d) ===\n", callNum, (int)withRealization);

    r.reset();
    writeState(r, callNum, "after-reset");

    bool loaded = r.loadNTriplesStr(nt, withRealization);
    if (!loaded) {
        fprintf(stderr, "HARNESS: loadNTriplesStr failed at call %d\n", callNum);
        return false;
    }
    writeState(r, callNum, "after-load");

    fprintf(stderr, "HARNESS[%d]: calling %s ...\n",
            callNum, withRealization ? "realization()" : "classification()");

    bool ok = withRealization ? r.realization() : r.classification();

    writeState(r, callNum, "after-reason");
    fprintf(stderr, "HARNESS[%d]: done, ok=%d\n", callNum, (int)ok);
    return ok;
}

// ── Main ──────────────────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
    // Allow fixture path override: ./konclude_debug [fixture_dir]
    const char* fixtureDir = (argc > 1) ? argv[1] : "tests/fixtures";

    std::string robertsNT = readFile(
        (std::string(fixtureDir) + "/roberts-family.nt").c_str());
    std::string simpleTBox(SIMPLE_TBOX_NT);

    fprintf(stderr, "HARNESS: creating KoncludeReasoner\n");
    KoncludeReasoner r;

    // Pattern from explanation-persistence.test.ts shared-reasoner variant:
    doCall(r, 1, simpleTBox,  false);  // classify
    doCall(r, 2, simpleTBox,  false);  // classify
    doCall(r, 3, robertsNT,   true);   // materialize
    doCall(r, 4, robertsNT,   true);   // materialize
    doCall(r, 5, simpleTBox,  false);  // classify
    doCall(r, 6, robertsNT,   false);  // classify (properties)
    doCall(r, 7, robertsNT,   true);   // materialize ← hangs here with patches 000-008
    doCall(r, 8, robertsNT,   true);   // materialize

    fprintf(stderr, "\nHARNESS: all 8 calls completed\n");

    // Emit comparison summary
    fprintf(stderr, "\n=== STATE SUMMARY (compare calls 6 vs 7 for divergence) ===\n");
    fprintf(stderr, "State files: /tmp/konclude-state-{1..8}-{after-reset,after-load,after-reason}.json\n");
    fprintf(stderr, "jq comparison:\n");
    fprintf(stderr, "  for i in 1 2 3 4 5 6 7 8; do "
                    "jq '{call:'$i',end_set:.processing_end_set_size,"
                    "start_set:.processing_start_set_size,"
                    "realizers:.stopped_realizer_count}' "
                    "/tmp/konclude-state-$i-after-reason.json; done\n");

    return 0;
}
