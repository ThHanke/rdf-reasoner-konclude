#pragma once
#include <unordered_map>
#include <vector>
#include <mutex>
#include <cstdint>

// Thread-safe cache for justification data captured during classification.
// Written by the overridden CSatisfiableTaskClassificationMessageAnalyser
// (on KPSet worker threads), read by KoncludeReasoner::Impl (on main thread).
//
// Key: packed (testingConceptTag, subsumerConceptTag) as int64 pair.
// Value: vector of concept tags from IMPLICATION dep nodes in the chain.

struct JustificationCache {
    struct Key {
        int64_t subTag;
        int64_t superTag;
        bool operator==(const Key& o) const { return subTag == o.subTag && superTag == o.superTag; }
    };

    struct KeyHash {
        size_t operator()(const Key& k) const {
            size_t h1 = std::hash<int64_t>{}(k.subTag);
            size_t h2 = std::hash<int64_t>{}(k.superTag);
            return h1 ^ (h2 * 0x9e3779b97f4a7c15ULL + 0x9e3779b9 + (h1 << 6) + (h1 >> 2));
        }
    };

    // Each entry: list of concept tags from IMPLICATION dep nodes that
    // contributed to this subsumption being established.
    std::unordered_map<Key, std::vector<int64_t>, KeyHash> entries;
    std::mutex mu;

    void insert(int64_t subTag, int64_t superTag, std::vector<int64_t>&& implTags) {
        std::lock_guard<std::mutex> lock(mu);
        Key k{subTag, superTag};
        entries[k] = std::move(implTags);
    }

    const std::vector<int64_t>* lookup(int64_t subTag, int64_t superTag) const {
        Key k{subTag, superTag};
        auto it = entries.find(k);
        return it != entries.end() ? &it->second : nullptr;
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mu);
        entries.clear();
    }

    size_t size() const { return entries.size(); }

    static JustificationCache& instance() {
        static JustificationCache cache;
        return cache;
    }
};
