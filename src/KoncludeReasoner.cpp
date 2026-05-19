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
using namespace Konclude::Parser;


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

    // Reasoning infrastructure
    WasmReasonerManagerThread*    mReasonerManager  = nullptr;
    CClassificationManager*       mClassManager     = nullptr;

    // Configured parallel worker count (set after initializeManager).
    int mProcessorCount = 1;

    // Result flags
    bool mClassified          = false;
    bool mLoadError           = false;
    bool mRealized            = false;
    bool mHasIndividualsHint  = false; // true if owl:NamedIndividual triples seen

    // Buffer for buildInferredTripleBuffer() output
    std::vector<uint8_t> mResultBuffer;
    int mResultBufferPtr = 0;

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
        delete mPreviousOntology;
        delete mOntology;        // safe: all background threads have stopped
        delete mConfigProvider;
    }

    void buildFreshOntology() {
        mOntology = new CConcreteOntology(mBasementConfig);
        // Each call must have a unique ontology ID.  CTerminology::CTerminology()
        // initialises mTerminologyID = 0 for every new object.  BackendAssCache keys
        // its per-ontology state by this ID: once OntologyData[0] is "completed" after
        // call 1, call 2 finds it "already complete" and ignores all new updates →
        // realization returns no individuals.  A monotonically increasing ID gives each
        // call its own fresh OntologyData slot.
        static qint64 sNextOntologyID = 1;
        mOntology->setOntologyID(sNextOntologyID++);
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
        delete mPreviousOntology;
        mPreviousOntology = mOntology;
        mOntology = nullptr;
        buildFreshOntology();
        mClassified         = false;
        mLoadError          = false;
        mRealized           = false;
        mHasIndividualsHint = false;
        mResultBuffer.clear();
        mResultBufferPtr = 0;
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
void KoncludeReasoner::loadTripleBuffer(int triplePtr, int tripleCount, int strTablePtr, int strTableLen) {
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

    // ── Detect owl:NamedIndividual assertions (realization gating) ───────────
    // If any (? rdf:type owl:NamedIndividual) triple is present, realization
    // requirements will be included in classify().  Absence = TBox-only path.
    if (!mImpl->mHasIndividualsHint) {
        static const char kRdfType[] = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        static const char kOwlNI[]   = "http://www.w3.org/2002/07/owl#NamedIndividual";
        uint32_t rtIdx = UINT32_MAX, niIdx = UINT32_MAX;
        for (uint32_t i = 0; i < count; ++i) {
            if (terms[i].len == sizeof(kRdfType)-1 &&
                memcmp(terms[i].ptr, kRdfType, sizeof(kRdfType)-1) == 0) rtIdx = i;
            if (terms[i].len == sizeof(kOwlNI)-1 &&
                memcmp(terms[i].ptr, kOwlNI, sizeof(kOwlNI)-1) == 0) niIdx = i;
        }
        if (rtIdx != UINT32_MAX && niIdx != UINT32_MAX) {
            const uint32_t* raw = reinterpret_cast<const uint32_t*>(triplePtr);
            for (int i = 0; i < tripleCount; ++i) {
                if (raw[i*3+1] == rtIdx && raw[i*3+2] == niIdx) {
                    mImpl->mHasIndividualsHint = true;
                    break;
                }
            }
        }
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

    // ── Insert triples into model + CXLinker ─────────────────────────────────
    const uint32_t* triples = reinterpret_cast<const uint32_t*>(triplePtr);
    CXLinker<librdf_statement*>* statementLinker = tripleData->getRedlandStatementLinker();
    CXLinker<librdf_statement*>* lastStatementLinker = nullptr;
    if (statementLinker) {
        lastStatementLinker = statementLinker->getLastListLink();
    }

    for (int i = 0; i < tripleCount; ++i) {
        uint32_t sId = triples[i * 3 + 0];
        uint32_t pId = triples[i * 3 + 1];
        uint32_t oId = triples[i * 3 + 2];

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

    // ── Register data with the builder, then map triples → OWL axioms ────────
    // addTriplesData MUST be called before mapTriples so getLatestTriplesData(true)
    // returns this tripleData rather than null.
    builder->addTriplesData(tripleData);

    CConcreteOntologyRedlandTriplesDataExpressionMapper* mapper =
        new CConcreteOntologyRedlandTriplesDataExpressionMapper(builder);
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

    if (includeRealization && impl->mHasIndividualsHint) {
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

    bool hasIndividuals = impl->mOntology->getABox() &&
        impl->mOntology->getABox()->getIndividualVector(false) &&
        impl->mOntology->getABox()->getIndividualVector(false)->getItemCount() > 0;

    impl->mRealized = includeRealization && hasIndividuals &&
        stepDone(COntologyProcessingStep::OPSCONCEPTREALIZE);

    if (includeRealization && impl->mHasIndividualsHint) {
        impl->mReasonerManager->stopAndClearRealizers();
    }

    return impl->mClassified;
}

// classification ───────────────────────────────────────────────────────────────
// TBox only: class hierarchy + property hierarchy. No ABox realization.
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
// TBox + ABox: classification followed by individual type realization.
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
