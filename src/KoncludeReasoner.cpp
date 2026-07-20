// KoncludeReasoner.cpp — implementation of the KoncludeReasoner Embind wrapper.
//
// Architecture:
//   - Pimpl pattern: all Konclude state lives in Impl.
//   - loadTripleBuffer: binary-protocol input; decode intern table + triple IDs into librdf model.
//   - classify: drive preprocessing + precomputation + classification through
//     CReasonerManagerThread::prepareOntology (synchronous in WASM via patch-002).
//   - buildInferredTripleBuffer: walk CTaxonomy + realization and emit a binary combined buffer.
//   - isConsistent: query CConsistence::isOntologyConsistent().
//   - reset: destroy and recreate Impl.

#include "KoncludeReasoner.h"
#include "QtCompat.h"

#include <unordered_map>
#include <unordered_set>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <random>

// ─── Konclude kernel headers ────────────────────────────────────────────────

// Ontology
#include "Reasoner/Ontology/CConcreteOntology.h"
#include "Reasoner/Ontology/COntologyProcessingStep.h"
#include "Reasoner/Ontology/COntologyProcessingStepRequirement.h"
#include "Reasoner/Ontology/COntologyProcessingStepVector.h"
#include "Reasoner/Ontology/COntologyProcessingStatus.h"

// Generator / Builder
#include "Reasoner/Generator/CConcreteOntologyBasementBuilder.h"
#include "Reasoner/Generator/CConcreteOntologyUpdateCollectorBuilder.h"
#include "Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.h"

// Parser
#include "Parser/CRDFRedlandRaptorParser.h"

// Taxonomy / Classification / Consistence
#include "Reasoner/Taxonomy/CTaxonomy.h"
#include "Reasoner/Taxonomy/CHierarchyNode.h"
#include "Reasoner/Classification/CClassification.h"
#include "Reasoner/Classification/CClassConceptClassification.h"
#include "Reasoner/Consistence/CConsistence.h"

// Processing step data
#include "Reasoner/Ontology/COntologyProcessingStepDataVector.h"
#include "Reasoner/Ontology/COntologyProcessingStepData.h"

// Config
#include "Config/CGlobalConfigurationBase.h"
#include "Config/CConfigurationGroup.h"
#include "Config/CConvertBooleanConfigType.h"
#include "Config/CStringConfigType.h"
#include "Config/CIntegerConfigType.h"
#include "Control/Command/CReasonerConfigurationGroup.h"

// Reasoner manager
#include "Reasoner/Kernel/Manager/CReasonerManagerThread.h"

// Caches started in threadStarted() but not stopped by upstream threadStopped()
#include "Reasoner/Kernel/Cache/CComputedConsequencesCache.h"
#include "Reasoner/Kernel/Cache/COccurrenceStatisticsCache.h"


// Classifier
#include "Reasoner/Classifier/CClassificationManager.h"
#include "Reasoner/Classifier/CConfigDependedSubsumptionClassifierFactory.h"

// Concept name (IRI)
#include "Reasoner/Ontology/CIRIName.h"

// ABox / Realization
#include "Reasoner/Ontology/CABox.h"
#include "Reasoner/Ontology/CIndividualReference.h"
#include "Reasoner/Realizer/CRealizerThread.h"
#include "Reasoner/Realization/CRealization.h"
#include "Reasoner/Realization/CConceptRealization.h"
#include "Reasoner/Realization/CRoleRealization.h"
#include "Reasoner/Realization/CConceptRealizationInstantiatedVisitor.h"
#include "Reasoner/Realization/CConceptRealizationConceptVisitor.h"
#include "Reasoner/Realization/CRoleRealizationInstantiatedVisitor.h"
#include "Reasoner/Realization/CRoleRealizationInstanceVisitor.h"
#include "Reasoner/Realization/CRoleRealizationIndividualVisitor.h"
#include "Reasoner/Realization/CRoleRealizationRoleVisitor.h"

#include <functional>
#include <tuple>
#include <queue>

// Justification index
#include "JustificationCache.h"

// ─── Namespaces ──────────────────────────────────────────────────────────────

using namespace Konclude;
using namespace Konclude::Reasoner::Ontology;
using namespace Konclude::Reasoner::Taxonomy;
using namespace Konclude::Reasoner::Classification;
using namespace Konclude::Reasoner::Consistence;
using namespace Konclude::Reasoner::Generator;
using namespace Konclude::Reasoner::Classifier;
using namespace Konclude::Reasoner::Kernel::Manager;
using namespace Konclude::Reasoner::Realization;
using namespace Konclude::Reasoner::Realizer;
using namespace Konclude::Config;
using namespace Konclude::Control::Command;


// ─── WasmRealizationManager ───────────────────────────────────────────────────
// Upstream CRealizationManager::~CRealizationManager() is empty — realizer
// threads are never joined. This subclass joins all realizers at teardown so
// CThread::~CThread() → stopThread(true) runs before ~Impl() frees mOntology.
// Realizer threads accumulate across classify() calls and are joined only here.

class WasmRealizationManager : public CRealizationManager {
public:
    using CRealizationManager::CRealizationManager;

    // Realizer threads that have been stopped (pthread joined) but not yet freed.
    // Deletion is deferred to ~WasmRealizationManager() so that Emscripten's async
    // cmd=cleanupThread callback — which fires on the JS event loop AFTER classify()
    // returns — cannot call a virtual method through a freed vtable pointer.
    std::vector<CRealizerThread*> mStoppedRealizers;

    // Called from reset() after classify() returns (OPSROLEREALIZE complete).
    // Joins all realizer threads before the next ontology is created, preventing
    // OPSINITREALIZE on call N+1 from routing work to a stale realizer from call N.
    void stopAndClearRealizers() {
        for (CRealizer* r : mRealizerSet) {
            CRealizerThread* rt = static_cast<CRealizerThread*>(r);
            // Join the pthread but keep the C++ object alive.  Emscripten posts
            // cmd=cleanupThread asynchronously after the worker exits; that message
            // is processed on the JS event loop after classify() returns and could
            // call back into WASM with a pointer to this object.  Freeing the object
            // here would corrupt the vtable and cause getWasmTableEntry(0x72676E73).
            // waitSynchronization() is NOT called here: it posts a C++ semaphore event
            // to the thread's queue and blocks until the thread processes it.  If the
            // thread has already crashed (invokeEntryPoint catch path), the queue is
            // never drained and the semaphore is never released → permanent hang.
            // stopThread(true) → pthread_join is sufficient: the thread writes its
            // exit-status futex (via __emscripten_thread_exit in the catch handler)
            // and Atomics.waitAsync in pthread_join resolves.
            rt->stopThread(true);
            mStoppedRealizers.push_back(rt);
        }
        mRealizerSet.clear();
    }

    ~WasmRealizationManager() override {
        stopAndClearRealizers();
        // Now safe to free: all pthreads joined, final teardown, no more callbacks.
        for (CRealizerThread* rt : mStoppedRealizers) {
            delete rt;
        }
        mStoppedRealizers.clear();
    }
};

// ─── WasmReasonerManagerThread ───────────────────────────────────────────────
// Subclass that exposes classificationMan so it can be injected after init,
// and overrides thread lifecycle to ensure all background threads are joined
// before ~Impl() frees mOntology.

class WasmReasonerManagerThread : public CReasonerManagerThread {
public:
    WasmReasonerManagerThread() : CReasonerManagerThread(nullptr) {}

    void setClassificationManager(CClassificationManager* mgr) {
        classificationMan = mgr;
    }

    void stopAndClearRealizers() {
        if (mRealizationManager) {
            static_cast<WasmRealizationManager*>(mRealizationManager)->stopAndClearRealizers();
        }
    }

    // Replace stock CRealizationManager with WasmRealizationManager so that
    // realizer threads are joined when the reasoner shuts down.
    CReasonerManager* initializeManager(CConfigurationProvider* configProvider) override {
        CReasonerManagerThread::initializeManager(configProvider);
        // Thread has started but no events processed yet — safe to swap.
        delete mRealizationManager;
        mRealizationManager = new WasmRealizationManager(this);
        // Disable the saturation node expansion cache.  Its saturation results are
        // keyed by concept tag (integer) which recycles across sequential fresh-ontology
        // calls (same concepts → same tags).  After a TBox-only classify call, the cache
        // holds stale saturation results for ABox individuals (no sameAs relationship)
        // that are incorrectly reused by the next sameAs materialize, causing 0 output.
        if (mSatNodeExpCache) {
            mSatNodeExpCache->stopThread(true);
            delete mSatNodeExpCache;
            mSatNodeExpCache = nullptr;
        }
        return this;
    }

    // IU-1: zero out BlockThreadPool before the parent spawns them.
    // initializeManager() reads mBlockThreadPoolThreadCount from config (default 1)
    // then calls startThread() → threadStarted().  Our override intercepts
    // threadStarted() and forces the count to 0 so no QtConcurrent::run()
    // detached threads are created.  The upstream threadStopped() semaphore
    // release/acquire is also guarded by (mBlockThreadPoolThreadCount > 0) so
    // it correctly skips cleanup when count is 0.
    // mBlockThreadPoolThreadCount is protected in CReasonerManagerThread.h.
    void threadStarted() override {
        mBlockThreadPoolThreadCount = 0;
        CReasonerManagerThread::threadStarted();
    }

    // mBackendAssCache (CBackendRepresentativeMemoryCache, a CThread) is created
    // in threadStarted() but never stopped by upstream threadStopped().  Join it
    // here so its thread cannot access freed ontology memory after ~Impl() runs.
    // mBackendAssCache, mCompConsCache, mOccStatsCache are all protected fields
    // in CReasonerManagerThread.h — verified against upstream header.
    void threadStopped() override {
#ifdef WASM_VERBOSE_LOGGING
        fprintf(stderr, "{dbg} WasmReasonerManagerThread::threadStopped() — manager thread exiting!\n");
#endif
        CReasonerManagerThread::threadStopped();
        // mBackendAssCache, mCompConsCache, mOccStatsCache are created in
        // threadStarted() but not stopped by upstream threadStopped().
        if (mBackendAssCache) {
            mBackendAssCache->stopThread(true);
            delete mBackendAssCache;
            mBackendAssCache = nullptr;
        }
        if (mCompConsCache) {
            mCompConsCache->stopThread(true);
            delete mCompConsCache;
            mCompConsCache = nullptr;
        }
        if (mOccStatsCache) {
            mOccStatsCache->stopThread(true);
            delete mOccStatsCache;
            mOccStatsCache = nullptr;
        }
    }
};

// ─── Minimal CConfigurationProvider stub ─────────────────────────────────────
// CReasonerManagerThread::initializeManager needs a CConfigurationProvider.
// We supply a minimal one backed by a CGlobalConfigurationBase with an empty group.

class WasmConfigProvider : public CConfigurationProvider {
public:
    WasmConfigProvider() {
        mGroup = new CReasonerConfigurationGroup();
        mConfig = new CGlobalConfigurationBase(mGroup, 1);
        // Disable saturation-only subsumer extraction to force the full KPSet tableau classifier.
        // Without this, Roberts-family ontologies hit the saturation-only fast path which misses
        // role-subproperty+hasValue subsumptions (e.g. ForefatherOfRobert ⊑ AncestorOfRobert).
        CConfigData* d = mConfig->createAndSetConfig(
            "Konclude.Calculation.Classification.SaturationSubsumerExtraction");
        if (d) {
            CConvertBooleanConfigType* bt =
                dynamic_cast<CConvertBooleanConfigType*>(d->getConfigType());
            if (bt) bt->readFromBoolean(false);
        }
        // Use all available hardware threads (capped at PTHREAD_POOL_SIZE=8).
        CConfigData* pc = mConfig->createAndSetConfig("Konclude.Calculation.ProcessorCount");
        if (pc) {
            CStringConfigType* st = dynamic_cast<CStringConfigType*>(pc->getConfigType());
            if (st) st->setValue("AUTO");
        }
        // Disable BackendAssCache slot-update deferral.
        // The deferral counter (mSlotUpdateWaitingIncreaseCount) grows with each call.
        // After ~4 calls it reaches the default max (20), meaning 20 write events to a
        // fresh ontology must accumulate before a new slot is published to readers.
        // This prevents the sameAs detection from seeing updated association data across
        // the multiple retrieval rounds it requires, causing 0 owl:sameAs output.
        // Setting the max to 0 forces a slot update on every write event — correct for
        // our single-ontology-per-call sequential WASM use case.
        CConfigData* swc = mConfig->createAndSetConfig(
            "Konclude.Cache.RepresentativeBackendCache.SlotUpdateWaitingIncreaseMaximumCount");
        if (swc) {
            CIntegerConfigType* it = dynamic_cast<CIntegerConfigType*>(swc->getConfigType());
            if (it) it->setValue(0);
        }
        // Allow unchanged labels to be treated as compatible when the association update ID
        // has advanced (mNextIndiUpdateId accumulates across calls). Without this, when
        // mNextIndiUpdateId is large after n prior calls, the ID-mismatch check at line 1662
        // sets incompatibleChanges=true which can abort detSameNeighbourCompletion, preventing
        // owl:sameAs triples from being produced. Since WASM runs one ontology per call
        // sequentially, treating unchanged labels as compatible is safe.
        CConfigData* ulc = mConfig->createAndSetConfig(
            "Konclude.Cache.RepresentativeBackendCache.InterpretUnchangedLabelsAsCompatibleIndividualAssociationUpdates");
        if (ulc) {
            CConvertBooleanConfigType* bt = dynamic_cast<CConvertBooleanConfigType*>(ulc->getConfigType());
            if (bt) bt->readFromBoolean(true);
        }
    }
    ~WasmConfigProvider() {
        delete mConfig;
        delete mGroup;
    }
    CConfigurationBase* getCurrentConfiguration() override {
        return mConfig;
    }
private:
    CReasonerConfigurationGroup* mGroup;
    CGlobalConfigurationBase*    mConfig;
};

// ─── Impl ─────────────────────────────────────────────────────────────────────

struct KoncludeReasoner::Impl {
    // Configuration infrastructure
    WasmConfigProvider*           mConfigProvider   = nullptr;
    CGlobalConfigurationBase*     mBasementConfig   = nullptr;

    // Ontology objects
    CConcreteOntology*            mOntology         = nullptr;
    // Kept alive one extra reset() cycle so KPSet pthreads can finish their
    // Emscripten exit-cleanup before the vtable is freed.
    CConcreteOntology*            mPreviousOntology = nullptr;
    // Kept alive two reset() cycles to prevent the allocator from reusing freed
    // ontology addresses for new ontology objects.  The singleton thread caches
    // (mOntItemHash in precomputer/preprocessor/classifier) are keyed by pointer;
    // if a new ontology reuses a freed address, the cache returns a stale entry.
    // Holding the address for two cycles ensures a fresh allocation.
    CConcreteOntology*            mPreviousPreviousOntology = nullptr;

    // Reasoning infrastructure
    WasmReasonerManagerThread*    mReasonerManager  = nullptr;
    CClassificationManager*       mClassManager     = nullptr;

    // Configured parallel worker count (set after initializeManager).
    int mProcessorCount = 1;

    // Result flags
    bool mClassified          = false;
    bool mLoadError           = false;
    bool mRealized            = false;

    // Buffer for buildInferredTripleBuffer() output
    std::vector<uint8_t> mResultBuffer;
    int mResultBufferPtr = 0;

    // Per-call workaround state — populated by loadTripleBuffer, consumed by build* and consistency
    std::vector<std::pair<std::string,std::string>> mEquivPropPairs;
    bool mTriviallyInconsistent = false;

    // Unit 1: FP/IFP multi-filler sameAs pairs
    std::vector<std::pair<std::string,std::string>> mFpIfpSameAsPairs;

    // Unit 2: someValuesFrom post-processing data
    struct SvfEntry { std::string property; std::string fillerClass; };
    std::unordered_map<std::string, std::vector<SvfEntry>> mSvfIndex;     // classIri → entries
    std::unordered_map<std::string, std::vector<std::string>> mSvfRoleAssertions; // "subj\0prop" → [objs]
    std::vector<std::pair<std::string,std::string>> mSvfABoxTypes;       // (indiIri, classIri)

    // Unit 3: disjointUnionOf memberships
    std::vector<std::pair<std::string,std::string>> mDisjointUnionOf;    // (classIri, memberIri)

    // Unit 4 (plan-048): owl:oneOf nominal class memberships
    std::vector<std::pair<std::string,std::string>> mOneOfMemberships;   // (classIri, memberIri)

    // Unit 5 (plan-048): minCardinality restrictions
    struct MinCardEntry {
        std::string classIri;
        std::string propIri;
        int         minCard;
        std::string qualClassIri;  // empty = unqualified
    };
    std::vector<MinCardEntry> mMinCardRestrictions;

    // Unit 5 (plan-048): owl:differentFrom pairs (symmetric, for minCard distinctness check)
    std::unordered_map<std::string, std::unordered_set<std::string>> mDifferentFromPairs;

    // Unit 5 (plan-048): role assertions for minCard properties (unconditional — not gated on mSvfIndex)
    std::unordered_map<std::string, std::vector<std::string>> mMinCardRoleAssertions;  // "subj\0prop" → [objs]

    // IRI→concept/individual indexes — built once after classification/realization
    // for O(1) lookup in isSubClassOf/isInstanceOf/isSatisfiableClass.
    std::unordered_map<std::string, CConcept*> mConceptByIri;
    std::unordered_map<std::string, CIndividual*> mIndividualByIri;

    // Reverse map: concept tag → IRI (built from mConceptByIri after classification)
    std::unordered_map<int64_t, std::string> mTagToIri;

    Impl() {
        mConfigProvider = new WasmConfigProvider();

        mBasementConfig = static_cast<CGlobalConfigurationBase*>(
            mConfigProvider->getCurrentConfiguration());

        // ── Build working ontology with basement directly applied ──
        // Use self-contained constructor so getBasementOntology() == mOntology.
        // This prevents countActiveEntites() from calling referenceDataBoxes()
        // which would wipe all SubClassOf axioms added by mapTriples().
        buildFreshOntology();

        // ── Initialise the reasoner manager (synchronous in WASM via patch-002) ──
        mReasonerManager = new WasmReasonerManagerThread();
        mReasonerManager->initializeManager(mConfigProvider);
        mProcessorCount = CThread::idealThreadCount();

        // ── Initialise the classification manager and inject it into the reasoner ──
        CConfigDependedSubsumptionClassifierFactory* classFactory =
            new CConfigDependedSubsumptionClassifierFactory(mReasonerManager);
        mClassManager = new CClassificationManager();
        mClassManager->initializeManager(classFactory, mConfigProvider);
        // Inject the classification manager through the subclass accessor.
        mReasonerManager->setClassificationManager(mClassManager);
    }

    ~Impl() {
        // Stop all threads BEFORE freeing the ontology.
        // threadStopped() (overridden) joins the realizer and BackendAssCache threads.
        delete mReasonerManager; // joins CReasonerManagerThread; threadStopped() runs
        delete mClassManager;
        delete mPreviousPreviousOntology;
        delete mPreviousOntology;
        delete mOntology;        // safe: all background threads have stopped
        delete mConfigProvider;
    }

    void buildFreshOntology() {
        mOntology = new CConcreteOntology(mBasementConfig);
        // Each call must have a unique ontology ID.  CTerminology::CTerminology()
        // initialises mTerminologyID = 0 for every new object.  BackendAssCache keys
        // its per-ontology state by this ID (mOntologyIdentifierDataHash and
        // mFixedOntologyIdentifierDataHash are both hash-maps keyed by cint64 ontologyID).
        // A sequential counter is provably unsafe: any mechanism keyed on ID values
        // (hash bucket distribution, stale-entry lookup, saturation concept hashing, etc.)
        // can produce periodic collisions at predictable call counts.  A 63-bit random ID
        // eliminates collision as a root cause.
        //
        // Single-caller note: buildFreshOntology() is always called from the Worker's
        // single JS dispatch thread; all WASM calls are serialised by the Worker.  No mutex
        // is needed here.  If future architecture ever calls this from multiple threads,
        // add a std::mutex guard around gen().
        static std::mt19937_64 gen = []() {
            try {
                return std::mt19937_64(std::random_device{}());
            } catch (...) {
                auto t = std::chrono::steady_clock::now().time_since_epoch().count();
                auto a = std::hash<void*>{}(reinterpret_cast<void*>(&gen));
                return std::mt19937_64(static_cast<uint64_t>(t) ^ a);
            }
        }();
        // Mask high bit: cint64 is int64_t; keep IDs positive.
        mOntology->setOntologyID(static_cast<qint64>(gen() & 0x7FFFFFFFFFFFFFFFull));
        CConcreteOntologyBasementBuilder* bb =
            new CConcreteOntologyBasementBuilder(mOntology);
        bb->initializeBuilding();
        bb->buildOntologyBasement();
        bb->completeBuilding();
        delete bb;
    }

    // Reset: prepare a fresh ontology for the next classify() call.
    // Realizers from the previous call are already joined at the end of classify(),
    // so no stopAndClearRealizers() call is needed here.
    void reset() {
        delete mPreviousPreviousOntology;
        mPreviousPreviousOntology = mPreviousOntology;
        mPreviousOntology = mOntology;
        mOntology = nullptr;
        buildFreshOntology();
        mClassified         = false;
        mLoadError          = false;
        mRealized           = false;
        mResultBuffer.clear();
        mResultBufferPtr = 0;
        mEquivPropPairs.clear();
        mTriviallyInconsistent = false;
        mFpIfpSameAsPairs.clear();
        mSvfIndex.clear();
        mSvfRoleAssertions.clear();
        mSvfABoxTypes.clear();
        mDisjointUnionOf.clear();
        mOneOfMemberships.clear();
        mMinCardRestrictions.clear();
        mDifferentFromPairs.clear();
        mMinCardRoleAssertions.clear();
        mConceptByIri.clear();
        mIndividualByIri.clear();
        mTagToIri.clear();
        JustificationCache::instance().clear();
    }

    void buildConceptIndex() {
        mConceptByIri.clear();
        if (!mOntology) return;
        CTaxonomy* taxonomy = mOntology->getConceptTaxonomy();
        if (!taxonomy) return;
        QHash<CConcept*, CHierarchyNode*>* nodeHash = taxonomy->getConceptHierarchyNodeHash();
        if (!nodeHash) return;
        for (auto it = nodeHash->constBegin(), end = nodeHash->constEnd(); it != end; ++it) {
            CConcept* c = it.key();
            if (!c) continue;
            QString iri = CIRIName::getRecentIRIName(c->getClassNameLinker());
            if (iri.empty()) continue;
            mConceptByIri[std::string(iri)] = c;
        }
    }

    void buildIndividualIndex() {
        mIndividualByIri.clear();
        if (!mOntology) return;
        CIndividualVector* indiVec = mOntology->getABox()->getIndividualVector(false);
        if (!indiVec) return;
        qint64 count = indiVec->getItemCount();
        for (qint64 i = 0; i < count; ++i) {
            CIndividual* indi = indiVec->getData(i);
            if (!indi) continue;
            QString q = CIRIName::getRecentIRIName(indi->getIndividualNameLinker());
            if (q.empty()) continue;
            mIndividualByIri[std::string(q)] = indi;
        }
    }

    // Build tag→IRI reverse map from mConceptByIri (after classification).
    // Called once before classify(). Maps GCI trigger concept tags to axiom descriptors
    // Build reverse tag→IRI map from mConceptByIri (populated after classification).
    void buildAxiomMap() {
        mTagToIri.clear();
        for (auto& [iri, concept] : mConceptByIri) {
            mTagToIri[concept->getConceptTag()] = iri;
        }
        fprintf(stderr, "{info} buildAxiomMap: %zu tag-to-IRI entries\n", mTagToIri.size());
    }

    // Resolve dep chain concept tags to source axiom NTriples.
    // For each dep tag that maps to a named class IRI, emit the subsumption
    // triple that connects it to the queried subsumption chain.
    std::string getSubClassJustification(const std::string& subIri, const std::string& superIri) {
        if (!mClassified) return "";

        auto subIt = mConceptByIri.find(subIri);
        auto supIt = mConceptByIri.find(superIri);
        if (subIt == mConceptByIri.end() || supIt == mConceptByIri.end()) return "";

        int64_t subTag = subIt->second->getConceptTag();
        int64_t supTag = supIt->second->getConceptTag();

        // Direct lookup
        const auto* depTags = JustificationCache::instance().lookup(subTag, supTag);
        if (depTags && !depTags->empty()) {
            // The cache entry confirms this subsumption was derived.
            // Return the queried subsumption as the justification axiom.
            return "<" + subIri + "> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <" + superIri + "> .\n";
        }

        // Transitive: BFS through taxonomy, collect per-edge justifications
        if (!mOntology) return "";
        CTaxonomy* taxonomy = mOntology->getConceptTaxonomy();
        if (!taxonomy) return "";

        QHash<CConcept*, CHierarchyNode*>* nodeHash = taxonomy->getConceptHierarchyNodeHash();
        if (!nodeHash) return "";

        auto subNodeIt = nodeHash->find(subIt->second);
        auto supNodeIt = nodeHash->find(supIt->second);
        if (subNodeIt == nodeHash->end() || supNodeIt == nodeHash->end()) return "";

        CHierarchyNode* startNode = subNodeIt.value();
        CHierarchyNode* targetNode = supNodeIt.value();

        std::unordered_map<CHierarchyNode*, CHierarchyNode*> parentMap;
        std::queue<CHierarchyNode*> bfsQ;
        bfsQ.push(startNode);
        parentMap[startNode] = nullptr;
        bool found = false;

        while (!bfsQ.empty() && !found) {
            CHierarchyNode* cur = bfsQ.front();
            bfsQ.pop();
            QSet<CHierarchyNode*>* parents = cur->getParentNodeSet();
            if (!parents) continue;
            for (auto pIt = parents->constBegin(), pEnd = parents->constEnd(); pIt != pEnd; ++pIt) {
                CHierarchyNode* p = *pIt;
                if (parentMap.count(p)) continue;
                parentMap[p] = cur;
                if (p == targetNode) { found = true; break; }
                bfsQ.push(p);
            }
        }

        if (!found) return "";

        // Walk path and emit edge triples
        std::string result;
        CHierarchyNode* cur = targetNode;
        while (cur != startNode) {
            CHierarchyNode* child = parentMap[cur];
            CConcept* childConcept = child->getOneEquivalentConcept();
            CConcept* parentConcept = cur->getOneEquivalentConcept();
            if (childConcept && parentConcept) {
                auto childIriIt = mTagToIri.find(childConcept->getConceptTag());
                auto parentIriIt = mTagToIri.find(parentConcept->getConceptTag());
                if (childIriIt != mTagToIri.end() && parentIriIt != mTagToIri.end()) {
                    result += "<" + childIriIt->second + "> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <" + parentIriIt->second + "> .\n";
                }
            }
            cur = child;
        }
        return result;
    }

    bool hasNativeJustification(const std::string& subIri, const std::string& superIri) {
        if (!mClassified) return false;
        auto subIt = mConceptByIri.find(subIri);
        auto supIt = mConceptByIri.find(superIri);
        if (subIt == mConceptByIri.end() || supIt == mConceptByIri.end()) return false;
        return JustificationCache::instance().lookup(
            subIt->second->getConceptTag(), supIt->second->getConceptTag()) != nullptr;
    }
};

// ─── KoncludeReasoner public API ──────────────────────────────────────────────

KoncludeReasoner::KoncludeReasoner()
    : mImpl(new Impl())
{}

KoncludeReasoner::~KoncludeReasoner() {
    delete mImpl;
}

// loadTripleBuffer ─────────────────────────────────────────────────────────────
//
// See KoncludeReasoner.h for the wire format comment.
//
void KoncludeReasoner::loadTripleBuffer(int triplePtr, int tripleCount, int strTablePtr, int strTableLen, bool forRealization) {
#ifdef WASM_VERBOSE_LOGGING
    auto t0 = std::chrono::steady_clock::now();
#endif

    if (!strTablePtr || !triplePtr) {
        fprintf(stderr, "{warn} KoncludeReasoner >> loadTripleBuffer called with null pointer\n");
        return;
    }

    // ── Decode the string table ──────────────────────────────────────────────
    // Layout: [count:u32][offset0:u32 … offsetN:u32][UTF-8 string data...]
    const uint32_t* hdr  = reinterpret_cast<const uint32_t*>(strTablePtr);
    uint32_t        count = hdr[0];

    // Pointer to the start of the string-data section (after the header).
    const char* strData = reinterpret_cast<const char*>(strTablePtr) + 4 + 4 * count;
    int strDataLen = strTableLen - 4 - static_cast<int>(4 * count);

    // Build O(1) lookup: term index → (char* start, size_t len)
    struct TermEntry { const char* ptr; size_t len; };
    std::vector<TermEntry> terms(count);
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t off = hdr[1 + i];
        uint32_t end = (i + 1 < count) ? hdr[2 + i]
                                        : static_cast<uint32_t>(strDataLen);
        terms[i] = { strData + off, end - off };
    }

    // ── Build CRedlandStoredTriplesData (world / storage / model) ────────────
    // Pattern mirrors CRDFRedlandRaptorParser::getUpdatingTripleData +
    // parseTriples() in src/compat/overrides/CRDFRedlandRaptorParser.cpp.
    CConcreteOntologyUpdateCollectorBuilder* builder =
        new CConcreteOntologyUpdateCollectorBuilder(mImpl->mOntology);
    builder->initializeBuilding();

    CRedlandStoredTriplesData* tripleData = new CRedlandStoredTriplesData();
    tripleData->initTriplesData(CTRIPLES_DATA_UPDATE_TYPE::TRIPLES_DATA_ADDITION, nullptr);

    librdf_world* world = librdf_new_world();
    librdf_world_open(world);
    tripleData->setRedlandWorldData(world);

    librdf_storage* indexedStorage = librdf_new_storage(world, "hashes", NULL,
        "hash-type='memory',index-predicates='yes'");
    tripleData->setRedlandIndexedStorageData(indexedStorage);

    librdf_model* model = librdf_new_model(world, indexedStorage, NULL);
    tripleData->setRedlandIndexedModelData(model);

    if (!model) {
        delete tripleData;
        builder->completeBuilding();
        delete builder;
        mImpl->mLoadError = true;
        return;
    }

    // ── Helper: build a librdf_node* for a given uint32 intern ID ────────────
    auto makeNode = [&](uint32_t id) -> librdf_node* {
        uint32_t typeTag = id >> 30;
        uint32_t idx     = id & 0x3FFFFFFFu;
        if (idx >= count) return nullptr;

        const char* data = terms[idx].ptr;
        size_t       len  = terms[idx].len;

        if (typeTag == 0) {
            // NamedNode: string is the plain IRI
            // librdf_new_node_from_uri_string expects a null-terminated string.
            std::string iri(data, len);
            return librdf_new_node_from_uri_string(world,
                reinterpret_cast<const unsigned char*>(iri.c_str()));
        } else if (typeTag == 1) {
            // BlankNode: string is the blank-node identifier
            std::string bname(data, len);
            return librdf_new_node_from_blank_identifier(world,
                reinterpret_cast<const unsigned char*>(bname.c_str()));
        } else {
            // Literal: "value\0datatype\0language" within [data, data+len)
            // Split on null bytes.
            const char* p = data;
            const char* end = data + len;

            // value: up to first \0
            const char* valEnd = reinterpret_cast<const char*>(memchr(p, '\0', end - p));
            if (!valEnd) valEnd = end;
            std::string value(p, valEnd - p);

            // datatype: next segment
            std::string datatype;
            if (valEnd < end) {
                const char* dtStart = valEnd + 1;
                const char* dtEnd = reinterpret_cast<const char*>(memchr(dtStart, '\0', end - dtStart));
                if (!dtEnd) dtEnd = end;
                datatype = std::string(dtStart, dtEnd - dtStart);
            }

            // language: remaining segment
            std::string language;
            if (!datatype.empty() || (valEnd < end)) {
                const char* dtEnd2 = (!datatype.empty())
                    ? (valEnd + 1 + datatype.size() + 1)
                    : (valEnd + 1 + 1);
                if (dtEnd2 < end) {
                    const char* langEnd = reinterpret_cast<const char*>(memchr(dtEnd2, '\0', end - dtEnd2));
                    if (!langEnd) langEnd = end;
                    language = std::string(dtEnd2, langEnd - dtEnd2);
                }
            }

            if (!datatype.empty()) {
                librdf_uri* typeUri = librdf_new_uri(world,
                    reinterpret_cast<const unsigned char*>(datatype.c_str()));
                librdf_node* n = librdf_new_node_from_typed_literal(world,
                    reinterpret_cast<const unsigned char*>(value.c_str()),
                    language.empty() ? nullptr : language.c_str(),
                    typeUri);
                librdf_free_uri(typeUri);
                return n;
            } else {
                return librdf_new_node_from_literal(world,
                    reinterpret_cast<const unsigned char*>(value.c_str()),
                    language.empty() ? nullptr : language.c_str(),
                    0);
            }
        }
    };

    // ── Unit 1 pre-scan: FP/IFP multi-filler detection (before insertion) ───────
    // Only active when forRealization=true (materialize/whatIf paths).
    // Mirrors TS computeFpIfpPreprocessing: skip FP/IFP declarations during
    // insertion to prevent ALIF+ hang in WASM saturation.
    // Skipped for consistency/classify paths to preserve native IFP semantics.
    const uint32_t* triples = reinterpret_cast<const uint32_t*>(triplePtr);

    uint32_t fpPreRdfTypeIdx = UINT32_MAX, fpPreFpIdx = UINT32_MAX, fpPreIfpIdx = UINT32_MAX;
    std::unordered_set<uint64_t> fpIfpDeclSkipSet;  // encoded as (propTermIdx << 32) | typeTermIdx
    {
        auto fpFindTerm = [&](const char* iri, size_t len) -> uint32_t {
            for (uint32_t i = 0; i < count; ++i)
                if (terms[i].len == len && memcmp(terms[i].ptr, iri, len) == 0) return i;
            return UINT32_MAX;
        };
        static const char sfpRdfType[] = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        static const char sfpFp[]      = "http://www.w3.org/2002/07/owl#FunctionalProperty";
        static const char sfpIfp[]     = "http://www.w3.org/2002/07/owl#InverseFunctionalProperty";
        fpPreRdfTypeIdx = fpFindTerm(sfpRdfType, sizeof(sfpRdfType) - 1);
        fpPreFpIdx      = fpFindTerm(sfpFp,      sizeof(sfpFp)      - 1);
        fpPreIfpIdx     = fpFindTerm(sfpIfp,     sizeof(sfpIfp)     - 1);

        if (forRealization && fpPreRdfTypeIdx != UINT32_MAX && (fpPreFpIdx != UINT32_MAX || fpPreIfpIdx != UINT32_MAX)) {
            std::unordered_set<uint32_t> fpPropIdxsPre, ifpPropIdxsPre;
            for (int i = 0; i < tripleCount; ++i) {
                uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                if (pId != fpPreRdfTypeIdx || (sId >> 30) != 0 || (oId >> 30) != 0) continue;
                uint32_t oi = oId & 0x3FFFFFFFu;
                if (fpPreFpIdx  != UINT32_MAX && oi == fpPreFpIdx)  fpPropIdxsPre.insert(sId & 0x3FFFFFFFu);
                if (fpPreIfpIdx != UINT32_MAX && oi == fpPreIfpIdx) ifpPropIdxsPre.insert(sId & 0x3FFFFFFFu);
            }
            auto scanPropPairs = [&](uint32_t propIdx, bool bySubj, uint32_t typeTermIdx) {
                std::unordered_map<uint32_t, std::vector<uint32_t>> byGroup;
                for (int i = 0; i < tripleCount; ++i) {
                    uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                    if (pId != propIdx || (sId >> 30) != 0 || (oId >> 30) != 0) continue;
                    uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                    if (si >= count || oi >= count) continue;
                    uint32_t key = bySubj ? si : oi;
                    uint32_t val = bySubj ? oi : si;
                    byGroup[key].push_back(val);
                }
                bool hasMulti = false;
                for (const auto& [k, vals] : byGroup) {
                    if (vals.size() < 2) continue;
                    hasMulti = true;
                    for (size_t ii = 0; ii < vals.size(); ++ii)
                        for (size_t jj = ii+1; jj < vals.size(); ++jj) {
                            if (vals[ii] >= count || vals[jj] >= count) continue;
                            std::string a(terms[vals[ii]].ptr, terms[vals[ii]].len);
                            std::string b(terms[vals[jj]].ptr, terms[vals[jj]].len);
                            mImpl->mFpIfpSameAsPairs.push_back({a, b});
                            mImpl->mFpIfpSameAsPairs.push_back({b, a});
                        }
                }
                if (hasMulti)
                    fpIfpDeclSkipSet.insert(
                        (static_cast<uint64_t>(propIdx) << 32) | typeTermIdx);
            };
            for (uint32_t p : fpPropIdxsPre)  scanPropPairs(p, true,  fpPreFpIdx);
            for (uint32_t p : ifpPropIdxsPre) scanPropPairs(p, false, fpPreIfpIdx);
        }
    }

    // ── Insert triples into model + CXLinker ─────────────────────────────────
    CXLinker<librdf_statement*>* statementLinker = tripleData->getRedlandStatementLinker();
    CXLinker<librdf_statement*>* lastStatementLinker = nullptr;
    if (statementLinker) {
        lastStatementLinker = statementLinker->getLastListLink();
    }

    for (int i = 0; i < tripleCount; ++i) {
        uint32_t sId = triples[i * 3 + 0];
        uint32_t pId = triples[i * 3 + 1];
        uint32_t oId = triples[i * 3 + 2];

        // Unit 1: skip FP/IFP declarations for multi-filler properties (ALIF+ hang prevention)
        if (!fpIfpDeclSkipSet.empty() && pId == fpPreRdfTypeIdx &&
                (sId >> 30) == 0 && (oId >> 30) == 0) {
            uint64_t key = (static_cast<uint64_t>(sId & 0x3FFFFFFFu) << 32) |
                           (oId & 0x3FFFFFFFu);
            if (fpIfpDeclSkipSet.count(key)) continue;
        }

        librdf_node* sNode = makeNode(sId);
        librdf_node* pNode = makeNode(pId);
        librdf_node* oNode = makeNode(oId);

        if (!sNode || !pNode || !oNode) {
            if (sNode) librdf_free_node(sNode);
            if (pNode) librdf_free_node(pNode);
            if (oNode) librdf_free_node(oNode);
            continue;
        }

        // librdf_new_statement_from_nodes takes ownership of sNode/pNode/oNode.
        librdf_statement* stmt = librdf_new_statement_from_nodes(world, sNode, pNode, oNode);
        if (!stmt) continue;

        if (!librdf_model_contains_statement(model, stmt)) {
            // Keep a copy in the linker (mapper walks the linker).
            librdf_statement* linkerStmt = librdf_new_statement_from_statement(stmt);
            CXLinker<librdf_statement*>* newLinker = new CXLinker<librdf_statement*>();
            newLinker->initLinker(linkerStmt, nullptr);
            if (statementLinker) {
                lastStatementLinker->setNext(newLinker);
                lastStatementLinker = newLinker;
            } else {
                statementLinker = newLinker;
                lastStatementLinker = newLinker;
            }
            librdf_model_add_statement(model, stmt);
        }
        librdf_free_statement(stmt);
    }
    tripleData->setRedlandStatementLinker(statementLinker);

    // ── Scan for per-call workaround state ───────────────────────────────────
    // Predicates are always NamedNodes (typeTag=0), so encoded ID == term index.
    {
        auto findTermIdx = [&](const char* iri, size_t len) -> uint32_t {
            for (uint32_t i = 0; i < count; ++i)
                if (terms[i].len == len && memcmp(terms[i].ptr, iri, len) == 0) return i;
            return UINT32_MAX;
        };
        static const char S_EQUIV_PROP[] = "http://www.w3.org/2002/07/owl#equivalentProperty";
        static const char S_DIFF_FROM[]  = "http://www.w3.org/2002/07/owl#differentFrom";
        static const char S_COMPL_OF[]   = "http://www.w3.org/2002/07/owl#complementOf";
        static const char S_RDF_TYPE[]   = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        uint32_t equivPropId = findTermIdx(S_EQUIV_PROP, sizeof(S_EQUIV_PROP) - 1);
        uint32_t diffFromId  = findTermIdx(S_DIFF_FROM,  sizeof(S_DIFF_FROM)  - 1);
        uint32_t complOfId   = findTermIdx(S_COMPL_OF,   sizeof(S_COMPL_OF)   - 1);
        uint32_t rdfTypeId   = findTermIdx(S_RDF_TYPE,   sizeof(S_RDF_TYPE)   - 1);

        // For complementOf ABox clash: collect (A,B) pairs and individual type sets
        std::vector<std::pair<uint32_t,uint32_t>> complOfPairs;
        std::unordered_map<uint32_t, std::unordered_set<uint32_t>> indiTypes;

        for (int i = 0; i < tripleCount; ++i) {
            uint32_t sId = triples[i * 3 + 0];
            uint32_t pId = triples[i * 3 + 1];
            uint32_t oId = triples[i * 3 + 2];
            if (pId == equivPropId && equivPropId != UINT32_MAX) {
                if ((sId >> 30) == 0 && (oId >> 30) == 0) {
                    uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                    if (si < count && oi < count)
                        mImpl->mEquivPropPairs.push_back({
                            std::string(terms[si].ptr, terms[si].len),
                            std::string(terms[oi].ptr, terms[oi].len)
                        });
                }
            } else if (pId == diffFromId && diffFromId != UINT32_MAX) {
                if (sId == oId && (sId >> 30) == 0)
                    mImpl->mTriviallyInconsistent = true;
                if ((sId >> 30) == 0 && (oId >> 30) == 0 && sId != oId) {
                    uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                    if (si < count && oi < count) {
                        std::string sIri(terms[si].ptr, terms[si].len);
                        std::string oIri(terms[oi].ptr, terms[oi].len);
                        mImpl->mDifferentFromPairs[sIri].insert(oIri);
                        mImpl->mDifferentFromPairs[oIri].insert(sIri);
                    }
                }
            } else if (pId == complOfId && complOfId != UINT32_MAX) {
                if ((sId >> 30) == 0 && (oId >> 30) == 0) {
                    uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                    if (si == oi)
                        mImpl->mTriviallyInconsistent = true;
                    else if (si < count && oi < count)
                        complOfPairs.push_back({si, oi});
                }
            } else if (pId == rdfTypeId && rdfTypeId != UINT32_MAX) {
                if ((sId >> 30) == 0 && (oId >> 30) == 0) {
                    uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                    if (si < count && oi < count)
                        indiTypes[si].insert(oi);
                }
            }
        }
        // Check: individual typed as both A and B where A owl:complementOf B
        if (!mImpl->mTriviallyInconsistent && !complOfPairs.empty() && !indiTypes.empty()) {
            for (const auto& [aIdx, bIdx] : complOfPairs) {
                for (const auto& entry : indiTypes) {
                    const auto& types = entry.second;
                    if (types.count(aIdx) && types.count(bIdx)) {
                        mImpl->mTriviallyInconsistent = true;
                        break;
                    }
                }
                if (mImpl->mTriviallyInconsistent) break;
            }
        }
    }

    // ── Batch B workaround scan (Units 2=someValuesFrom, 3=disjointUnionOf) ──
    {
        auto findTerm = [&](const char* iri, size_t len) -> uint32_t {
            for (uint32_t i = 0; i < count; ++i)
                if (terms[i].len == len && memcmp(terms[i].ptr, iri, len) == 0) return i;
            return UINT32_MAX;
        };
        static const char sRdfType[]   = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        static const char sRestrict[]  = "http://www.w3.org/2002/07/owl#Restriction";
        static const char sOnProp[]    = "http://www.w3.org/2002/07/owl#onProperty";
        static const char sSvf[]       = "http://www.w3.org/2002/07/owl#someValuesFrom";
        static const char sEquivCls[]  = "http://www.w3.org/2002/07/owl#equivalentClass";
        static const char sSubCls[]    = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
        static const char sDisjUn[]    = "http://www.w3.org/2002/07/owl#disjointUnionOf";
        static const char sRdfFirst[]  = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
        static const char sRdfRest[]   = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
        static const char sOneOf[]     = "http://www.w3.org/2002/07/owl#oneOf";
        static const char sMinCard[]   = "http://www.w3.org/2002/07/owl#minCardinality";
        static const char sMinQCard[]  = "http://www.w3.org/2002/07/owl#minQualifiedCardinality";
        static const char sOnClass[]   = "http://www.w3.org/2002/07/owl#onClass";

        uint32_t rdfTypeIdx = findTerm(sRdfType,  sizeof(sRdfType)  - 1);
        uint32_t restrictIdx= findTerm(sRestrict,  sizeof(sRestrict)  - 1);
        uint32_t onPropIdx  = findTerm(sOnProp,    sizeof(sOnProp)    - 1);
        uint32_t svfIdx     = findTerm(sSvf,       sizeof(sSvf)       - 1);
        uint32_t equivClsIdx= findTerm(sEquivCls,  sizeof(sEquivCls)  - 1);
        uint32_t subClsIdx  = findTerm(sSubCls,    sizeof(sSubCls)    - 1);
        uint32_t disjUnIdx  = findTerm(sDisjUn,    sizeof(sDisjUn)    - 1);
        uint32_t rdfFirstIdx= findTerm(sRdfFirst,  sizeof(sRdfFirst)  - 1);
        uint32_t rdfRestIdx = findTerm(sRdfRest,   sizeof(sRdfRest)   - 1);
        uint32_t oneOfIdx   = findTerm(sOneOf,     sizeof(sOneOf)     - 1);
        uint32_t minCardIdx = findTerm(sMinCard,   sizeof(sMinCard)   - 1);
        uint32_t minQCardIdx= findTerm(sMinQCard,  sizeof(sMinQCard)  - 1);
        uint32_t onClassIdx = findTerm(sOnClass,   sizeof(sOnClass)   - 1);

        // Unit 2: someValuesFrom blank-node structures
        std::unordered_set<uint32_t> svfRestBnodes;          // encoded blank node IDs (typeTag=1)
        std::unordered_map<uint32_t, uint32_t> svfOnPropMap; // bnodeEncId → propTermIdx
        std::unordered_map<uint32_t, uint32_t> svfSvfMap;    // bnodeEncId → fillerTermIdx
        // Unit 3: RDF list traversal maps
        std::unordered_map<uint32_t, uint32_t> rdfFirstMap;  // bnodeEncId → memberTermIdx
        std::unordered_map<uint32_t, uint32_t> rdfRestMap;   // bnodeEncId → nextEncId
        // Unit 4 (plan-048): oneOf heads — classTermIdx → headEncId
        std::unordered_map<uint32_t, uint32_t> oneOfHeadMap;
        // Unit 5 (plan-048): minCardinality literal + onClass on restriction bnodes
        std::unordered_map<uint32_t, uint32_t> minCardValueMap;  // bnodeEncId → litEncId
        std::unordered_map<uint32_t, uint32_t> minQCardValueMap; // bnodeEncId → litEncId
        std::unordered_map<uint32_t, uint32_t> onClassMap;       // bnodeEncId → qualClassTermIdx

        for (int i = 0; i < tripleCount; ++i) {
            uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
            if (rdfTypeIdx != UINT32_MAX && pId == rdfTypeIdx &&
                    (sId >> 30) == 1 && (oId >> 30) == 0) {
                uint32_t oi = oId & 0x3FFFFFFFu;
                if (restrictIdx != UINT32_MAX && oi == restrictIdx) svfRestBnodes.insert(sId);
            } else if (onPropIdx != UINT32_MAX && pId == onPropIdx && (sId >> 30) == 1 && (oId >> 30) == 0) {
                svfOnPropMap[sId] = oId & 0x3FFFFFFFu;
            } else if (svfIdx != UINT32_MAX && pId == svfIdx && (sId >> 30) == 1 && (oId >> 30) == 0) {
                svfSvfMap[sId] = oId & 0x3FFFFFFFu;
            } else if (rdfFirstIdx != UINT32_MAX && pId == rdfFirstIdx && (sId >> 30) == 1 && (oId >> 30) == 0) {
                rdfFirstMap[sId] = oId & 0x3FFFFFFFu;
            } else if (rdfRestIdx != UINT32_MAX && pId == rdfRestIdx && (sId >> 30) == 1) {
                rdfRestMap[sId] = oId;
            } else if (oneOfIdx != UINT32_MAX && pId == oneOfIdx && (sId >> 30) == 0) {
                oneOfHeadMap[sId & 0x3FFFFFFFu] = oId;
            } else if (minCardIdx != UINT32_MAX && pId == minCardIdx && (sId >> 30) == 1 && (oId >> 30) == 2) {
                minCardValueMap[sId] = oId;
            } else if (minQCardIdx != UINT32_MAX && pId == minQCardIdx && (sId >> 30) == 1 && (oId >> 30) == 2) {
                minQCardValueMap[sId] = oId;
            } else if (onClassIdx != UINT32_MAX && pId == onClassIdx && (sId >> 30) == 1 && (oId >> 30) == 0) {
                onClassMap[sId] = oId & 0x3FFFFFFFu;
            }
        }

        // Unit 2: build mSvfIndex (classIri → [{property, fillerClass}])
        {
            std::unordered_map<uint32_t, std::pair<uint32_t,uint32_t>> confirmedRestrictions;
            for (uint32_t bn : svfRestBnodes) {
                auto pit = svfOnPropMap.find(bn);
                auto fit = svfSvfMap.find(bn);
                if (pit != svfOnPropMap.end() && fit != svfSvfMap.end())
                    confirmedRestrictions[bn] = {pit->second, fit->second};
            }
            if (!confirmedRestrictions.empty()) {
                for (int i = 0; i < tripleCount; ++i) {
                    uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                    bool isEquiv = (equivClsIdx != UINT32_MAX && pId == equivClsIdx);
                    bool isSub   = (subClsIdx   != UINT32_MAX && pId == subClsIdx);
                    if (!isEquiv && !isSub) continue;
                    auto addEntry = [&](uint32_t classEncId, uint32_t bnodeEncId) {
                        auto rit = confirmedRestrictions.find(bnodeEncId);
                        if (rit == confirmedRestrictions.end()) return;
                        uint32_t classIdx = classEncId & 0x3FFFFFFFu;
                        uint32_t propIdx  = rit->second.first;
                        uint32_t fillIdx  = rit->second.second;
                        if (classIdx >= count || propIdx >= count || fillIdx >= count) return;
                        std::string cls(terms[classIdx].ptr,  terms[classIdx].len);
                        std::string prop(terms[propIdx].ptr,  terms[propIdx].len);
                        std::string fill(terms[fillIdx].ptr,  terms[fillIdx].len);
                        auto& vec = mImpl->mSvfIndex[cls];
                        if (!std::any_of(vec.begin(), vec.end(),
                                [&](const Impl::SvfEntry& e){ return e.property == prop && e.fillerClass == fill; }))
                            vec.push_back({prop, fill});
                    };
                    if ((sId >> 30) == 0 && (oId >> 30) == 1) addEntry(sId, oId);  // C subClassOf/equivClass _:r
                    if (isEquiv && (sId >> 30) == 1 && (oId >> 30) == 0) addEntry(oId, sId);  // _:r equivClass C
                }
            }
        }

        // Unit 2: role assertions for SvF properties
        if (!mImpl->mSvfIndex.empty()) {
            std::unordered_set<uint32_t> svfPropTermIdxs;
            for (const auto& [cls, entries] : mImpl->mSvfIndex)
                for (const auto& e : entries)
                    for (uint32_t i = 0; i < count; ++i)
                        if (terms[i].len == e.property.size() &&
                                memcmp(terms[i].ptr, e.property.c_str(), e.property.size()) == 0) {
                            svfPropTermIdxs.insert(i); break;
                        }
            if (!svfPropTermIdxs.empty()) {
                for (int i = 0; i < tripleCount; ++i) {
                    uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                    if ((sId >> 30) != 0 || (oId >> 30) != 0 || !svfPropTermIdxs.count(pId)) continue;
                    uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                    if (si >= count || oi >= count) continue;
                    std::string sIri(terms[si].ptr, terms[si].len);
                    std::string pIri(terms[pId].ptr, terms[pId].len);
                    std::string oIri(terms[oi].ptr, terms[oi].len);
                    mImpl->mSvfRoleAssertions[sIri + '\0' + pIri].push_back(oIri);
                }
            }
        }

        // Unit 2: ABox type assertions (needed for fixpoint at build time)
        if (!mImpl->mSvfIndex.empty() && rdfTypeIdx != UINT32_MAX) {
            for (int i = 0; i < tripleCount; ++i) {
                uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                if (pId != rdfTypeIdx || (sId >> 30) != 0 || (oId >> 30) != 0) continue;
                uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                if (si >= count || oi >= count) continue;
                mImpl->mSvfABoxTypes.push_back({
                    std::string(terms[si].ptr, terms[si].len),
                    std::string(terms[oi].ptr, terms[oi].len)});
            }
        }

        // Unit 4 (plan-048): walk owl:oneOf RDF lists → mOneOfMemberships
        if (!oneOfHeadMap.empty()) {
            for (const auto& [classTermIdx, headEncId] : oneOfHeadMap) {
                if (classTermIdx >= count) continue;
                std::string classIri(terms[classTermIdx].ptr, terms[classTermIdx].len);
                uint32_t curr = headEncId;
                std::unordered_set<uint32_t> seen;
                while (true) {
                    if (seen.count(curr)) break;
                    seen.insert(curr);
                    if ((curr >> 30) == 0) break;  // rdf:nil or other NamedNode → end
                    auto fit = rdfFirstMap.find(curr);
                    if (fit == rdfFirstMap.end()) break;
                    uint32_t memberIdx = fit->second;
                    if (memberIdx < count)
                        mImpl->mOneOfMemberships.push_back({classIri,
                            std::string(terms[memberIdx].ptr, terms[memberIdx].len)});
                    auto rit = rdfRestMap.find(curr);
                    if (rit == rdfRestMap.end()) break;
                    curr = rit->second;
                }
            }
        }

        // Unit 5 (plan-048): build mMinCardRestrictions from restriction bnodes
        {
            // Find bnodes that are owl:Restriction + have owl:onProperty + owl:minCardinality/minQCard
            std::unordered_map<uint32_t, std::pair<uint32_t, uint32_t>> confirmedMinCards;
            // bnodeEncId → (propTermIdx, litEncId)
            for (uint32_t bn : svfRestBnodes) {
                auto pit = svfOnPropMap.find(bn);
                if (pit == svfOnPropMap.end()) continue;
                uint32_t litEncId = UINT32_MAX;
                auto mcit = minCardValueMap.find(bn);
                if (mcit != minCardValueMap.end()) litEncId = mcit->second;
                else {
                    auto mqit = minQCardValueMap.find(bn);
                    if (mqit != minQCardValueMap.end()) litEncId = mqit->second;
                }
                if (litEncId != UINT32_MAX)
                    confirmedMinCards[bn] = {pit->second, litEncId};
            }
            if (!confirmedMinCards.empty()) {
                for (int i = 0; i < tripleCount; ++i) {
                    uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                    bool isEquiv = (equivClsIdx != UINT32_MAX && pId == equivClsIdx);
                    bool isSub   = (subClsIdx   != UINT32_MAX && pId == subClsIdx);
                    if (!isEquiv && !isSub) continue;
                    auto addEntry = [&](uint32_t classEncId, uint32_t bnodeEncId) {
                        auto rit = confirmedMinCards.find(bnodeEncId);
                        if (rit == confirmedMinCards.end()) return;
                        uint32_t classIdx = classEncId & 0x3FFFFFFFu;
                        uint32_t propIdx  = rit->second.first;
                        uint32_t litEncId = rit->second.second;
                        if (classIdx >= count || propIdx >= count) return;
                        uint32_t litIdx = litEncId & 0x3FFFFFFFu;
                        if (litIdx >= count) return;
                        int n = 0;
                        try { n = std::stoi(terms[litIdx].ptr); } catch (...) { return; }
                        if (n <= 0) return;
                        std::string cls(terms[classIdx].ptr, terms[classIdx].len);
                        std::string prop(terms[propIdx].ptr, terms[propIdx].len);
                        std::string qualCls;
                        auto qit = onClassMap.find(bnodeEncId);
                        if (qit != onClassMap.end() && qit->second < count)
                            qualCls = std::string(terms[qit->second].ptr, terms[qit->second].len);
                        mImpl->mMinCardRestrictions.push_back({cls, prop, n, qualCls});
                    };
                    if ((sId >> 30) == 0 && (oId >> 30) == 1) addEntry(sId, oId);
                    if (isEquiv && (sId >> 30) == 1 && (oId >> 30) == 0) addEntry(oId, sId);
                }
            }
        }

        // Unit 5 (plan-048): collect role assertions for minCard properties
        if (!mImpl->mMinCardRestrictions.empty()) {
            std::unordered_set<uint32_t> mcPropIdxs;
            for (const auto& entry : mImpl->mMinCardRestrictions)
                for (uint32_t i = 0; i < count; ++i)
                    if (terms[i].len == entry.propIri.size() &&
                            memcmp(terms[i].ptr, entry.propIri.c_str(), entry.propIri.size()) == 0) {
                        mcPropIdxs.insert(i); break;
                    }
            if (!mcPropIdxs.empty()) {
                for (int i = 0; i < tripleCount; ++i) {
                    uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                    if ((sId >> 30) != 0 || (oId >> 30) != 0 || !mcPropIdxs.count(pId)) continue;
                    uint32_t si = sId & 0x3FFFFFFFu, oi = oId & 0x3FFFFFFFu;
                    if (si >= count || oi >= count) continue;
                    std::string sIri(terms[si].ptr, terms[si].len);
                    std::string pIri(terms[pId].ptr, terms[pId].len);
                    std::string oIri(terms[oi].ptr, terms[oi].len);
                    mImpl->mMinCardRoleAssertions[sIri + '\0' + pIri].push_back(oIri);
                }
            }
        }

        // Unit 3: walk disjointUnionOf RDF lists → mDisjointUnionOf
        if (disjUnIdx != UINT32_MAX) {
            for (int i = 0; i < tripleCount; ++i) {
                uint32_t sId = triples[i*3+0], pId = triples[i*3+1], oId = triples[i*3+2];
                if (pId != disjUnIdx || (sId >> 30) != 0) continue;
                uint32_t classIdx = sId & 0x3FFFFFFFu;
                if (classIdx >= count) continue;
                std::string classIri(terms[classIdx].ptr, terms[classIdx].len);
                uint32_t curr = oId;
                std::unordered_set<uint32_t> seen;
                while (true) {
                    if (seen.count(curr)) break;
                    seen.insert(curr);
                    if ((curr >> 30) == 0) break;  // rdf:nil or other NamedNode → end
                    auto fit = rdfFirstMap.find(curr);
                    if (fit == rdfFirstMap.end()) break;
                    uint32_t memberIdx = fit->second;
                    if (memberIdx < count)
                        mImpl->mDisjointUnionOf.push_back({classIri,
                            std::string(terms[memberIdx].ptr, terms[memberIdx].len)});
                    auto rit = rdfRestMap.find(curr);
                    if (rit == rdfRestMap.end()) break;
                    curr = rit->second;
                }
            }
        }
    }

    // ── Register data with the builder, then map triples → OWL axioms ────────
    // addTriplesData MUST be called before mapTriples so getLatestTriplesData(true)
    // returns this tripleData rather than null.
    builder->addTriplesData(tripleData);

    CConcreteOntologyRedlandTriplesDataExpressionMapper* mapper =
        new CConcreteOntologyRedlandTriplesDataExpressionMapper(builder);
    mapper->setConfExtractSimpleABoxAssertions(true);
    mapper->mapTriples(mImpl->mOntology, mImpl->mOntology->getOntologyTriplesData());
    delete mapper;

    builder->completeBuilding();
    delete builder;

    mImpl->mClassified = false;

#ifdef WASM_VERBOSE_LOGGING
    fprintf(stderr, "{info} KoncludeReasoner >> loadTripleBuffer: %d triples in %.0f ms\n",
        tripleCount,
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
#endif
}

// ── shared pipeline helper ─────────────────────────────────────────────────────
// Both classification() and realization() go through runPipeline().
// buildBaseRequirements() always adds the full TBox pipeline:
//   triples-mapping → active-count → build → preprocess → consistency →
//   precompute-saturation → class-classify → object-property-classify → data-property-classify
// realization() appends four ABox steps on top of that same requirement list
// and submits everything in one prepareOntology() call.  Classification is
// therefore never a separate round-trip when realizing — it is a prerequisite
// that Konclude satisfies as part of the same run.

static void buildBaseRequirements(QList<COntologyProcessingRequirement*>& reqList) { // file-local helper
    COntologyProcessingStepVector* stepVec =
        COntologyProcessingStepVector::getProcessingStepVectorInstance();
    auto addReq = [&](COntologyProcessingStep::PROCESSINGSTEPTYPE t) {
        reqList.push_back(new COntologyProcessingStepRequirement(
            stepVec->getProcessingStep(t),
            COntologyProcessingStatus::PSCOMPLETELYYPROCESSED,
            0,
            COntologyProcessingStatus::PSSUCESSFULL,
            0));
    };
    addReq(COntologyProcessingStep::OPSTRIPLESMAPPING);
    addReq(COntologyProcessingStep::OPSACTIVECOUNT);
    addReq(COntologyProcessingStep::OPSBUILD);
    addReq(COntologyProcessingStep::OPSPREPROCESS);
    addReq(COntologyProcessingStep::OPSCONSISTENCY);
    addReq(COntologyProcessingStep::OPSPRECOMPUTESATURATION);
    addReq(COntologyProcessingStep::OPSCLASSCLASSIFY);
    addReq(COntologyProcessingStep::OPSOBJECTROPERTYCLASSIFY);
    addReq(COntologyProcessingStep::OPSDATAROPERTYCLASSIFY);
}

bool KoncludeReasoner::runPipeline(KoncludeReasoner::Impl* impl, bool includeRealization) {

    QList<COntologyProcessingRequirement*> reqList;
    buildBaseRequirements(reqList);

    if (includeRealization) {
        COntologyProcessingStepVector* stepVec =
            COntologyProcessingStepVector::getProcessingStepVectorInstance();
        auto addReq = [&](COntologyProcessingStep::PROCESSINGSTEPTYPE t) {
            reqList.push_back(new COntologyProcessingStepRequirement(
                stepVec->getProcessingStep(t),
                COntologyProcessingStatus::PSCOMPLETELYYPROCESSED,
                0,
                COntologyProcessingStatus::PSSUCESSFULL,
                0));
        };
        addReq(COntologyProcessingStep::OPSINITREALIZE);
        addReq(COntologyProcessingStep::OPSCONCEPTREALIZE);
        addReq(COntologyProcessingStep::OPSROLEREALIZE);
        addReq(COntologyProcessingStep::OPSSAMEINDIVIDUALSREALIZE);
    }

#ifdef WASM_VERBOSE_LOGGING
    fprintf(stderr, "{dbg} runPipeline(realization=%d): calling prepareOntology\n", (int)includeRealization);
#endif
    impl->mReasonerManager->prepareOntology(impl->mOntology, reqList);
#ifdef WASM_VERBOSE_LOGGING
    fprintf(stderr, "{dbg} runPipeline: prepareOntology returned\n");
#endif
    impl->mReasonerManager->waitSynchronization();

    for (auto* r : reqList) delete r;

    COntologyProcessingStepDataVector* stepDataVec =
        impl->mOntology->getProcessingSteps()->getOntologyProcessingStepDataVector();
    auto stepDone = [&](COntologyProcessingStep::PROCESSINGSTEPTYPE t) -> bool {
        auto* d = stepDataVec->getProcessingStepData(t);
        return d && d->getProcessingStatus()->hasPartialProcessingFlags(
            COntologyProcessingStatus::PSCOMPLETELYYPROCESSED);
    };

    impl->mClassified = stepDone(COntologyProcessingStep::OPSCLASSCLASSIFY);
    if (impl->mClassified) {
        impl->buildConceptIndex();
        impl->buildAxiomMap();
    }

    bool hasIndividuals = impl->mOntology->getABox() &&
        impl->mOntology->getABox()->getIndividualVector(false) &&
        impl->mOntology->getABox()->getIndividualVector(false)->getItemCount() > 0;

    impl->mRealized = includeRealization && hasIndividuals &&
        stepDone(COntologyProcessingStep::OPSCONCEPTREALIZE);
    if (impl->mRealized) impl->buildIndividualIndex();

    if (includeRealization) {
        impl->mReasonerManager->stopAndClearRealizers();
    }

    return impl->mClassified;
}

// classification ───────────────────────────────────────────────────────────────
// TBox only: class hierarchy + property hierarchy. No ABox realization.
// Exposed to JS as the "classification" worker command (called by classify()).
bool KoncludeReasoner::classification() {
    if (mImpl->mLoadError) return false;
#ifdef WASM_VERBOSE_LOGGING
    auto t0 = std::chrono::steady_clock::now();
#endif
    bool ok = runPipeline(mImpl, false);
#ifdef WASM_VERBOSE_LOGGING
    fprintf(stderr, "{info} KoncludeReasoner >> Finished classification in %.0f ms\n",
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
#endif
    return ok;
}

// realization ──────────────────────────────────────────────────────────────────
// TBox + ABox in one shot: classification is always a prerequisite (see
// buildBaseRequirements), then OPSINITREALIZE / OPSCONCEPTREALIZE /
// OPSROLEREALIZE / OPSSAMEINDIVIDUALSREALIZE are appended and all submitted
// together via a single prepareOntology() call.  There is no separate
// classification round-trip.
// Exposed to JS as the "realization" worker command (called by materialize()).
bool KoncludeReasoner::realization() {
    if (mImpl->mLoadError) return false;
#ifdef WASM_VERBOSE_LOGGING
    auto t0 = std::chrono::steady_clock::now();
#endif
    bool ok = runPipeline(mImpl, true);
#ifdef WASM_VERBOSE_LOGGING
    fprintf(stderr, "{info} KoncludeReasoner >> Finished realization in %.0f ms\n",
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
#endif
    return ok;
}

// consistency ──────────────────────────────────────────────────────────────────

bool KoncludeReasoner::consistency() {
    if (mImpl->mTriviallyInconsistent) return false;
    CConsistence* cons = mImpl->mOntology->getConsistence();
    if (!cons) {
        return true;
    }
    return cons->isOntologyConsistent();
}

// processorCount ───────────────────────────────────────────────────────────────

int KoncludeReasoner::processorCount() {
    return mImpl ? mImpl->mProcessorCount : 0;
}

// reset ────────────────────────────────────────────────────────────────────────

void KoncludeReasoner::reset() {
    mImpl->reset();
}

// ─── Binary output buffer helpers ────────────────────────────────────────────

namespace {

// Intern table for building a string-table + triple-ID output buffer.
// Stores strings deduped; assigns sequential uint32 IDs (top 2 bits = type tag).
struct InternTable {
    std::unordered_map<std::string, uint32_t> index;
    std::vector<std::string> strings;

    // typeTag: 0=NamedNode, 1=BlankNode, 2=Literal
    uint32_t intern(const std::string& s, uint32_t typeTag = 0) {
        auto key = std::to_string(typeTag) + "\x01" + s;
        auto it = index.find(key);
        if (it != index.end()) return it->second;
        uint32_t id = static_cast<uint32_t>(strings.size()) | (typeTag << 30);
        index[key] = id;
        strings.push_back(s);
        return id;
    }

    // Build [count:u32][offset0..N-1:u32][UTF-8 data...]
    std::vector<uint8_t> build() const {
        std::vector<uint8_t> out;
        uint32_t n = static_cast<uint32_t>(strings.size());
        auto pu32 = [&](uint32_t v) {
            out.push_back(v & 0xff);
            out.push_back((v >> 8) & 0xff);
            out.push_back((v >> 16) & 0xff);
            out.push_back((v >> 24) & 0xff);
        };
        pu32(n);
        uint32_t off = 0;
        for (auto& s : strings) { pu32(off); off += static_cast<uint32_t>(s.size()); }
        for (auto& s : strings) out.insert(out.end(), s.begin(), s.end());
        return out;
    }
};

struct TupleHash3 {
    std::size_t operator()(const std::tuple<uint32_t,uint32_t,uint32_t>& t) const {
        auto h = std::hash<uint32_t>{};
        std::size_t seed = h(std::get<0>(t));
        seed ^= h(std::get<1>(t)) + 0x9e3779b9u + (seed << 6) + (seed >> 2);
        seed ^= h(std::get<2>(t)) + 0x9e3779b9u + (seed << 6) + (seed >> 2);
        return seed;
    }
};

} // anonymous namespace

// buildInferredTripleBuffer ────────────────────────────────────────────────────
//
// Assembles a combined output buffer:
//   [strTableLen:u32][strTable...][tripleBuffer...]
// where strTable = InternTable::build() and tripleBuffer = [s:u32,p:u32,o:u32,...].
//
// Returns total byte length; 0 if not classified.
// The buffer is stored in mImpl->mResultBuffer; the raw pointer is mImpl->mResultBufferPtr.
//
int KoncludeReasoner::buildInferredTripleBuffer() {
    if (!mImpl->mClassified) {
        return 0;
    }

    InternTable intern;
    std::vector<uint32_t> tripleIds;
    std::unordered_set<std::tuple<uint32_t,uint32_t,uint32_t>, TupleHash3> emittedTriples;

    auto emitTriple = [&](uint32_t s, uint32_t p, uint32_t o) {
        auto key = std::make_tuple(s, p, o);
        if (emittedTriples.insert(key).second) {
            tripleIds.push_back(s);
            tripleIds.push_back(p);
            tripleIds.push_back(o);
        }
    };

    // ── TBox: subClassOf + equivalentClass ────────────────────────────────────

    CTaxonomy* taxonomy = mImpl->mOntology->getConceptTaxonomy();
    if (taxonomy) {
        const std::string rdfsSubClassOf =
            "http://www.w3.org/2000/01/rdf-schema#subClassOf";
        const std::string owlEquivClass =
            "http://www.w3.org/2002/07/owl#equivalentClass";
        static const std::string owlThing =
            "http://www.w3.org/2002/07/owl#Thing";
        static const std::string owlNothing =
            "http://www.w3.org/2002/07/owl#Nothing";

        uint32_t pSubClass = intern.intern(rdfsSubClassOf);
        uint32_t pEquiv    = intern.intern(owlEquivClass);

        auto conceptIri = [](CConcept* c) -> std::string {
            if (!c) return "";
            QString q = CIRIName::getRecentIRIName(c->getClassNameLinker());
            return q.empty() ? "" : std::string(q);
        };

        QHash<CConcept*, CHierarchyNode*>* nodeHash = taxonomy->getConceptHierarchyNodeHash();
        if (nodeHash) {
            std::unordered_map<CHierarchyNode*, std::vector<std::string>> nodeToIris;
            for (auto it = nodeHash->constBegin(), itEnd = nodeHash->constEnd(); it != itEnd; ++it) {
                CHierarchyNode* node = it.value();
                if (!node || !node->isActive()) continue;
                std::string iri = conceptIri(it.key());
                if (!iri.empty() && iri != owlNothing) {
                    nodeToIris[node].push_back(iri);
                }
            }

            // equivalentClass
            for (auto& [node, iris] : nodeToIris) {
                if (iris.size() < 2) continue;
                for (size_t i = 0; i < iris.size(); ++i) {
                    for (size_t j = 0; j < iris.size(); ++j) {
                        if (i == j) continue;
                        emitTriple(intern.intern(iris[i]), pEquiv, intern.intern(iris[j]));
                    }
                }
            }

            // pick node representative: lex-min IRI from nodeToIris
            // (nodeToIris uses nodeHash, which maps all equivalent concepts to
            // the same node — unlike getEquivalentConceptList which only returns
            // the primary concept). Lex-min is deterministic and matches the
            // normalization applied to native TBox fixtures.
            auto nodeRep = [&nodeToIris](CHierarchyNode* node) -> std::string {
                auto it = nodeToIris.find(node);
                if (it == nodeToIris.end() || it->second.empty()) return "";
                const auto& iris = it->second;
                return *std::min_element(iris.begin(), iris.end());
            };

            // subClassOf
            for (auto& [node, iris] : nodeToIris) {
                std::string childIri = nodeRep(node);
                if (childIri.empty() || childIri == owlNothing || childIri == owlThing) continue;
                QSet<CHierarchyNode*>* parents = node->getParentNodeSet();
                if (!parents) continue;
                for (CHierarchyNode* parentNode : *parents) {
                    if (nodeToIris.count(parentNode) == 0) continue;
                    std::string parentIri = nodeRep(parentNode);
                    if (parentIri.empty() || parentIri == owlNothing) continue;
                    emitTriple(intern.intern(childIri), pSubClass, intern.intern(parentIri));
                }
            }
        }
    }

    // ── ABox: rdf:type + object property assertions ───────────────────────────

    if (mImpl->mRealized) {
        CRealization* real = mImpl->mOntology->getRealization();
        if (real) {
            CConceptRealization* conReal = real->getConceptRealization();
            CRoleRealization*    roleReal = real->getRoleRealization();

            static const std::string rdfType =
                "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
            static const std::string owlTopObjProp =
                "http://www.w3.org/2002/07/owl#topObjectProperty";
            static const std::string owlBottomObjProp =
                "http://www.w3.org/2002/07/owl#bottomObjectProperty";
            static const std::string owlThing2 =
                "http://www.w3.org/2002/07/owl#Thing";
            static const std::string owlNothing2 =
                "http://www.w3.org/2002/07/owl#Nothing";

            uint32_t pRdfType = intern.intern(rdfType);

            CIndividualVector* indiVec =
                mImpl->mOntology->getABox()->getIndividualVector(false);
            qint64 indiCount = indiVec ? indiVec->getItemCount() : 0;

            if (conReal) {
                // Concept type visitor structs
                // Collects all equivalent concept IRIs for a given type item.
                // visitConcepts iterates all members of the equivalence set;
                // returning true continues iteration to collect all synonyms.
                struct ConceptNameVisitor : CConceptRealizationConceptVisitor {
                    std::vector<std::string> iris;
                    bool visitConcept(CConcept* c, CConceptRealization*) override {
                        if (!c) return true;
                        QString q = CIRIName::getRecentIRIName(c->getClassNameLinker());
                        if (!q.empty()) iris.emplace_back(std::string(q));
                        return true;
                    }
                };

                struct TypeVisitor : CConceptRealizationInstantiatedVisitor {
                    InternTable* intern;
                    uint32_t pRdfType;
                    uint32_t indiId;
                    std::vector<uint32_t>* tripleIds;
                    std::unordered_set<std::tuple<uint32_t,uint32_t,uint32_t>, TupleHash3>* emitted;
                    const std::string* owlThing;
                    const std::string* owlNothing;

                    bool visitType(CConceptInstantiatedItem* item, CConceptRealization* cr) override {
                        ConceptNameVisitor cv;
                        cr->visitConcepts(item, &cv);
                        for (const auto& iri : cv.iris) {
                            if (iri == *owlThing || iri == *owlNothing) continue;
                            uint32_t cId = intern->intern(iri);
                            auto key = std::make_tuple(indiId, pRdfType, cId);
                            if (emitted->insert(key).second) {
                                tripleIds->push_back(indiId);
                                tripleIds->push_back(pRdfType);
                                tripleIds->push_back(cId);
                            }
                        }
                        return true;
                    }
                };

                TypeVisitor tv;
                tv.intern      = &intern;
                tv.pRdfType    = pRdfType;
                tv.tripleIds   = &tripleIds;
                tv.emitted     = &emittedTriples;
                tv.owlThing    = &owlThing2;
                tv.owlNothing  = &owlNothing2;

                for (qint64 i = 0; i < indiCount; ++i) {
                    CIndividual* indi = indiVec->getData(i);
                    if (!indi) continue;
                    QString indiQ = CIRIName::getRecentIRIName(indi->getIndividualNameLinker());
                    if (indiQ.empty()) continue;
                    std::string indiIri(indiQ);
                    tv.indiId = intern.intern(indiIri);
                    conReal->visitAllTypes(indi, &tv);
                }
            }

            if (roleReal) {
                // Role assertion visitor structs
                struct RoleNameVisitor : CRoleRealizationRoleVisitor {
                    std::string iri;
                    bool visitRole(CRole* role, CRoleRealization*) override {
                        if (!role) return true;
                        QString q = CIRIName::getRecentIRIName(role->getPropertyNameLinker());
                        if (!q.empty()) { iri = std::string(q); return false; }
                        return true;
                    }
                };

                struct TargetIndiVisitor : CRoleRealizationIndividualVisitor {
                    InternTable* intern;
                    uint32_t srcId;
                    uint32_t roleId;
                    std::vector<uint32_t>* tripleIds;
                    std::unordered_set<std::tuple<uint32_t,uint32_t,uint32_t>, TupleHash3>* emitted;

                    bool visitIndividual(const CIndividualReference& indiRef, CRoleRealization*) override {
                        CIndividual* tgt = indiRef.getIndividual();
                        if (!tgt) return true;
                        QString q = CIRIName::getRecentIRIName(tgt->getIndividualNameLinker());
                        if (q.empty()) return true;
                        uint32_t tgtId = intern->intern(std::string(q));
                        auto key = std::make_tuple(srcId, roleId, tgtId);
                        if (emitted->insert(key).second) {
                            tripleIds->push_back(srcId);
                            tripleIds->push_back(roleId);
                            tripleIds->push_back(tgtId);
                        }
                        return true;
                    }
                };

                struct TargetInstVisitor : CRoleRealizationInstanceVisitor {
                    CRoleRealization* roleReal;
                    TargetIndiVisitor* indiVisitor;

                    bool visitRoleInstance(const CRealizationIndividualInstanceItemReference& ref,
                                           CRoleRealization* rr) override {
                        rr->visitIndividuals(ref, indiVisitor);
                        return true;
                    }
                };

                struct RoleInstVisitor : CRoleRealizationInstantiatedVisitor {
                    CRoleRealization* roleReal;
                    InternTable* intern;
                    uint32_t srcId;
                    std::vector<uint32_t>* tripleIds;
                    std::unordered_set<std::tuple<uint32_t,uint32_t,uint32_t>, TupleHash3>* emitted;
                    const std::string* owlTopObjProp;
                    const std::string* owlBottomObjProp;
                    CIndividual* srcIndi;

                    bool visitRoleInstantiated(CRoleInstantiatedItem* roleItem, CRoleRealization* rr) override {
                        RoleNameVisitor rv;
                        rr->visitRoles(roleItem, &rv);
                        if (rv.iri.empty() || rv.iri == *owlTopObjProp || rv.iri == *owlBottomObjProp)
                            return true;
                        uint32_t roleId = intern->intern(rv.iri);

                        TargetIndiVisitor tiv;
                        tiv.intern    = intern;
                        tiv.srcId     = srcId;
                        tiv.roleId    = roleId;
                        tiv.tripleIds = tripleIds;
                        tiv.emitted   = emitted;

                        TargetInstVisitor tinstv;
                        tinstv.roleReal    = rr;
                        tinstv.indiVisitor = &tiv;

                        CRealizationIndividualInstanceItemReference srcRef =
                            rr->getRoleInstanceItemReference(srcIndi);
                        rr->visitTargetIndividuals(srcRef, roleItem, &tinstv);
                        return true;
                    }
                };

                for (qint64 i = 0; i < indiCount; ++i) {
                    CIndividual* indi = indiVec->getData(i);
                    if (!indi) continue;
                    QString indiQ = CIRIName::getRecentIRIName(indi->getIndividualNameLinker());
                    if (indiQ.empty()) continue;
                    std::string indiIri(indiQ);
                    uint32_t srcId = intern.intern(indiIri);

                    RoleInstVisitor riv;
                    riv.roleReal         = roleReal;
                    riv.intern           = &intern;
                    riv.srcId            = srcId;
                    riv.tripleIds        = &tripleIds;
                    riv.emitted          = &emittedTriples;
                    riv.owlTopObjProp    = &owlTopObjProp;
                    riv.owlBottomObjProp = &owlBottomObjProp;
                    riv.srcIndi          = indi;

                    CRealizationIndividualInstanceItemReference srcRef =
                        roleReal->getRoleInstanceItemReference(indi);
                    roleReal->visitSourceIndividualRoles(srcRef, &riv);
                }
            }

            // ── owl:sameAs entailments ────────────────────────────────────────
            CSameRealization* sameReal = real->getSameRealization();
            if (sameReal) {
                static const std::string owlSameAs =
                    "http://www.w3.org/2002/07/owl#sameAs";
                uint32_t pSameAs = intern.intern(owlSameAs);

                struct SameGroupVisitor : CSameRealizationIndividualVisitor {
                    std::vector<std::string> iris;
                    CIndividualVector* indiVec;

                    bool visitIndividual(const CIndividualReference& indiRef,
                                         CSameRealization*) override {
                        qint64 id = indiRef.getIndividualID();
                        if (id < 0 || id >= indiVec->getItemCount()) return true;
                        CIndividual* tgt = indiVec->getData(id);
                        if (!tgt) return true;
                        QString q = CIRIName::getRecentIRIName(tgt->getIndividualNameLinker());
                        if (!q.empty()) iris.emplace_back(std::string(q));
                        return true;
                    }
                };

                for (qint64 i = 0; i < indiCount; ++i) {
                    CIndividual* indi = indiVec->getData(i);
                    if (!indi) continue;
                    QString indiQ = CIRIName::getRecentIRIName(indi->getIndividualNameLinker());
                    if (indiQ.empty()) continue;
                    std::string srcIri(indiQ);

                    SameGroupVisitor sgv;
                    sgv.indiVec = indiVec;
                    sameReal->visitSameIndividuals(indi, &sgv);

                    if (sgv.iris.size() < 2) continue;
                    uint32_t srcId = intern.intern(srcIri);
                    for (const auto& otherIri : sgv.iris) {
                        if (otherIri == srcIri) continue;
                        emitTriple(srcId, pSameAs, intern.intern(otherIri));
                    }
                }
            }

            // ── Data property assertions (from ABox individual linkers) ───────
            for (qint64 i = 0; i < indiCount; ++i) {
                CIndividual* indi = indiVec->getData(i);
                if (!indi) continue;
                QString indiQ = CIRIName::getRecentIRIName(indi->getIndividualNameLinker());
                if (indiQ.empty()) continue;
                uint32_t srcId = intern.intern(std::string(indiQ));
                for (CDataAssertionLinker* dal = indi->getAssertionDataLinker(); dal; dal = dal->getNext()) {
                    CRole* role = dal->getData();
                    CDataLiteral* dataLiteral = dal->getDataLiteral();
                    if (!role || !dataLiteral) continue;
                    QString roleQ = CIRIName::getRecentIRIName(role->getPropertyNameLinker());
                    if (roleQ.empty()) continue;
                    CDatatype* dt = dataLiteral->getDatatype();
                    std::string litStr = std::string(dataLiteral->getLexicalDataLiteralValueString());
                    litStr += '\0';
                    if (dt) litStr += std::string(dt->getDatatypeIRI());
                    litStr += '\0'; // language = empty for datatype literals
                    emitTriple(srcId,
                               intern.intern(std::string(roleQ)),
                               intern.intern(litStr, 2));
                }
            }
        }

        // Unit 4 (plan-048): owl:oneOf → member rdf:type class
        if (!mImpl->mOneOfMemberships.empty()) {
            static const std::string rdfTypeStr =
                "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
            uint32_t pType = intern.intern(rdfTypeStr);
            for (const auto& [classIri, memberIri] : mImpl->mOneOfMemberships)
                emitTriple(intern.intern(memberIri), pType, intern.intern(classIri));
        }

        // Unit 5 (plan-048): minCardinality → member rdf:type class (OWA-correct)
        if (!mImpl->mMinCardRestrictions.empty() && !mImpl->mMinCardRoleAssertions.empty()) {
            static const std::string rdfTypeStr2 =
                "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
            uint32_t pType = intern.intern(rdfTypeStr2);

            CIndividualVector* indiVec2 =
                mImpl->mOntology->getABox()->getIndividualVector(false);
            qint64 indiCount2 = indiVec2 ? indiVec2->getItemCount() : 0;

            for (const auto& entry : mImpl->mMinCardRestrictions) {
                for (qint64 i = 0; i < indiCount2; ++i) {
                    CIndividual* indi = indiVec2->getData(i);
                    if (!indi) continue;
                    QString indiQ = CIRIName::getRecentIRIName(indi->getIndividualNameLinker());
                    if (indiQ.empty()) continue;
                    std::string indiIri(indiQ);

                    std::string roleKey = indiIri + '\0' + entry.propIri;
                    auto rit = mImpl->mMinCardRoleAssertions.find(roleKey);
                    if (rit == mImpl->mMinCardRoleAssertions.end()) continue;
                    const std::vector<std::string>& fillers = rit->second;
                    if ((int)fillers.size() < entry.minCard) continue;

                    bool satisfied = false;
                    if (entry.minCard == 1) {
                        satisfied = true;
                    } else {
                        // Bitmask: find entry.minCard pairwise-distinct fillers
                        int k = std::min((int)fillers.size(), 16);
                        int need = entry.minCard;
                        for (int mask = (1 << k) - 1; mask >= 0 && !satisfied; --mask) {
                            if (__builtin_popcount(mask) != need) continue;
                            bool allDistinct = true;
                            for (int a = 0; a < k && allDistinct; ++a) {
                                if (!(mask & (1 << a))) continue;
                                for (int b = a + 1; b < k && allDistinct; ++b) {
                                    if (!(mask & (1 << b))) continue;
                                    auto it = mImpl->mDifferentFromPairs.find(fillers[a]);
                                    if (it == mImpl->mDifferentFromPairs.end() ||
                                            !it->second.count(fillers[b]))
                                        allDistinct = false;
                                }
                            }
                            if (allDistinct) satisfied = true;
                        }
                    }
                    if (satisfied)
                        emitTriple(intern.intern(indiIri), pType, intern.intern(entry.classIri));
                }
            }
        }
    }

    // ── OWL 2 DL post-processing (Batch B workarounds) ────────────────────────

    // Unit 3: disjointUnionOf → member rdfs:subClassOf class
    if (!mImpl->mDisjointUnionOf.empty()) {
        static const std::string rdfsSubCls = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
        uint32_t pSub = intern.intern(rdfsSubCls);
        for (const auto& [classIri, memberIri] : mImpl->mDisjointUnionOf)
            emitTriple(intern.intern(memberIri), pSub, intern.intern(classIri));
    }

    // Unit 1: FP/IFP sameAs pairs
    if (!mImpl->mFpIfpSameAsPairs.empty()) {
        static const std::string owlSameAs = "http://www.w3.org/2002/07/owl#sameAs";
        uint32_t pSameAs = intern.intern(owlSameAs);
        for (const auto& [s, o] : mImpl->mFpIfpSameAsPairs)
            emitTriple(intern.intern(s), pSameAs, intern.intern(o));
    }

    // Unit 2: someValuesFrom fixpoint — propagate rdf:type to restriction fillers
    if (!mImpl->mSvfIndex.empty()) {
        static const std::string rdfType = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        uint32_t pType = intern.intern(rdfType);

        // Collect all type assertions: ABox input + WASM-inferred output
        std::unordered_map<std::string, std::unordered_set<std::string>> allTypes;
        for (const auto& [indi, cls] : mImpl->mSvfABoxTypes)
            allTypes[indi].insert(cls);
        // Scan output buffer for rdf:type triples
        for (size_t i = 0; i + 2 < tripleIds.size(); i += 3) {
            if (tripleIds[i+1] != pType) continue;
            uint32_t si = tripleIds[i]   & 0x3FFFFFFFu;
            uint32_t oi = tripleIds[i+2] & 0x3FFFFFFFu;
            if (si < intern.strings.size() && oi < intern.strings.size())
                allTypes[intern.strings[si]].insert(intern.strings[oi]);
        }

        // Fixpoint: emit new rdf:type triples until stable
        bool changed = true;
        while (changed) {
            changed = false;
            // Snapshot current types to avoid modifying while iterating
            std::vector<std::pair<std::string,std::string>> snapshot;
            for (const auto& [indi, types] : allTypes)
                for (const auto& cls : types)
                    snapshot.push_back({indi, cls});
            for (const auto& [indiIri, classIri] : snapshot) {
                auto sit = mImpl->mSvfIndex.find(classIri);
                if (sit == mImpl->mSvfIndex.end()) continue;
                for (const auto& entry : sit->second) {
                    const std::string& prop = entry.property;
                    const std::string& filler = entry.fillerClass;
                    std::string roleKey = indiIri + '\0' + prop;
                    auto rit = mImpl->mSvfRoleAssertions.find(roleKey);
                    if (rit == mImpl->mSvfRoleAssertions.end()) continue;
                    for (const std::string& fillerIri : rit->second) {
                        if (allTypes[fillerIri].insert(filler).second) {
                            emitTriple(intern.intern(fillerIri), pType, intern.intern(filler));
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    // ── Assemble combined buffer [strTableLen:u32][strTable][tripleBuffer] ────

    std::vector<uint8_t> strTable = intern.build();
    uint32_t strTableLen = static_cast<uint32_t>(strTable.size());

    size_t totalLen = 4 + strTableLen + tripleIds.size() * 4;
    mImpl->mResultBuffer.resize(totalLen);
    uint8_t* p = mImpl->mResultBuffer.data();

    // Write strTableLen as little-endian u32
    p[0] = strTableLen & 0xff;
    p[1] = (strTableLen >> 8) & 0xff;
    p[2] = (strTableLen >> 16) & 0xff;
    p[3] = (strTableLen >> 24) & 0xff;
    p += 4;

    // Write strTable
    std::memcpy(p, strTable.data(), strTableLen);
    p += strTableLen;

    // Write triple IDs
    for (uint32_t id : tripleIds) {
        p[0] = id & 0xff;
        p[1] = (id >> 8) & 0xff;
        p[2] = (id >> 16) & 0xff;
        p[3] = (id >> 24) & 0xff;
        p += 4;
    }

    mImpl->mResultBufferPtr = reinterpret_cast<int>(mImpl->mResultBuffer.data());

#ifdef WASM_VERBOSE_LOGGING
    fprintf(stderr, "{info} KoncludeReasoner >> buildInferredTripleBuffer: %zu triples, %zu bytes\n",
        tripleIds.size() / 3, totalLen);
#endif

    return static_cast<int>(totalLen);
}

// getInferredTripleBufferPtr ───────────────────────────────────────────────────

int KoncludeReasoner::getInferredTripleBufferPtr() {
    return mImpl->mResultBufferPtr;
}

// buildPropertyTripleBuffer ───────────────────────────────────────────────────
// Walks object-property and data-property hierarchies and emits
// rdfs:subPropertyOf triples into mResultBuffer using the same binary wire
// format as buildInferredTripleBuffer().

int KoncludeReasoner::buildPropertyTripleBuffer() {
    if (!mImpl->mClassified) {
        return 0;
    }

    InternTable intern;
    std::vector<uint32_t> tripleIds;
    std::unordered_set<std::tuple<uint32_t,uint32_t,uint32_t>, TupleHash3> emittedTriples;

    auto emitTriple = [&](uint32_t s, uint32_t p, uint32_t o) {
        auto key = std::make_tuple(s, p, o);
        if (emittedTriples.insert(key).second) {
            tripleIds.push_back(s);
            tripleIds.push_back(p);
            tripleIds.push_back(o);
        }
    };

    static const std::string rdfsSubPropertyOf =
        "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
    uint32_t pSubProp = intern.intern(rdfsSubPropertyOf);

    CClassification* classif = mImpl->mOntology->getClassification();
    if (classif) {
        using Konclude::Reasoner::Classification::CPropertyRoleClassification;
        using Konclude::Reasoner::Taxonomy::CRolePropertiesHierarchy;
        using Konclude::Reasoner::Taxonomy::CRolePropertiesHierarchyNode;

        // Lambda to walk one property hierarchy (object or data).
        auto walkHierarchy = [&](CPropertyRoleClassification* roleClassif) {
            if (!roleClassif || !roleClassif->hasRolePropertiesHierarchy()) return;
            CRolePropertiesHierarchy* hierarchy = roleClassif->getRolePropertiesHierarchy();
            if (!hierarchy) return;

            CRolePropertiesHierarchyNode* topNode    = hierarchy->getTopHierarchyNode();
            CRolePropertiesHierarchyNode* bottomNode = hierarchy->getBottomHierarchyNode();
            if (!topNode) return;

            // First pass: BFS to collect all nodes and their IRIs.
            std::unordered_map<CRolePropertiesHierarchyNode*, std::vector<std::string>> nodeToIris;
            QList<CRolePropertiesHierarchyNode*> queue;
            QSet<CRolePropertiesHierarchyNode*> visited;
            queue.append(topNode);
            visited.insert(topNode);
            while (!queue.isEmpty()) {
                CRolePropertiesHierarchyNode* node = queue.takeFirst();
                QStringList irisQ = node->getEquivalentRoleStringList(false);
                for (const QString& iriQ : irisQ) {
                    if (!iriQ.empty()) {
                        nodeToIris[node].push_back(std::string(iriQ));
                    }
                }
                QSet<CRolePropertiesHierarchyNode*>* children = node->getChildNodeSet();
                if (children) {
                    for (CRolePropertiesHierarchyNode* child : *children) {
                        if (!visited.contains(child)) {
                            visited.insert(child);
                            queue.append(child);
                        }
                    }
                }
            }

            // Second pass: emit rdfs:subPropertyOf triples (Hasse diagram edges).
            // Skip top and bottom nodes. Use lex-min IRI as representative.
            for (auto& [node, iris] : nodeToIris) {
                if (node == topNode || node == bottomNode) continue;
                if (iris.empty()) continue;

                std::string childRep = *std::min_element(iris.begin(), iris.end());

                QSet<CRolePropertiesHierarchyNode*>* parents = node->getParentNodeSet();
                if (!parents) continue;

                for (CRolePropertiesHierarchyNode* parentNode : *parents) {
                    if (nodeToIris.count(parentNode) == 0) continue;
                    if (parentNode == bottomNode) continue;
                    const std::vector<std::string>& parentIris = nodeToIris.at(parentNode);
                    if (parentIris.empty()) continue;

                    std::string parentRep = *std::min_element(parentIris.begin(), parentIris.end());
                    emitTriple(intern.intern(childRep), pSubProp, intern.intern(parentRep));
                }
            }
        };

        walkHierarchy(classif->getObjectPropertyRoleClassification());
        walkHierarchy(classif->getDataPropertyRoleClassification());
    }

    // ── OWL 2 DL: p owl:equivalentProperty q ⇒ bidirectional rdfs:subPropertyOf
    for (const auto& [p, q] : mImpl->mEquivPropPairs) {
        emitTriple(intern.intern(p), pSubProp, intern.intern(q));
        emitTriple(intern.intern(q), pSubProp, intern.intern(p));
    }

    // ── Assemble combined buffer [strTableLen:u32][strTable][tripleBuffer] ────

    std::vector<uint8_t> strTable = intern.build();
    uint32_t strTableLen = static_cast<uint32_t>(strTable.size());

    size_t totalLen = 4 + strTableLen + tripleIds.size() * 4;
    mImpl->mResultBuffer.resize(totalLen);
    uint8_t* p = mImpl->mResultBuffer.data();

    // Write strTableLen as little-endian u32
    p[0] = strTableLen & 0xff;
    p[1] = (strTableLen >> 8) & 0xff;
    p[2] = (strTableLen >> 16) & 0xff;
    p[3] = (strTableLen >> 24) & 0xff;
    p += 4;

    // Write strTable
    std::memcpy(p, strTable.data(), strTableLen);
    p += strTableLen;

    // Write triple IDs
    for (uint32_t id : tripleIds) {
        p[0] = id & 0xff;
        p[1] = (id >> 8) & 0xff;
        p[2] = (id >> 16) & 0xff;
        p[3] = (id >> 24) & 0xff;
        p += 4;
    }

    mImpl->mResultBufferPtr = reinterpret_cast<int>(mImpl->mResultBuffer.data());

#ifdef WASM_VERBOSE_LOGGING
    fprintf(stderr, "{info} KoncludeReasoner >> buildPropertyTripleBuffer: %zu triples, %zu bytes\n",
        tripleIds.size() / 3, totalLen);
#endif

    return static_cast<int>(totalLen);
}

// buildUnsatisfiableClassBuffer — returns newline-delimited IRIs of unsatisfiable classes.
// Walks the bottom node of the concept taxonomy.  owl:Nothing is always excluded.
std::string KoncludeReasoner::buildUnsatisfiableClassBuffer() {
    if (!mImpl->mClassified) {
        return "";
    }

    CTaxonomy* taxonomy = mImpl->mOntology->getConceptTaxonomy();
    if (!taxonomy) return "";

    CHierarchyNode* bottomNode = taxonomy->getBottomHierarchyNode();
    if (!bottomNode) return "";

    QHash<CConcept*, CHierarchyNode*>* nodeHash = taxonomy->getConceptHierarchyNodeHash();
    if (!nodeHash) return "";

    QList<CConcept*>* eqList = bottomNode->getEquivalentConceptList();
    if (!eqList) return "";

    static const std::string owlNothing = "http://www.w3.org/2002/07/owl#Nothing";

    std::vector<std::string> iris;
    for (CConcept* c : *eqList) {
        if (!c) continue;
        if (!nodeHash->contains(c)) continue;  // stale-pointer guard
        QString q = CIRIName::getRecentIRIName(c->getClassNameLinker());
        if (q.empty()) continue;
        std::string iri(q);
        if (iri == owlNothing) continue;
        iris.push_back(iri);
    }

    std::string result;
    for (size_t i = 0; i < iris.size(); ++i) {
        if (i > 0) result += '\n';
        result += iris[i];
    }
    return result;
}

// isSubClassOf — O(1) taxonomy lookup using pre-built concept index.
// Returns true iff subIri ⊑ superIri according to the computed class hierarchy.
bool KoncludeReasoner::isSubClassOf(const std::string& subIri, const std::string& superIri) {
    if (!mImpl->mClassified) return false;

    CTaxonomy* taxonomy = mImpl->mOntology->getConceptTaxonomy();
    if (!taxonomy) return false;

    auto subIt = mImpl->mConceptByIri.find(subIri);
    auto supIt = mImpl->mConceptByIri.find(superIri);
    if (subIt == mImpl->mConceptByIri.end() || supIt == mImpl->mConceptByIri.end()) return false;

    return taxonomy->isSubsumption(supIt->second, subIt->second);
}

// isSatisfiableClass — O(1) taxonomy lookup using pre-built concept index.
// Returns true iff classIri is satisfiable (not equivalent to owl:Nothing).
bool KoncludeReasoner::isSatisfiableClass(const std::string& classIri) {
    if (!mImpl->mClassified) return true;

    CTaxonomy* taxonomy = mImpl->mOntology->getConceptTaxonomy();
    if (!taxonomy) return true;

    auto it = mImpl->mConceptByIri.find(classIri);
    if (it == mImpl->mConceptByIri.end()) return true;

    return taxonomy->isSatisfiable(it->second);
}

// isInstanceOf — O(1) realization lookup using pre-built individual/concept indexes.
// Returns true iff individualIri is a known instance of classIri.
bool KoncludeReasoner::isInstanceOf(const std::string& individualIri, const std::string& classIri) {
    if (!mImpl->mRealized) return false;

    CRealization* real = mImpl->mOntology->getRealization();
    if (!real) return false;
    CConceptRealization* conReal = real->getConceptRealization();
    if (!conReal) return false;

    auto indiIt = mImpl->mIndividualByIri.find(individualIri);
    if (indiIt == mImpl->mIndividualByIri.end()) return false;

    auto conceptIt = mImpl->mConceptByIri.find(classIri);
    if (conceptIt == mImpl->mConceptByIri.end()) return false;

    return conReal->isConceptInstance(indiIt->second, conceptIt->second);
}

std::string KoncludeReasoner::getSubClassJustification(const std::string& subIri, const std::string& superIri) {
    return mImpl->getSubClassJustification(subIri, superIri);
}

bool KoncludeReasoner::hasNativeJustification(const std::string& subIri, const std::string& superIri) {
    return mImpl->hasNativeJustification(subIri, superIri);
}
