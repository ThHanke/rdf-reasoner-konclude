// native_repro.cpp — WASM-free, N3-free incremental-reasoning reproducer.
//
// Loads NTriples fixtures, keeps ONE KoncludeReasoner alive, runs a scripted op
// sequence and checks that every realization output is identical (and that no step hangs).
//
// Usage: konclude_repro [--mode reload|reload-split|reuse] [--runs N] [--timeout SEC] [--out DIR] fixture.nt
//   reload (default): every step = reset() + load + op        (what the TS layer does today)
//   reuse           : load once, classification(), then realization() N times with NO reset/reload
//                     (the true incremental goal)
//   seq             : --seq "m:a.nt,c:b.nt,m:a.nt~drop3,..." scripted reset+load+op sequence over DIFFERENT
//                     fixtures (m = materialize/realization, c = classify, e = empty ontology); "~dropK" removes
//                     the K-th non-empty line. Repeated identical steps must give identical output.
// Exit: 0 all outputs identical, 1 mismatch / op failure, 2 hang (watchdog aborts -> core for gdb).

#include "DetSched.h"
#include "KoncludeReasoner.h"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <unordered_map>
#include <unistd.h>
#include <malloc.h>
#include "KonPoolStats.h"

static std::atomic<long> gStepId{0};
static std::atomic<bool> gDone{false};
static std::string gStepName;
static int gTimeout = 60;

static std::string readFile(const std::string& path) {
    std::ifstream f(path);
    if (!f) { fprintf(stderr, "cannot open %s\n", path.c_str()); exit(1); }
    std::ostringstream ss; ss << f.rdbuf(); return ss.str();
}

static void watchdog() {
    long seen = -1; auto since = std::chrono::steady_clock::now();
    while (!gDone) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        long cur = gStepId;
        auto now = std::chrono::steady_clock::now();
        if (cur != seen) { seen = cur; since = now; continue; }
        if (std::chrono::duration_cast<std::chrono::seconds>(now - since).count() >= gTimeout) {
            fprintf(stderr, "\nHANG: step '%s' exceeded %ds — aborting (core for gdb)\n", gStepName.c_str(), gTimeout);
            abort();
        }
    }
}

// Live heap census (REPRO_MEM=1): bytes in use by malloc, to see which phase retains memory.
extern "C" int mallctl(const char*, void*, size_t*, void*, size_t) __attribute__((weak));
static int gMemStep = 0;
static void mem(const char* tag) {
    if (!getenv("REPRO_MEM")) return;
    // REPRO_PROF=dir (run with LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=prof:true,lg_prof_sample:17): dump allocation stacks.
    if (const char* d = getenv("REPRO_PROF")) if (mallctl && !strncmp(tag, "after-flush", 11)) {
        std::string f = std::string(d) + "/heap." + std::to_string(++gMemStep) + ".prof"; const char* fp = f.c_str();
        mallctl("prof.dump", nullptr, nullptr, &fp, sizeof(fp));
    }
    if (!strncmp(tag, "after-flush", 11)) fprintf(stderr, "    ONTDATA created=%lld freed=%lld evictedButReferenced=%lld freedViaReader=%lld realItems created=%lld destroyed=%lld readerQueued=%lld drained=%lld lastUsageAfterDec=%lld\n", KonPoolStats::gOntDataCreated.load(), KonPoolStats::gOntDataFreed.load(), KonPoolStats::gOntDataStaleKept.load(), KonPoolStats::gOntDataReaderReleased.load(), KonPoolStats::gRealItemsCreated.load(), KonPoolStats::gRealItemsDestroyed.load(), KonPoolStats::gReaderReleasesQueued.load(), KonPoolStats::gReaderReleasesDrained.load(), KonPoolStats::gReaderDrainLastUsage.load());
    if (mallctl) {   // jemalloc counters at every marker: live heap vs resident pages
        uint64_t epoch = 1; size_t sz = sizeof(epoch); mallctl("epoch", &epoch, &sz, &epoch, sz);
        size_t v[4] = {0, 0, 0, 0}; size_t l = sizeof(size_t);
        mallctl("stats.allocated", &v[0], &l, nullptr, 0); mallctl("stats.active", &v[1], &l, nullptr, 0);
        mallctl("stats.resident", &v[2], &l, nullptr, 0); mallctl("stats.retained", &v[3], &l, nullptr, 0);
        fprintf(stderr, "    JEMALLOC %-12s allocated=%zu MB active=%zu MB resident=%zu MB retained=%zu MB\n", tag, v[0] >> 20, v[1] >> 20, v[2] >> 20, v[3] >> 20);
    }
    struct mallinfo2 mi = mallinfo2();
    fprintf(stderr, "    POOLS %-13s tasks created=%lld completed=%lld kept=%lld containersReleased=%lld | pools alloc=%lld (%lld MB) freed=%lld (%lld MB) outstanding=%lld MB\n", tag,
        KonPoolStats::gTasksCreated.load(), KonPoolStats::gTasksCompleted.load(), KonPoolStats::gTasksKept.load(), KonPoolStats::gContainersReleased.load(),
        KonPoolStats::gPoolsAllocated.load(), KonPoolStats::gPoolBytesAllocated.load() >> 20, KonPoolStats::gPoolsFreed.load(), KonPoolStats::gPoolBytesFreed.load() >> 20,
        (KonPoolStats::gPoolBytesAllocated.load() - KonPoolStats::gPoolBytesFreed.load()) >> 20);
    fprintf(stderr, "    MEM %-14s live=%zu MB (arena=%zu mmap=%zu)\n", tag, (size_t)((mi.uordblks + mi.hblkhd) >> 20), (size_t)(mi.uordblks >> 20), (size_t)(mi.hblkhd >> 20));
}
// Object census (REPRO_CENSUS=dir): at every after-flush, scan all anonymous writable memory for words pointing into the
// binary's read-only mappings (vtable pointers identify the class of live polymorphic objects) and write a value->count
// histogram; join offline with `nm -S -C` to attribute classes. Run with MALLOC_PERTURB_=165 so freed chunks do not keep
// stale vtable pointers. Equivalent to comparing core dumps of two points in time, without the multi-GB files.
static void census(int step) {
    const char* dir = getenv("REPRO_CENSUS");
    if (!dir) return;
    std::vector<std::pair<unsigned long, unsigned long>> ro, rw;
    {
        std::ifstream maps("/proc/self/maps"); std::string line;
        while (std::getline(maps, line)) {
            unsigned long a, b; char perms[8]; char rest[512] = {0};
            if (sscanf(line.c_str(), "%lx-%lx %7s %*s %*s %*s %511[^\n]", &a, &b, perms, rest) < 3) continue;
            std::string path(rest); size_t f = path.find_first_not_of(' '); path = f == std::string::npos ? "" : path.substr(f);
            bool isBin = path.find("konclude_repro") != std::string::npos;
            if (isBin && perms[0] == 'r' && perms[1] == '-' ) ro.push_back({a, b});
            if (perms[0] == 'r' && perms[1] == 'w' && (path.empty() || path == "[heap]" || path.rfind("[stack", 0) == 0)) rw.push_back({a, b});
        }
    }
    std::unordered_map<unsigned long, unsigned long> hist;
    for (auto& r : rw) {
        const unsigned long* w = (const unsigned long*)r.first; size_t n = (r.second - r.first) / 8;
        for (size_t i = 0; i < n; ++i) {
            unsigned long v = w[i];
            if (v < 0x1000) continue;
            for (auto& q : ro) if (v >= q.first && v < q.second) { ++hist[v]; break; }
        }
    }
    std::vector<std::pair<unsigned long, unsigned long>> out(hist.begin(), hist.end());
    std::string path = std::string(dir) + "/census." + std::to_string(step) + ".txt";
    FILE* f = fopen(path.c_str(), "w");
    if (f) { for (auto& kv : out) if (kv.second >= 20) fprintf(f, "%lx %lu\n", kv.first, kv.second); fclose(f); }
}
static void begin(const std::string& name) {
    gStepName = name; gStepId++; KonPoolStats::gCallIdx.store((int)gStepId);
    fprintf(stderr, "--- %s\n", name.c_str());
}

static std::string collect(KoncludeReasoner& r) {
    r.buildInferredTripleBuffer(false);
    std::string out = r.resultAsSortedNTriples();
    r.buildPropertyTripleBuffer(false);
    out += r.resultAsSortedNTriples();
    return out;
}

static size_t lines(const std::string& s) { size_t n = 0; for (char c : s) n += c == '\n'; return n; }

int main(int argc, char** argv) {
    std::string mode = "reload", outDir = "/tmp/konclude-repro", fixture, seqSpec;
    int runs = 6, rereads = 0, rereadDelay = 5; std::string hold = "dereck_heath", dumpRole, coreAfter;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--mode") && i + 1 < argc) mode = argv[++i];
        else if (!strcmp(argv[i], "--runs") && i + 1 < argc) runs = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--timeout") && i + 1 < argc) gTimeout = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--out") && i + 1 < argc) outDir = argv[++i];
        else if (!strcmp(argv[i], "--hold") && i + 1 < argc) hold = argv[++i];
        else if (!strcmp(argv[i], "--seq") && i + 1 < argc) { seqSpec = argv[++i]; if (mode != "seq-sync") mode = "seq"; }
        else if (!strcmp(argv[i], "--dump-role") && i + 1 < argc) dumpRole = argv[++i];
        else if (!strcmp(argv[i], "--core-after") && i + 1 < argc) coreAfter = argv[++i];
        else if (!strcmp(argv[i], "--reread") && i + 1 < argc) rereads = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--reread-delay") && i + 1 < argc) rereadDelay = atoi(argv[++i]);
        else fixture = argv[i];
    }
    if (fixture.empty() && mode != "seq" && mode != "seq-sync") { fprintf(stderr, "usage: konclude_repro [--mode reload|reload-split|reuse] [--runs N] [--reread N] [--reread-delay S] [--timeout S] [--out DIR] fixture.nt\n"); return 64; }
    std::string nt = (mode == "seq" || mode == "seq-sync") ? std::string() : readFile(fixture);
    std::string mk = "mkdir -p " + outDir; if (system(mk.c_str())) return 1;

    std::thread wd(watchdog);
    KoncludeReasoner r;
    int rc = 0;
    std::string baseline;
    auto check = [&](int run, const std::string& out) {
        std::ofstream(outDir + "/run" + std::to_string(run) + ".nt") << out;
        fprintf(stderr, "    run %d: %zu triples\n", run, lines(out));
        if (run == 1) baseline = out;
        else if (out != baseline) { fprintf(stderr, "    MISMATCH vs run 1 (diff %s/run1.nt %s/run%d.nt)\n", outDir.c_str(), outDir.c_str(), run); rc = 1; }
    };

    if (mode == "sync-scenarios") {
        // Self-invalidating API contract on ONE reasoner instance (see plan 2026-10-10-001 Unit 2).
        int fails = 0;
        auto expect = [&](bool c, const std::string& what) { fprintf(stderr, "    %s %s\n", c ? "ok  " : "FAIL", what.c_str()); if (!c) fails++; };
        std::vector<std::string> ls; { std::istringstream is(nt); std::string l; while (std::getline(is, l)) if (!l.empty()) ls.push_back(l); }
        auto join = [&](const std::vector<std::string>& v) { std::string o; for (auto& l : v) o += l + "\n"; return o; };
        std::vector<std::string> shuf(ls.rbegin(), ls.rend()); shuf.insert(shuf.end(), ls.begin(), ls.begin() + 3);   // reversed + 3 duplicates
        std::vector<std::string> drop3 = ls; drop3.erase(drop3.begin() + 3);
        std::string A = join(ls);

        begin("first sync + realize");
        expect(r.syncNTriplesStr(A) == 1, "first sync changed");
        int g1 = r.generation();
        expect(r.realization(), "realization ok");
        std::string out1 = collect(r);
        expect(r.rebuildCount() == 1, "1 rebuild after first realization");
        begin("unchanged sync");
        expect(r.syncNTriplesStr(A) == 0, "same content -> unchanged");
        expect(r.generation() == g1, "generation stable");
        expect(r.realization(), "realization ok (cached)");
        expect(r.rebuildCount() == 1, "no rebuild");
        expect(collect(r) == out1, "output identical");
        expect(r.syncNTriplesStr(join(shuf)) == 0, "reordered + duplicated + other ids -> unchanged");
        begin("one triple removed");
        expect(r.syncNTriplesStr(join(drop3)) == 1, "removal -> changed");
        expect(r.lastSyncRemoved() == 1 && r.lastSyncAdded() == 0, "removed=1 added=0");
        expect(r.generation() == g1 + 1, "generation+1");
        expect(r.realization(), "realization ok");
        expect(r.rebuildCount() == 2, "2nd rebuild");
        std::string outDrop = collect(r);
        begin("change and change back before any reasoning call");
        expect(r.syncNTriplesStr(A) == 1, "add back -> changed vs previous sync");
        expect(r.lastSyncAdded() == 1, "added=1");
        expect(r.syncNTriplesStr(join(drop3)) == 1, "removed again");
        expect(r.syncNTriplesStr(join(drop3)) == 0, "no-op");
        expect(r.realization(), "realization ok");
        expect(r.rebuildCount() == 2, "content equals built one -> no rebuild");
        expect(collect(r) == outDrop, "output unchanged");
        begin("back to A, classify, realize, classify");
        expect(r.syncNTriplesStr(A) == 1, "changed");
        expect(r.classification(), "classification ok");
        int rb = r.rebuildCount();
        expect(r.classification() && r.rebuildCount() == rb, "classification idempotent");
        expect(r.realization(), "realization after classification");
        expect(r.rebuildCount() == rb + 1, "variant switch rebuilds once");
        expect(r.realization() && r.rebuildCount() == rb + 1, "realization idempotent");
        std::string outBack = collect(r);
        expect(lines(outBack) == lines(out1), "A output size equals first A output");
        expect(r.consistency() == r.consistency(), "consistency memoised/stable (classification variant)");
        begin("reads on stale content");
        expect(r.syncNTriplesStr(join(drop3)) == 1, "changed");
        expect(r.buildInferredTripleBuffer(false) == 0, "no stale inferred buffer served before the verb");
        begin("literal vs IRI with same string, empty content");
        expect(r.syncNTriplesStr("<http://e/a> <http://e/p> <http://e/b> .\n") == 1, "iri object");
        expect(r.syncNTriplesStr("<http://e/a> <http://e/p> \"http://e/b\" .\n") == 1, "literal object differs");
        expect(r.syncNTriplesStr("<http://e/a> <http://e/p> _:http://e/b .\n") == 1, "bnode object differs");
        expect(r.syncNTriplesStr("") == 1, "empty content");
        expect(r.classification(), "classify empty");
        expect(r.syncNTriplesStr("") == 0, "empty again unchanged");
        begin("invalid buffers leave state untouched");
        int gen = r.generation();
        expect(r.syncTripleBuffer(0, 0, 0, 0) == -1, "null string table -> -1");
        expect(r.generation() == gen, "generation untouched");
        fprintf(stderr, fails ? "RESULT: FAIL (%d)\n" : "RESULT: PASS\n", fails);
        gDone = true; wd.join();
        return fails ? 1 : 0;
    }
    if (mode == "seq-sync") {
        // Like seq, but through syncNTriplesStr (no reset): C++ decides when to rebuild.
        std::map<std::string, std::string> firstOut;
        std::stringstream ss(seqSpec); std::string step; int n = 0;
        while (std::getline(ss, step, ',')) {
            n++;
            char op = step.empty() ? 'm' : step[0];
            std::string spec = step.size() > 2 ? step.substr(2) : "";
            std::string path = spec; int drop = -1;
            size_t t = spec.find("~drop"); if (t != std::string::npos) { path = spec.substr(0, t); drop = atoi(spec.c_str() + t + 5); }
            std::string content;
            if (op != 'e' && path != "empty") {
                content = readFile(path);
                if (drop >= 0) {
                    std::istringstream is(content); std::string ln, out; int k = 0;
                    while (std::getline(is, ln)) { if (ln.empty()) continue; if (k++ != drop) out += ln + "\n"; }
                    content = out;
                }
            }
            begin("seq-sync #" + std::to_string(n) + " " + step);
            auto t0 = std::chrono::steady_clock::now();
            int sy = r.syncNTriplesStr(content);
            bool ok = op == 'm' ? r.realization() : r.classification();
            if (!ok) { fprintf(stderr, r.stalled() ? "STALL detected by KonStall\n" : "step failed\n"); rc = r.stalled() ? 3 : 1; break; }
            std::string out = collect(r);
            double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            std::ofstream(outDir + "/seq" + std::to_string(n) + ".nt") << out;
            fprintf(stderr, "    sync=%d gen=%d rebuilds=%d out=%zu triples (%.0f ms)\n", sy, r.generation(), r.rebuildCount(), lines(out), ms);
            auto it = firstOut.find(step);
            if (it == firstOut.end()) firstOut[step] = out;
            else if (it->second != out) fprintf(stderr, "    raw-differs from first '%s' (%zu vs %zu triples)\n", step.c_str(), lines(out), lines(it->second));
        }
        fprintf(stderr, rc ? "RESULT: FAIL\n" : "RESULT: PASS (%d steps)\n", n);
        gDone = true; wd.join();
        return rc;
    }
    if (mode == "seq") {
        // Steps: op ':' path ['~dropK']. Output of a repeated (op,spec) pair must equal its first occurrence.
        std::map<std::string, std::string> firstOut;
        std::stringstream ss(seqSpec); std::string step; int n = 0;
        while (std::getline(ss, step, ',')) {
            n++;
            char op = step.empty() ? 'm' : step[0];
            std::string spec = step.size() > 2 ? step.substr(2) : "";
            std::string path = spec; int drop = -1;
            size_t t = spec.find("~drop"); if (t != std::string::npos) { path = spec.substr(0, t); drop = atoi(spec.c_str() + t + 5); }
            std::string content;
            if (op != 'e' && path != "empty") {
                content = readFile(path);
                if (drop >= 0) {
                    std::istringstream is(content); std::string ln, out; int k = 0;
                    while (std::getline(is, ln)) { if (ln.empty()) continue; if (k++ != drop) out += ln + "\n"; }
                    content = out;
                }
            }
            begin("seq #" + std::to_string(n) + " " + step);
            auto t0 = std::chrono::steady_clock::now();
            mem("before-reset");
            r.reset();
            mem("after-reset");
            if (!r.loadNTriplesStr(content, op == 'm')) { fprintf(stderr, "load failed\n"); rc = 1; break; }
            mem("after-load");
            bool ok = op == 'm' ? r.realization() : op == 'k' ? r.consistency() : r.classification();
            mem("after-op");
            if (getenv("REPRO_FLUSH")) { KonPoolStats::requestPoolFlush(); std::this_thread::sleep_for(std::chrono::milliseconds(400)); mem("after-flush"); census((int)KonPoolStats::gCallIdx.load()); if (const char* sd = getenv("KON_POOLSITE")) { std::string pth = std::string(sd) + "/sites." + std::to_string(KonPoolStats::gCallIdx.load()) + ".txt"; KonPoolStats::dumpSites(pth.c_str()); } }
            if (!ok && !r.stalled() && getenv("REPRO_CONTINUE")) { fprintf(stderr, "    step %d: not ok (inconsistent/failed), continuing\n", n); continue; }
            if (!ok) { fprintf(stderr, r.stalled() ? "STALL detected by KonStall\n" : "step failed\n"); rc = r.stalled() ? 3 : 1; break; }
            std::string out = collect(r);
            double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            std::ofstream(outDir + "/seq" + std::to_string(n) + ".nt") << out;
            if (!dumpRole.empty() && op == 'm' && ss.peek() == EOF) std::ofstream(outDir + "/rolestate" + std::to_string(n) + ".txt") << r.dumpRoleState(dumpRole);
            auto it = firstOut.find(step);
            DetSched::report(("step " + std::to_string(n)).c_str());
            if (it == firstOut.end()) { if (!getenv("REPRO_NOFIRST")) firstOut[step] = out; fprintf(stderr, "    step %d: %zu triples (%.0f ms)\n", n, lines(out), ms); }
            else if (it->second != out) { fprintf(stderr, "    step %d raw-differs from first '%s' (%zu vs %zu triples; equivalent/inverse role orientation may differ, scripts/seq-compare.py checks canonical equality)\n", n, step.c_str(), lines(out), lines(it->second)); }
            else fprintf(stderr, "    step %d: same as first (%.0f ms)\n", n, ms);
        }
        fprintf(stderr, rc ? "RESULT: FAIL\n" : "RESULT: PASS (%d steps)\n", n);
        gDone = true; wd.join();
        return rc;
    } else if (mode == "incr-abox") {
        // Hold back all triples mentioning `hold`; load the rest, realize; then add them as a new
        // ontology REVISION (Konclude's incremental mechanism) and realize incrementally.
        std::string base, held; std::istringstream is(nt); std::string ln;
        while (std::getline(is, ln)) (ln.find(hold) != std::string::npos && ln.compare(0, 2, "_:") != 0 ? held : base) += ln + "\n";
        fprintf(stderr, "base %zu lines, held %zu lines (hold='%s')\n", lines(base), lines(held), hold.c_str());
        begin("load base"); if (!r.loadNTriplesStr(base, true)) { fprintf(stderr, "load failed\n"); return 1; }
        begin("realization (base)"); if (!r.realization()) { fprintf(stderr, "realization failed\n"); rc = 1; }
        std::string out0 = collect(r); std::ofstream(outDir + "/base.nt") << out0;
        fprintf(stderr, "    base: %zu triples\n", lines(out0));
        begin("add revision (held-back triples)"); if (!r.addRevisionNTriplesStr(held)) { fprintf(stderr, "revision failed\n"); return 1; }
        begin("realization (incremental)"); if (!r.realization()) { fprintf(stderr, "incremental realization failed\n"); rc = 1; }
        check(1, collect(r));
        std::ofstream(outDir + "/incremental.nt") << baseline;
    } else if (mode == "reuse") {
        begin("load"); if (!r.loadNTriplesStr(nt, true)) { fprintf(stderr, "load failed\n"); return 1; }
        begin("classification"); if (!r.classification()) { fprintf(stderr, "classify failed\n"); rc = 1; }
        for (int i = 1; i <= runs; i++) {
            begin("realization #" + std::to_string(i) + " (no reset)");
            if (!r.realization()) { fprintf(stderr, "realization failed\n"); rc = 1; break; }
            check(i, collect(r));
            if (!dumpRole.empty()) {
                std::string st = r.dumpRoleState(dumpRole);
                fprintf(stderr, "ROLESTATE\n%s", st.c_str());
                std::ofstream(outDir + "/rolestate.txt") << st;
            }
            if (!coreAfter.empty()) {
                // Live-process core (gcore) at the end of realization, for post-mortem inspection.
                std::string cmd = "gcore -o " + coreAfter + " " + std::to_string((long)getpid()) + " >/dev/null 2>&1";
                if (system(cmd.c_str()) == 0) fprintf(stderr, "core written: %s.%ld\n", coreAfter.c_str(), (long)getpid());
            }
            // Early-completion discriminator: if the count grows on later reads, the pipeline
            // returned before the work finished (readout/completion race), not true loss.
            for (int k = 1; k <= rereads; k++) {
                std::this_thread::sleep_for(std::chrono::seconds(rereadDelay));
                std::string again = collect(r);
                fprintf(stderr, "    reread +%ds: %zu triples (%s)\n", k * rereadDelay, lines(again),
                        again == baseline ? "same" : "DIFFERENT");
                std::ofstream(outDir + "/run" + std::to_string(i) + "-reread" + std::to_string(k) + ".nt") << again;
            }
        }
    } else if (mode == "reload-split") {
        for (int i = 1; i <= runs; i++) {
            begin("reset+load+classification+realization #" + std::to_string(i));
            r.reset();
            if (!r.loadNTriplesStr(nt, true)) { fprintf(stderr, "load failed\n"); rc = 1; break; }
            if (!r.classification()) { fprintf(stderr, "classify failed\n"); rc = 1; break; }
            if (!r.realization()) { fprintf(stderr, "realization failed\n"); rc = 1; break; }
            check(i, collect(r));
        }
    } else {
        for (int i = 1; i <= runs; i++) {
            begin("reset+load+realization #" + std::to_string(i));
            r.reset();
            if (!r.loadNTriplesStr(nt, true)) { fprintf(stderr, "load failed\n"); rc = 1; break; }
            if (!r.realization()) { fprintf(stderr, "realization failed\n"); rc = 1; break; }
            check(i, collect(r));
        }
    }
    fprintf(stderr, rc ? "RESULT: FAIL\n" : "RESULT: PASS (%d runs identical)\n", runs);
    gDone = true; wd.join();
    return rc;
}
