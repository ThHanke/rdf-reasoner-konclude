// WASM override for CPrecomputationManager.cpp
//
// Problem: the upstream creates a new CTotallyPrecomputationThread per ontology
// (one per reasoning call).  In WASM, this exhausts the Emscripten pthread pool
// (~5 threads/call × 5 calls = pool full) and the 5th call's precomputation
// thread silently fails to start.
//
// Fix: reuse a single CTotallyPrecomputationThread for the lifetime of the
// CPrecomputationManager.  Each reasoning call sends a new CPrecomputeOntologyEvent
// to the same thread; the thread processes them sequentially.  No pool exhaustion,
// no dangling-pointer issues from deleting threads that are still registered in
// the STPU's mEventHandlerLinker.

#include "Reasoner/Kernel/Manager/CPrecomputationManager.h"
#include "Reasoner/Kernel/Manager/CReasonerManager.h"

#include "Reasoner/Consistiser/CTotallyPrecomputationThread.h"
#include "Reasoner/Consistiser/CIncrementalPrecomputationThread.h"


namespace Konclude {

    namespace Reasoner {

        namespace Kernel {

            namespace Manager {


                CPrecomputationManager::CPrecomputationManager(CReasonerManager* reasonerManager) {
                    mReasonerManager = reasonerManager;
                }


                CPrecomputationManager::~CPrecomputationManager() {
                }

                CPrecomputator* CPrecomputationManager::getPrecomputator(CConcreteOntology *ontology, CConfigurationBase *config) {
                    // Return the singleton precomputator regardless of which ontology is requested.
                    // Upstream design: one precomputator per ontology (created lazily, never freed).
                    // WASM fix: create ONE and reuse it — avoids pthread pool exhaustion and the
                    // dangling-pointer crash that results from deleting a thread still registered
                    // in the STPU's mEventHandlerLinker.
                    CPrecomputator* precomputator = nullptr;
                    mReadWriteLock.lockForRead();
                    if (!mOntoPrecomputatorHash.isEmpty()) {
                        precomputator = mOntoPrecomputatorHash.constBegin().value();
                    }
                    mReadWriteLock.unlock();

                    if (!precomputator) {
                        mReadWriteLock.lockForWrite();
                        if (!mOntoPrecomputatorHash.isEmpty()) {
                            precomputator = mOntoPrecomputatorHash.constBegin().value();
                        }
                        if (!precomputator) {
                            precomputator = new CTotallyPrecomputationThread(mReasonerManager);
                            mOntoPrecomputatorHash.insert(ontology, precomputator);
                        }
                        mReadWriteLock.unlock();
                    }

                    return precomputator;
                }

            }; // end namespace Manager

        }; // end namespace Kernel

    }; // end namespace Reasoner

}; // end namespace Konclude
