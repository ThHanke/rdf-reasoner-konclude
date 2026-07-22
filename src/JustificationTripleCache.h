#pragma once
#include <unordered_map>
#include <string>

// IRI-keyed cache mapping (subject, predicate, object) → justification NTriples.
// Populated during buildInferredTripleBuffer / buildPropertyTripleBuffer (single-
// threaded on the Worker dispatch thread after all KPSet pthreads are joined).
// Read by lookupTripleJustification via Embind.  No mutex needed — single-threaded
// write during emission, single-threaded read from JS.

struct JustificationTripleCache {
    struct TripleKey {
        std::string sub;
        std::string pred;
        std::string obj;
        bool operator==(const TripleKey& o) const {
            return sub == o.sub && pred == o.pred && obj == o.obj;
        }
    };

    struct TripleKeyHash {
        size_t operator()(const TripleKey& k) const {
            size_t h1 = std::hash<std::string>{}(k.sub);
            size_t h2 = std::hash<std::string>{}(k.pred);
            size_t h3 = std::hash<std::string>{}(k.obj);
            size_t h = h1 ^ (h2 * 0x9e3779b97f4a7c15ULL + 0x9e3779b9 + (h1 << 6) + (h1 >> 2));
            return h ^ (h3 * 0x517cc1b727220a95ULL + 0x9e3779b9 + (h << 6) + (h >> 2));
        }
    };

    std::unordered_map<TripleKey, std::string, TripleKeyHash> entries;

    void insert(const std::string& sub, const std::string& pred,
                const std::string& obj, const std::string& justification) {
        entries[TripleKey{sub, pred, obj}] = justification;
    }

    std::string lookup(const std::string& sub, const std::string& pred,
                       const std::string& obj) const {
        auto it = entries.find(TripleKey{sub, pred, obj});
        return it != entries.end() ? it->second : "";
    }

    bool has(const std::string& sub, const std::string& pred,
             const std::string& obj) const {
        return entries.find(TripleKey{sub, pred, obj}) != entries.end();
    }

    void clear() {
        entries.clear();
    }

    size_t size() const {
        return entries.size();
    }

    static JustificationTripleCache& instance() {
        static JustificationTripleCache cache;
        return cache;
    }
};
