/*
 *		Copyright (C) 2013-2015, 2019 by the Konclude Developer Team.
 *		WASM override: replaces vendor COntologyRealizingDynamicRequirmentCallbackData.cpp.
 *		Adds takeCallback() — atomic exchange that prevents double-callback when a late
 *		CRealizingCalculatedCallbackEvent fires after callbackData is already freed.
 */

#include "Reasoner/Realizer/COntologyRealizingDynamicRequirmentCallbackData.h"

namespace Konclude {

	namespace Reasoner {

		namespace Realizer {


			COntologyRealizingDynamicRequirmentCallbackData::COntologyRealizingDynamicRequirmentCallbackData(CCallbackData* callback) {
				mCallback = callback;
				mProcessingRequirmentCount = 0;
			}


			COntologyRealizingDynamicRequirmentCallbackData* COntologyRealizingDynamicRequirmentCallbackData::incProcessingRequirmentCount(cint64 incCount) {
				mProcessingRequirmentCount += incCount;
				return this;
			}


			COntologyRealizingDynamicRequirmentCallbackData* COntologyRealizingDynamicRequirmentCallbackData::decProcessingRequirmentCount(cint64 decCount) {
				mProcessingRequirmentCount -= decCount;
				return this;
			}

			COntologyRealizingDynamicRequirmentCallbackData* COntologyRealizingDynamicRequirmentCallbackData::setProcessingFinishedCallback(CCallbackData* callback) {
				mCallback = callback;
				return this;
			}

			cint64 COntologyRealizingDynamicRequirmentCallbackData::getCurrentProcessingRequirmentCount() {
				return mProcessingRequirmentCount;
			}

			bool COntologyRealizingDynamicRequirmentCallbackData::hasCurrentProcessingRequirmentCount() {
				return mProcessingRequirmentCount > 0;
			}

			CCallbackData* COntologyRealizingDynamicRequirmentCallbackData::getProcessingFinishedCallback() {
				return mCallback;
			}

			CCallbackData* COntologyRealizingDynamicRequirmentCallbackData::takeCallback() {
				return mCallback.exchange(nullptr, std::memory_order_acq_rel);
			}

			COntologyRealizingDynamicRequirmentProcessingStatistics* COntologyRealizingDynamicRequirmentCallbackData::getStatistics() {
				return &mStatistics;
			}


		}; // end namespace Realizer

	}; // end namespace Reasoner

}; // end namespace Konclude
