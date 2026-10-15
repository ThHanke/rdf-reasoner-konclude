#pragma once
#include <string>

class KoncludeReasoner {
public:
    KoncludeReasoner();
    ~KoncludeReasoner();

    // syncTripleBuffer — hand over the CURRENT content of the caller's store (zero-copy binary protocol).
    //
    // The reasoner decides by itself whether the content changed: every triple is hashed by
    // (term type, term string) into a 128-bit digest and the digest set is compared with the last
    // synced one. Unchanged content (any order, duplicates, other interned ids) is a no-op. Changed
    // content bumps generation() and invalidates all cached results; the ontology is rebuilt lazily
    // by the next classification()/realization()/consistency().
    // Returns 1 = changed, 0 = unchanged, -1 = invalid buffers (state untouched).
    //
    // Wire format (see ts/intern.ts for the JS encoder):
    //
    //   strTablePtr → [count:u32][offset0:u32 … offsetN:u32][UTF-8 strings...]
    //     offsets are byte positions within the string-data section (after the header).
    //
    //   triplePtr → [s:u32, p:u32, o:u32, …]  (tripleCount tuples, stride 12 bytes)
    //     each uint32 encodes term type in the top 2 bits (id >> 30):
    //       0 = NamedNode  → librdf_new_node_from_uri_string
    //       1 = BlankNode  → librdf_new_node_from_blank_identifier
    //       2 = Literal    → string-data entry is "value\0datatype\0language"
    //     lower 30 bits (id & 0x3FFFFFFF) = index into the offset array.
    int syncTripleBuffer(int triplePtr, int tripleCount, int strTablePtr, int strTableLen);
    // Content generation: incremented by every changing sync (and by reset()).
    int generation() const;
    // Stats of the last changing sync (distinct triples added / removed vs the previous content).
    int lastSyncAdded() const;
    int lastSyncRemoved() const;
    // Number of distinct triples in the synced content.
    int tripleCount() const;
    // Number of ontology (re)builds so far — diagnostics / tests.
    int rebuildCount() const;

    // classification — TBox only (class + property hierarchy). Idempotent per generation.
    bool classification();
    // realization — TBox + ABox (includes classification as prerequisite).
    bool realization();
    // consistency — check ontology consistency (runs classification itself if needed; memoised).
    bool consistency();
    // processorCount — number of parallel worker threads configured.
    int processorCount();

    // Binary output protocol.
    // buildInferredTripleBuffer() assembles a combined output buffer:
    //   [strTableLen:u32][strTable][tripleBuffer]
    // Returns total byte length (0 if not classified).
    // getInferredTripleBufferPtr() returns the raw pointer into the internal
    // buffer — valid until the next rebuild / reset.
    int buildInferredTripleBuffer(bool withExplanations = false);
    int buildPropertyTripleBuffer(bool withExplanations = false);
    int getInferredTripleBufferPtr();

    // Returns newline-delimited unsatisfiable class IRIs (empty string if none or not classified).
    std::string buildUnsatisfiableClassBuffer();

    bool isSubClassOf(const std::string& subIri, const std::string& superIri);
    bool isInstanceOf(const std::string& individualIri, const std::string& classIri);
    bool isSatisfiableClass(const std::string& classIri);

    // Justification queries — O(1) lookup from dep chain cache
    std::string getSubClassJustification(const std::string& subIri, const std::string& superIri);
    bool hasNativeJustification(const std::string& subIri, const std::string& superIri);

    // Generic justification queries by EntailmentType (0=Classification, 1=Realization, 2=PropertySubsumption)
    std::string getJustificationByType(const std::string& subIri, const std::string& superIri, int type);
    bool hasJustificationByType(const std::string& subIri, const std::string& superIri, int type);

    // Axiom reverse mapping — convert concept/role tags back to source axiom NTriples
    std::string getAxiomsForConceptTag(int64_t tag);
    std::string getAxiomsForRoleTag(int64_t tag);

    // True when the last classification()/realization() gave up because no task or event was
    // active for the stall threshold (see src/compat/KonStall.h). The instance must be discarded.
    bool stalled() const;
    // Stall threshold in ms (default 60000, 0 disables detection).
    void setStallThresholdMs(int ms);

    // Explicit teardown: drops synced content, ontology and all results (releases memory).
    void reset();

#ifdef NATIVE_DEBUG_BUILD
    // Native-only: load NTriples from a string (bypasses binary protocol).
    bool loadNTriplesStr(const std::string& ntriples, bool forRealization = false);
    // Native-only: encode NTriples into the binary wire format and syncTripleBuffer() it. Returns the sync result.
    int syncNTriplesStr(const std::string& ntriples);
    // Native-only PROTOTYPE: derive a new ontology REVISION from the current one (Konclude's own
    // incremental mechanism: CConcreteOntology(prev, cfg)) and add the given triples to it.
    // The previous revision is kept alive (chain) so incremental classify/realize can reuse it.
    bool addRevisionNTriplesStr(const std::string& ntriples);
    // Native-only: summarize the realizer's per-individual state for roles whose IRI contains substr.
    std::string dumpRoleState(const std::string& roleSubstr) const;
    // Native-only: returns a static JSON snapshot of singleton state.
    const char* dumpState(const char* label = nullptr) const;
    // Native-only: decode last build*TripleBuffer() result into sorted, deduped NTriples lines.
    std::string resultAsSortedNTriples() const;
#endif

private:
    struct Impl;
    Impl* mImpl;
    static bool runPipeline(Impl* impl, bool includeRealization);
    // Decode the wire format and map the triples into mImpl->mOntology (fresh, empty ontology expected).
    void buildOntology(const void* triplePtr, int tripleCount, const void* strTablePtr, int strTableLen, bool forRealization);
    // Make the loaded ontology reflect the synced content for the requested load variant.
    bool ensureBuilt(bool forRealization);
    int syncBuffers(const void* triplePtr, int tripleCount, const void* strTablePtr, int strTableLen);
};
