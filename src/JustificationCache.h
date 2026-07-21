#pragma once
#include <unordered_map>
#include <vector>
#include <shared_mutex>
#include <cstdint>

// Thread-safe cache for justification data captured during classification
// and realization. Written by KPSet worker threads (classification analyser,
// clash-path hook), read by KoncludeReasoner::Impl (main thread).
//
// Key: packed (subTag, superTag, entailmentType).
// Value: vector of concept/role tags from dep nodes in the proof chain.

struct JustificationCache {
    enum EntailmentType : uint8_t {
        Classification      = 0,
        Realization          = 1,
        PropertySubsumption = 2,
    };

    struct Key {
        int64_t subTag;
        int64_t superTag;
        EntailmentType type = Classification;
        bool operator==(const Key& o) const {
            return subTag == o.subTag && superTag == o.superTag && type == o.type;
        }
    };

    struct KeyHash {
        size_t operator()(const Key& k) const {
            size_t h1 = std::hash<int64_t>{}(k.subTag);
            size_t h2 = std::hash<int64_t>{}(k.superTag);
            size_t h = h1 ^ (h2 * 0x9e3779b97f4a7c15ULL + 0x9e3779b9 + (h1 << 6) + (h1 >> 2));
            return h ^ (static_cast<size_t>(k.type) * 0x517cc1b727220a95ULL);
        }
    };

    std::unordered_map<Key, std::vector<int64_t>, KeyHash> entries;
    mutable std::shared_mutex mu;

    // Backward-compatible 3-arg form: Classification type (default).
    void insert(int64_t subTag, int64_t superTag, std::vector<int64_t>&& implTags) {
        std::unique_lock<std::shared_mutex> lock(mu);
        entries[Key{subTag, superTag, Classification}] = std::move(implTags);
    }

    void insert(int64_t subTag, int64_t superTag, EntailmentType type, std::vector<int64_t>&& implTags) {
        std::unique_lock<std::shared_mutex> lock(mu);
        entries[Key{subTag, superTag, type}] = std::move(implTags);
    }

    // Backward-compatible 2-arg lookup: Classification type (default).
    const std::vector<int64_t>* lookup(int64_t subTag, int64_t superTag) const {
        std::shared_lock<std::shared_mutex> lock(mu);
        auto it = entries.find(Key{subTag, superTag, Classification});
        return it != entries.end() ? &it->second : nullptr;
    }

    const std::vector<int64_t>* lookup(int64_t subTag, int64_t superTag, EntailmentType type) const {
        std::shared_lock<std::shared_mutex> lock(mu);
        auto it = entries.find(Key{subTag, superTag, type});
        return it != entries.end() ? &it->second : nullptr;
    }

    void clear() {
        std::unique_lock<std::shared_mutex> lock(mu);
        entries.clear();
    }

    size_t size() const {
        std::shared_lock<std::shared_mutex> lock(mu);
        return entries.size();
    }

    static JustificationCache& instance() {
        static JustificationCache cache;
        return cache;
    }
};
