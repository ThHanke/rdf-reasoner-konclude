/*
 *		Copyright (C) 2013-2015, 2019 by the Konclude Developer Team.
 *		LGPLv3 — see vendor/konclude/ for full license text.
 *
 *		WASM override: replaces vendor/konclude/Source/Concurrent/CIntervalThread.cpp.
 *		Removes QObject::startTimer / killTimer calls — no OS event loop in WASM.
 *		Timers are tracked in-process but not driven by the OS; timer events fire
 *		only when explicitly triggered via postEvent.
 */
#include "Concurrent/CIntervalThread.h"


namespace Konclude {

	namespace Concurrent {


		CIntervalThread::CIntervalThread(QString threadIdentifierName, CWatchDog *watchDog) : CThread(threadIdentifierName,watchDog),mSyncTimerMutex(QMutex::Recursive) {
		}

		CIntervalThread::~CIntervalThread() {
		}



		void CIntervalThread::setTimerInterval(qint64 timerID, qint64 timerIntervalMilliSecs) {
			postEvent(new CTimerIntervalEvent(timerID,timerIntervalMilliSecs));
		}

		void CIntervalThread::startTimerWithInterval(qint64 timerID, qint64 timerIntervalMilliSecs) {
			postEvent(new CTimerIntervalEvent(timerID,timerIntervalMilliSecs,true));
		}


		void CIntervalThread::startTimerWithIntervalLimited(qint64 timerID, qint64 timerIntervalMilliSecs, qint64 remainingCallCount) {
			postEvent(new CTimerIntervalEvent(timerID,timerIntervalMilliSecs,true,false,remainingCallCount));
		}

		void CIntervalThread::startTimer(qint64 timerID) {
			postEvent(new CTimerIntervalEvent(timerID,-1,true));
		}



		void CIntervalThread::stopTimer(qint64 timerID) {

			mSyncTimerMutex.lock();

			if (timers.contains(timerID)) {
				CIntervalThreadData *timerData = timers.value(timerID);
				timerData->incDeactivateCount();
			}

			mSyncTimerMutex.unlock();

			postEvent(new CTimerIntervalEvent(timerID,-1,false,true));
		}


		void CIntervalThread::threadStarted() {
		}



		void CIntervalThread::threadStopped() {
			mSyncTimerMutex.lock();
			QList<CIntervalThreadData *> timerList = timers.values();
			for (CIntervalThreadData *timerData : timerList) {
				// WASM: no real OS timer to kill; just mark inactive.
				timerData->setTimerActive(false);
			}
			mSyncTimerMutex.unlock();
		}


		bool CIntervalThread::processEvents(QEvent *event) {
			if (CThread::processEvents(event)) {
				return true;
			} else if (event->type() == QEvent::Timer) {
				SETTASKDESCRIPTION("Process Timer Timeout");
				QTimerEvent *te = (QTimerEvent *)event;
				int timerThreadID = te->timerId();
				mSyncTimerMutex.lock();
				if (timerMapping.contains(timerThreadID)) {
					qint64 timerID = timerMapping.value(timerThreadID);
					if (timers.contains(timerID)) {
						CIntervalThreadData *timerData = timers.value(timerID);
						if (timerData->isTimerActive() && timerData->getDeactivateCount() <= 0) {
							if (timerData->hasRemainingTimerInvocations()) {
								timerData->decRemainingTimerInvocations(1);
								processTimer(timerID);
							} else {
								timerData->setTimerActive(false);
							}
						}
					}
				}
				mSyncTimerMutex.unlock();
				return true;
			}
			return false;
		}


		bool CIntervalThread::processControlEvents(QEvent::Type type, CControlEvent *event) {
			if (CThread::processControlEvents(type,event)) {
				return true;
			} else if (type == EVENTTIMERINTERVAL) {
				SETTASKDESCRIPTION("Configure Timer Settings");
				CTimerIntervalEvent *tie = (CTimerIntervalEvent *)event;

				qint64 timerID = tie->getTimerID();
				qint64 timerInterval = tie->getTimerInterval();

				bool activateTimer = tie->getTimerActive();
				bool deactivateTimer = tie->getTimerDeactive();

				qint64 remTimerInvocs = tie->getRemainingTimerInvocations();


				CIntervalThreadData *timerData = 0;
				mSyncTimerMutex.lock();

				bool isNew = false;

				if (timers.contains(timerID)) {
					timerData = timers.value(timerID);
				} else {
					timerData = new CIntervalThreadData();
					timers.insert(timerID,timerData);
					isNew = true;
				}

				if (deactivateTimer) {
					timerData->decDeactivateCount();
				}

				bool reactivateTimer = false;

				if (timerInterval >= 0) {
					timerData->setInterval(timerInterval);
					bool isActive = timerData->isTimerActive();
					if (isActive) {
						reactivateTimer = true;
					}
				}
				timerData->setRemainingTimerInvocations(remTimerInvocs);

				if (deactivateTimer) {
					reactivateTimer = false;
					timerData->setTimerActive(false);
				}

				if (activateTimer || reactivateTimer) {
					qint64 deactivateCount = timerData->getDeactivateCount();
					if (deactivateCount <= 0) {
						int timerThreadID = timerData->getTimerThreadID();
						timerData->setTimerThreadID(timerThreadID);
						timerData->setTimerActive(true);
						timerMapping.insert(timerThreadID, timerID);
					}
				}

				mSyncTimerMutex.unlock();
				return true;
			}

			return false;
		}



	}; // end namespace Concurrent

}; // end namespace Konclude
