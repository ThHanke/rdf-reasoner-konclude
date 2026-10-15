// KonPoolStats.h — process-wide counters for task/memory-pool lifecycle diagnostics (leak hunting).
// created - completed = tasks that never completed; completed - kept = tasks whose pools were handed
// back by the scheduler; kept = tasks whose pools a consumer took over (setMemoryReleaseable(false)).
#pragma once
#include <atomic>
#include <algorithm>
#ifndef __EMSCRIPTEN__
#include <execinfo.h>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#endif

namespace KonPoolStats {

inline std::atomic<long long> gTasksCreated{0};
inline std::atomic<long long> gTasksCompleted{0};
inline std::atomic<long long> gTasksKept{0};
inline std::atomic<long long> gContainersReleased{0};
inline std::atomic<long long> gPoolsAllocated{0};
inline std::atomic<long long> gPoolsFreed{0};
inline std::atomic<long long> gPoolBytesAllocated{0};
inline std::atomic<long long> gPoolBytesFreed{0};
// Backend cache per-ontology data: created, freed, evicted while still referenced (usage count > 0).
inline std::atomic<long long> gOntDataCreated{0};
inline std::atomic<long long> gOntDataFreed{0};
inline std::atomic<long long> gOntDataStaleKept{0};
inline std::atomic<long long> gOntDataReaderReleased{0};
inline std::atomic<long long> gRealItemsCreated{0}, gRealItemsDestroyed{0}, gReaderReleasesQueued{0}, gReaderReleasesDrained{0}, gReaderDrainLastUsage{0};   // freed via the realizer reader hand-back (patch 029)

// Flush request: every task processor thread frees its own free-pool reserve when it sees a new
// generation (checked at least every 100 ms in its processing loop). Call at the end of a reasoning call.
inline std::atomic<long long> gFlushGen{0};
inline void requestPoolFlush() { gFlushGen.fetch_add(1, std::memory_order_release); }

// Allocation-site registry for live pool blocks (native only, KON_POOLSITE=<dir>): which call and which stack
// allocated the blocks that are still alive. dumpSites() aggregates by (call, stack).
#ifndef __EMSCRIPTEN__
inline std::atomic<int> gCallIdx{0};
struct PoolSite { long long bytes; int call; int depth; void* pc[16]; };
inline std::mutex gSiteMx;
inline std::unordered_map<void*, PoolSite> gSites;
inline const bool gSiteOn = getenv("KON_POOLSITE") != nullptr;
inline void siteAdd(void* key, long long bytes) {
    if (!gSiteOn || !key) return;
    PoolSite s; s.bytes = bytes; s.call = gCallIdx.load(); s.depth = backtrace(s.pc, 16);
    std::lock_guard<std::mutex> l(gSiteMx); gSites[key] = s;
}
inline void siteDel(void* key) {
    if (!gSiteOn || !key) return;
    std::lock_guard<std::mutex> l(gSiteMx); gSites.erase(key);
}
inline void dumpSites(const char* path) {
    if (!gSiteOn) return;
    std::map<std::string, std::pair<long long, long long>> agg;   // key -> (bytes, count)
    {
        std::lock_guard<std::mutex> l(gSiteMx);
        for (auto& kv : gSites) {
            const PoolSite& s = kv.second;
            std::string k = "call" + std::to_string(s.call);
            for (int i = 0; i < s.depth; ++i) { char b[24]; snprintf(b, sizeof b, " %lx", (unsigned long)s.pc[i]); k += b; }
            auto& a = agg[k]; a.first += s.bytes; a.second += 1;
        }
    }
    std::vector<std::pair<long long, std::string>> v;
    for (auto& kv : agg) v.push_back({kv.second.first, kv.first + "  #bytes=" + std::to_string(kv.second.first) + " #count=" + std::to_string(kv.second.second)});
    std::sort(v.begin(), v.end(), [](auto& a, auto& b) { return a.first > b.first; });
    FILE* f = fopen(path, "w"); if (!f) return;
    FILE* m = fopen("/proc/self/maps", "r"); char line[512];
    if (m) { if (fgets(line, sizeof line, m)) fprintf(f, "MAPS %s", line); fclose(m); }
    for (size_t i = 0; i < v.size() && i < 400; ++i) fprintf(f, "%s\n", v[i].second.c_str());
    fclose(f);
}
#else
inline void siteAdd(void*, long long) {}
inline void siteDel(void*) {}
#endif

inline void poolAlloc(long long bytes, void* key = nullptr) { gPoolsAllocated.fetch_add(1, std::memory_order_relaxed); gPoolBytesAllocated.fetch_add(bytes, std::memory_order_relaxed); siteAdd(key, bytes); }
inline void poolFree(long long bytes, void* key = nullptr) { gPoolsFreed.fetch_add(1, std::memory_order_relaxed); gPoolBytesFreed.fetch_add(bytes, std::memory_order_relaxed); siteDel(key); }

} // namespace KonPoolStats
