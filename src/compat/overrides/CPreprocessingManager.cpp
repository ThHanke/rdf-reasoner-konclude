// WASM override for CPreprocessingManager.cpp
//
// Same pthread pool exhaustion problem as CPrecomputationManager.
// Fix: reuse a single CRequirementConfigPreprocessingThread for all calls.

#include "Reasoner/Kernel/Manager/CPreprocessingManager.h"
#include "Reasoner/Kernel/Manager/CReasonerManager.h"

#include "Reasoner/Preprocess/CRequirementConfigPreprocessingThread.h"


namespace Konclude {

    namespace Reasoner {

        namespace Kernel {

            namespace Manager {


                CPreprocessingManager::CPreprocessingManager(CReasonerManager* reasonerManager) {
                    mReasonerManager = reasonerManager;
                }


                CPreprocessingManager::~CPreprocessingManager() {
                }

                CPreprocessor* CPreprocessingManager::getPreprocessor(CConcreteOntology *ontology, CConfigurationBase *config) {
                    // Reuse singleton preprocessor thread — avoids pthread pool exhaustion.
                    CPreprocessor* preprocessor = nullptr;
                    mReadWriteLock.lockForRead();
                    if (!mOntoPreprocessHash.isEmpty()) {
                        preprocessor = mOntoPreprocessHash.constBegin().value();
                    }
                    mReadWriteLock.unlock();

                    if (!preprocessor) {
                        mReadWriteLock.lockForWrite();
                        if (!mOntoPreprocessHash.isEmpty()) {
                            preprocessor = mOntoPreprocessHash.constBegin().value();
                        }
                        if (!preprocessor) {
                            preprocessor = new CRequirementConfigPreprocessingThread(mReasonerManager);
                            mOntoPreprocessHash.insert(ontology, preprocessor);
                        }
                        mReadWriteLock.unlock();
                    }

                    return preprocessor;
                }

            }; // end namespace Manager

        }; // end namespace Kernel

    }; // end namespace Reasoner

}; // end namespace Konclude
