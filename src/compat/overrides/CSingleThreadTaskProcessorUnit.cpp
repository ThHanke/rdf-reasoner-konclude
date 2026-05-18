/*
 *		Copyright (C) 2013-2015, 2019 by the Konclude Developer Team.
 *		WASM override: replaces vendor CSingleThreadTaskProcessorUnit.cpp.
 *		Restores original semaphore-based blocking from the upstream source
 *		(signalizeEvent releases, processingLoop acquires).
 */

#include "Scheduler/CSingleThreadTaskProcessorUnit.h"

#include <unordered_map>
#include <mutex>

namespace Konclude {
	namespace Scheduler {
		// Per-STPU mutex held for the duration of every completeTask() call.
		// classify() acquires it (once, without contention) after prepareOntology() returns
		// to ensure the STPU thread has fully exited completeTask() before the reasoner
		// is deleted.  See: docs/solutions/architecture-patterns/
		// wasm-pthread-concurrency-architecture-2026-05-08.md
		static std::unordered_map<CSingleThreadTaskProcessorUnit*, std::mutex*> sCompleteTaskGuards;
		static std::mutex sGuardsMutex;

		std::mutex* stpuGetCompleteTaskGuard(CSingleThreadTaskProcessorUnit* stpu) {
			std::lock_guard<std::mutex> lk(sGuardsMutex);
			auto it = sCompleteTaskGuards.find(stpu);
			return it != sCompleteTaskGuards.end() ? it->second : nullptr;
		}

		// Accessor subclass: only purpose is to reach the protected mProcessingStopped
		// field so we can reset it to false before restarting the STPU thread.
		// The cast is safe because the actual dynamic type IS CSingleThreadTaskProcessorUnit
		// (not a deeper subclass), so the memory layout is identical.
		class StpuRestartAccessor : public CSingleThreadTaskProcessorUnit {
		public:
			void resetStopped() { mProcessingStopped = false; }
		};

		// Reset mProcessingStopped so that startProcessing() → processingLoop() will
		// not exit immediately after the STPU is restarted for the next classify() call.
		void stpuResetStopped(CSingleThreadTaskProcessorUnit* stpu) {
			static_cast<StpuRestartAccessor*>(stpu)->resetStopped();
		}
	}
}

namespace Konclude {

	namespace Scheduler {



		CSingleThreadTaskProcessorUnit::CSingleThreadTaskProcessorUnit(CTaskHandleAlgorithm* taskHandleAlgo, CConsiderateMemoryPoolProvider* memoryPoolProvider) : CThread("TaskProcessingUnitThread") {
			mTaskProcessingQueue = nullptr;
			mTaskCompletionQueue = nullptr;
			mTaskStatusPropagator = nullptr;
			mCallbackExecuter = nullptr;
			mMemoryPoolProvider = memoryPoolProvider;
			if (!mMemoryPoolProvider) {
				mMemoryPoolProvider = new CNewAllocationMemoryPoolProvider();
			}
			mMemoryAllocator = new CTaskHandleLimitedReserveMemoryPoolAllocationManager(mMemoryPoolProvider,30000,30);
			mTaskProcessorContext = new CTaskProcessorContextBase(this,mMemoryAllocator);
			mTaskHandleAlgo = taskHandleAlgo;
			mProcessingBlocked = true;
			mEventHandler = new CQueuedLinkedEventHandler(this,this);

			CXLinker<CEventHandler*>* eventHandlerLinker = new CXLinker<CEventHandler*>(mEventHandler,nullptr);
			mEventHandlerLinker = eventHandlerLinker;

			mProcessingStopped = false;

			mStatComputionTime = 0;
			mStatBlockingTime = 0;

			mLastProcessingStartedTag = 0;
			mLastProcessingStartRequestTag = 0;
			mTaskProcessingCount = 0;
			mTaskSchedulingCount = 0;
			mStatRecievedScheduleTasks = 0;
			mStatRemovedTasks = 0;
			mEventSignalized = false;
			mThreadBlocked = false;
			mDebugLastProcessedTask = nullptr;
			mDebugLastCompletedTask = nullptr;
			mTaskSchedulingQueue = nullptr;

			std::lock_guard<std::mutex> lk(sGuardsMutex);
			sCompleteTaskGuards[this] = new std::mutex();
		}

		CSingleThreadTaskProcessorUnit::~CSingleThreadTaskProcessorUnit() {
			// Unblock the processing thread so it can observe mProcessingStopped and
			// return from processingLoop() before ~CThread() calls pthread_join.
			mProcessingStopped = true;
			mProcessingWakeUpSemaphore.release();

			std::lock_guard<std::mutex> lk(sGuardsMutex);
			auto it = sCompleteTaskGuards.find(this);
			if (it != sCompleteTaskGuards.end()) {
				delete it->second;
				sCompleteTaskGuards.erase(it);
			}
		}


		cint64 CSingleThreadTaskProcessorUnit::countProcessingTasksMemoryPools() {
			cint64 memoryPoolCount = 0;
			CTask* taskProcessingQueueIt = mTaskProcessingQueue;
			while (taskProcessingQueueIt) {
				CMemoryPool* memoryPoolIt = taskProcessingQueueIt->getMemoryPools();
				memoryPoolCount += memoryPoolIt->getCount();
				taskProcessingQueueIt = taskProcessingQueueIt->getNext();
			}
			return memoryPoolCount;
		}


		cint64 CSingleThreadTaskProcessorUnit::countProcessedOpenTasksMemoryPools() {
			cint64 memoryPoolCount = 0;
			QSet<CTask*> taskSet;
			QList<CTask*> taskList;
			CTask* taskProcessingQueueIt = mTaskProcessingQueue;
			while (taskProcessingQueueIt) {
				if (taskProcessingQueueIt->getParentTask()) {
					if (!taskSet.contains(taskProcessingQueueIt->getParentTask())) {
						taskSet.insert(taskProcessingQueueIt->getParentTask());
						taskList.append(taskProcessingQueueIt->getParentTask());
					}
				}
				taskProcessingQueueIt = taskProcessingQueueIt->getNext();
			}

			while (!taskList.isEmpty()) {
				CTask* task = taskList.takeFirst();
				if (task->getParentTask()) {
					if (!taskSet.contains(task->getParentTask())) {
						taskSet.insert(task->getParentTask());
						taskList.append(task->getParentTask());
					}
				}
				CMemoryPool* memoryPoolIt = task->getMemoryPools();
				memoryPoolCount += memoryPoolIt->getCount();
			}

			return memoryPoolCount;
		}


		cint64 CSingleThreadTaskProcessorUnit::closeOpenTasksMemoryPools() {
			cint64 closedMemoryPoolCount = 0;
			QSet<CTask*> taskSet;
			QList<CTask*> taskList;
			CTask* taskProcessingQueueIt = mTaskProcessingQueue;
			while (taskProcessingQueueIt) {
				if (!taskSet.contains(taskProcessingQueueIt)) {
					taskSet.insert(taskProcessingQueueIt);
					taskList.append(taskProcessingQueueIt);
				}
				taskProcessingQueueIt = taskProcessingQueueIt->getNext();
			}

			while (!taskList.isEmpty()) {

				CTask* task = taskList.takeFirst();
				CBooleanTaskResult* satResult = (CBooleanTaskResult*)task->getTaskResult();
				if (satResult) {
					satResult->installResult(false);
				}
				CCallbackData* callbackLinkerIt = task->getCallbackLinker();
				while (callbackLinkerIt) {
					CCallbackData* callback = callbackLinkerIt;
					callbackLinkerIt = callbackLinkerIt->getNext();
					if (mCallbackExecuter) {
						mCallbackExecuter->executeCallback(task,callback);
						INCTASKPROCESSINGSTAT(mStats.incStatisticCallbacksExecutedCount(1));
					} else {
						callback->doCallback();
					}
				}
				if (task->getParentTask()) {
					if (!taskSet.contains(task->getParentTask())) {
						taskSet.insert(task->getParentTask());
						taskList.append(task->getParentTask());
					}
				}
				CMemoryPool* memoryPoolIt = task->getMemoryPools();
				closedMemoryPoolCount += memoryPoolIt->getCount();
				mMemoryAllocator->releaseMemoryPoolContainer(task);
			}

			mTaskProcessingQueue = 0;
			mTaskCompletionQueue = 0;

			return closedMemoryPoolCount;
		}


		CTaskHandleAlgorithm* CSingleThreadTaskProcessorUnit::getTaskHandleAlgorithm() {
			return mTaskHandleAlgo;
		}

		CSingleThreadTaskProcessorUnit* CSingleThreadTaskProcessorUnit::installCallbackExecuter(CTaskCallbackExecuter* callbackExecuter) {
			mCallbackExecuter = callbackExecuter;
			return this;
		}

		CSingleThreadTaskProcessorUnit* CSingleThreadTaskProcessorUnit::installStatusPropagator(CTaskStatusPropagator* statusPropagator) {
			mTaskStatusPropagator = statusPropagator;
			return this;
		}

		cint64 CSingleThreadTaskProcessorUnit::getTaskProcessingCount() {
			return mTaskProcessingCount + mTaskSchedulingCount;
		}

		bool CSingleThreadTaskProcessorUnit::canDispenseProcessingTasks() {
			return false;
		}

		bool CSingleThreadTaskProcessorUnit::requiresProcessingTasks() {
			return false;
		}

		bool CSingleThreadTaskProcessorUnit::requiresSchedulingTasks() {
			return false;
		}

		cint64 CSingleThreadTaskProcessorUnit::countDispensableProcessingTasks() {
			return 0;
		}

		cint64 CSingleThreadTaskProcessorUnit::getRecievedTasks() {
			return 0;
		}

		cint64 CSingleThreadTaskProcessorUnit::countScheduleableProcessingTasks() {
			return 0;
		}

		bool CSingleThreadTaskProcessorUnit::requiresTaskDispenseNotification(cint64 &updateDispenseNotificationTag) {
			return false;
		}


		CTaskProcessingStatistics* CSingleThreadTaskProcessorUnit::getTaskProcessingStatistics() {
			return &mStats;
		}

		cint64 CSingleThreadTaskProcessorUnit::getStatisticBlockingTime() {
			cint64 blockTime = mStatBlockingTime;
#ifdef KONCLUDE_SCHEDULER_TASK_THREADS_TIME_STATISTICS
			if (mThreadBlocked) {
				blockTime += mBlockingTimer.elapsed();
			}
#endif
			return blockTime;
		}

		cint64 CSingleThreadTaskProcessorUnit::getStatisticComputionTime() {
			cint64 compTime = mStatComputionTime;
#ifdef KONCLUDE_SCHEDULER_TASK_THREADS_TIME_STATISTICS
			if (!mThreadBlocked) {
				compTime += mComputionTimer.elapsed();
			}
#endif
			return compTime;
		}

		CEventHandler* CSingleThreadTaskProcessorUnit::getEventHandler() {
			return mEventHandler;
		}

		CTaskEventHandlerBasedProcessor* CSingleThreadTaskProcessorUnit::installScheduler(CTaskEventHandlerBasedScheduler* scheduler) {
			return this;
		}

		CTaskSchedulerCommunicator* CSingleThreadTaskProcessorUnit::createSchedulerProcessorCommunication(CTaskEventHandlerBasedProcessor* taskProcessor) {
			return nullptr;
		}

		CTaskReserveQueueConsumer* CSingleThreadTaskProcessorUnit::createTaskReserveQueueConsumer(CTaskEventHandlerBasedProcessor* taskProcessor) {
			return nullptr;
		}


		CSingleThreadTaskProcessorUnit* CSingleThreadTaskProcessorUnit::startProcessing() {
			fprintf(stderr, "{stpu} startProcessing: isRunning=%d mProcessingStopped=%d mLastStartedTag=%lld mLastRequestTag=%lld\n",
				(int)isRunning(), (int)mProcessingStopped,
				(long long)mLastProcessingStartedTag, (long long)mLastProcessingStartRequestTag);
			// Call 2+: unconditionally drain stale signals/events and reset tags so
			// that signalizeEvent() can release the semaphore for the new classify()
			// call.  Stale KPSet pthread callbacks arriving after the previous
			// classify() returned increment mLastProcessingStartRequestTag without a
			// matching semaphore acquire, making startedTag < requestTag.  When they
			// diverge, signalizeEvent()'s equality guard silently skips every release,
			// permanently stalling the STPU.
			if (mLastProcessingStartedTag > 0) {
				// Drain stale semaphore counts first (non-blocking).
				while (mProcessingWakeUpSemaphore.tryAcquire(1, 0)) {}

				// Drain stale events from the channel handler (two passes for safety).
				if (mEventHandler->needEventProcessing()) {
					CEventLinker* li = mEventHandler->takeEvents(nullptr);
					int drained = 0;
					while (li) {
						CEventLinker* next = li->getNextEventLinker();
						CEvent* staleEvent = li->getData();
						if (staleEvent) mMemoryAllocator->releaseMemoryPoolContainer(staleEvent);
						li = next;
						++drained;
					}
					if (drained > 0) {
						fprintf(stderr, "{stpu} startProcessing: drained %d stale events\n", drained);
					}
				}
				if (mEventHandler->needEventProcessing()) {
					CEventLinker* li = mEventHandler->takeEvents(nullptr);
					while (li) {
						CEventLinker* next = li->getNextEventLinker();
						CEvent* staleEvent = li->getData();
						if (staleEvent) mMemoryAllocator->releaseMemoryPoolContainer(staleEvent);
						li = next;
					}
				}

				// Drain any semaphore counts that arrived with the stale events.
				while (mProcessingWakeUpSemaphore.tryAcquire(1, 0)) {}

				// Reset tags so signalizeEvent()'s equality guard passes again.
				mLastProcessingStartRequestTag = mLastProcessingStartedTag;

				// Reset mProcessingStopped (set by stopProcessing() in some code paths)
				// so processingLoop() does not exit immediately on next entry.
				mProcessingStopped = false;
			}

			if (!isRunning()) {
				startThread();
				postEvent(new Concurrent::Events::CHandleEventsEvent());
				// postEvent() → signalizeEvent() incremented mLastProcessingStartRequestTag
				// by 1.  Pre-sync the started tag so that prepareOntology()'s signalizeEvent()
				// call (on the manager thread) sees equal tags before the STPU pthread has had
				// a chance to acquire the semaphore and update the tag itself.
				mLastProcessingStartedTag = mLastProcessingStartRequestTag;
			} else if (!mEventSignalized) {
				// Thread already alive (call 2+): post CHandleEventsEvent to re-enter
				// processingLoop().  Only needed if the previous processingLoop() exited
				// (mProcessingStopped path) or the thread is idle.
				postEvent(new Concurrent::Events::CHandleEventsEvent());
				mLastProcessingStartedTag = mLastProcessingStartRequestTag;
			}
			return this;
		}

		CSingleThreadTaskProcessorUnit* CSingleThreadTaskProcessorUnit::stopProcessing() {
			mProcessingStopped = true;
			return this;
		}

		CThreadActivator* CSingleThreadTaskProcessorUnit::signalizeEvent() {
			mEventSignalized = true;
			if (mProcessingBlocked) {
				// reactivate processing — wake the blocking STPU thread
				if (mLastProcessingStartedTag == mLastProcessingStartRequestTag) {
					++mLastProcessingStartRequestTag;
					mProcessingWakeUpSemaphore.release();
					fprintf(stderr, "{stpu} signalizeEvent: released sem, requestTag=%lld\n", (long long)mLastProcessingStartRequestTag);
				} else {
					fprintf(stderr, "{stpu} signalizeEvent: SKIP (startedTag=%lld requestTag=%lld)\n",
						(long long)mLastProcessingStartedTag, (long long)mLastProcessingStartRequestTag);
				}
			} else {
				fprintf(stderr, "{stpu} signalizeEvent: not blocked (mEventSignalized set)\n");
			}
			return this;
		}


		bool CSingleThreadTaskProcessorUnit::processControlEvents(QEvent::Type type, CControlEvent *event) {
			if (CThread::processControlEvents(type,event)) {
				return true;
			} else {
				if (type == Concurrent::Events::CHandleEventsEvent::EVENTTYPE) {
#ifdef KONCLUDE_SCHEDULER_TASK_THREADS_TIME_STATISTICS
					mComputionTimer.start();
#endif
					processingLoop();
					return true;
				}
			}
			return false;
		}

		bool CSingleThreadTaskProcessorUnit::processingLoop() {
			fprintf(stderr, "{stpu} processingLoop: entered (mProcessingBlocked=%d mProcessingStopped=%d)\n",
				(int)mProcessingBlocked, (int)mProcessingStopped);
			bool eventSafeguardProcessed = false;
			while (!mProcessingStopped) {
				if (!mTaskProcessingQueue && mProcessingBlocked) {
					// block until signalizeEvent() releases the semaphore
#ifdef KONCLUDE_SCHEDULER_TASK_THREADS_TIME_STATISTICS
					mStatComputionTime += mComputionTimer.elapsed();
					mBlockingTimer.start();
#endif
					INCTASKPROCESSINGSTAT(mStats.incStatisticThreadsBlockedCount(1));
					mThreadBlocked = true;
					mProcessingWakeUpSemaphore.acquire(1);
					mThreadBlocked = false;
#ifdef KONCLUDE_SCHEDULER_TASK_THREADS_TIME_STATISTICS
					mStatBlockingTime += mBlockingTimer.elapsed();
					mComputionTimer.start();
#endif
					mLastProcessingStartedTag = mLastProcessingStartRequestTag;
					// Exit immediately if woken for shutdown — don't touch event handlers
					// or task queues that may be partially destroyed.
					if (mProcessingStopped) {
						fprintf(stderr, "{stpu} processingLoop: mProcessingStopped=1 at semaphore, exiting\n");
						continue;
					}
				}
				mProcessingBlocked = false;
				eventSafeguardProcessed = false;
				while (mEventSignalized) {
					bool eventsProcessed = handleEvents();
				}
				if (mTaskProcessingQueue) {
					CTask* processingTask = mTaskProcessingQueue;
					mTaskProcessingQueue = mTaskProcessingQueue->getNext();
					cint64 taskDepth = processingTask->getTaskDepth();

					bool continueProcessing = processTask(processingTask);
					if (continueProcessing) {
						processingTask->getTaskStatus()->setTaskQUEUEDState();
						if (mTaskProcessingQueue) {
							mTaskProcessingQueue = mTaskProcessingQueue->insertNextSorted(processingTask);
						} else {
							mTaskProcessingQueue = processingTask;
						}
					} else {
						INCTASKPROCESSINGSTAT(mStats.incStatisticTasksProcessedDepthCount(taskDepth,1));
						INCTASKPROCESSINGSTAT(mStats.incStatisticTasksProcessedCount(1));
						--mTaskProcessingCount;
						++mStatRemovedTasks;
					}
				}
				if (!mTaskProcessingQueue && mTaskSchedulingQueue) {
					CTask* nextTask = mTaskSchedulingQueue;
					mTaskSchedulingQueue = mTaskSchedulingQueue->getNext();
					nextTask->clearNext();
					--mTaskSchedulingCount;
					addProcessingTask(nextTask);
				}

				if (!mTaskProcessingQueue) {
					while (mEventSignalized || !eventSafeguardProcessed) {
						bool eventsProcessed = handleEvents();
						if (eventsProcessed) {
							eventSafeguardProcessed = false;
							mProcessingBlocked = false;
						} else if (!mProcessingBlocked) {
							mProcessingBlocked = true;
						} else if (!eventSafeguardProcessed) {
							eventSafeguardProcessed = true;
						}
					}
				}
			}
			return true;
		}

		bool CSingleThreadTaskProcessorUnit::processEvent(CEvent *event, CContext* handlerContext) {
			cint64 eventID = event->getEventTypeID();
			if (eventID == CSendTaskProcessEvent::EVENTTYPEID) {
				CTask* task = ((CSendTaskProcessEvent*)event)->getTask();
				addProcessingTask(task);
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			} else if (eventID == CSendTaskScheduleEvent::EVENTTYPEID) {
				++mStatRecievedScheduleTasks;
				CTask* task = ((CSendTaskScheduleEvent*)event)->getTask();
				if (!mTaskProcessingQueue) {
					addProcessingTask(task);
				} else {
					++mTaskSchedulingCount;
					if (mTaskSchedulingQueue) {
						mTaskSchedulingQueue = mTaskSchedulingQueue->append(task);
					} else {
						mTaskSchedulingQueue = task;
					}
				}
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			} else if (eventID == CRequestProcessTaskEvent::EVENTTYPEID) {
				// not supported
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			} else if (eventID == CResponseScheduleTaskEvent::EVENTTYPEID) {
				// not supported
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			} else if (eventID == CSendTaskCompleteEvent::EVENTTYPEID) {
				CTask* task = ((CSendTaskCompleteEvent*)event)->getTask();
				completeTask(task);
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			} else if (eventID == CTaskAdditionalAllocationEvent::EVENTTYPEID) {
				CTaskAdditionalAllocationEvent* taskAddAllocEvent = (CTaskAdditionalAllocationEvent*)event;
				CTask* task = taskAddAllocEvent->getTask();
				CMemoryPool* addMemoryPools = taskAddAllocEvent->getAdditionalAllocatedMemoryPools();
				task->appendMemoryPool(addMemoryPools);
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			} else if (eventID == CRequestScheduleTaskEvent::EVENTTYPEID) {
				// this unit is also the scheduler
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			} else {
				mMemoryAllocator->releaseMemoryPoolContainer(event);
				return true;
			}
			return false;
		}


		CTaskProcessorCommunicator* CSingleThreadTaskProcessorUnit::communicateTaskComplete(CTask* task) {
			task->getTaskStatus()->setTaskFINISHEDState();
			completeTask(task);
			return this;
		}

		CTaskProcessorCommunicator* CSingleThreadTaskProcessorUnit::communicateTaskError(CTask* task) {
			task->getTaskStatus()->setTaskFINISHEDState();
			completeTask(task);
			return this;
		}


		bool CSingleThreadTaskProcessorUnit::addProcessingTask(CTask* task) {
			CTask* newTask = task;
			CTask* newTaskIt = newTask;
			cint64 taskCount = 0;
			while (newTaskIt) {
				newTaskIt->getTaskStatus()->setTaskQUEUEDState();
				newTaskIt = newTaskIt->getNext();
				INCTASKPROCESSINGSTAT(mStats.incStatisticTasksAddedCount(1));
				++taskCount;
			}
			mTaskProcessingCount += taskCount;
			if (!mTaskProcessingQueue) {
				mTaskProcessingQueue = newTask;
				newTask = newTask->getNext();
				mTaskProcessingQueue->clearNext();
			}
			if (newTask) {
				mTaskProcessingQueue = mTaskProcessingQueue->insertNextSorted(newTask);
			}
			return task != nullptr;
		}


		CTaskProcessorCommunicator* CSingleThreadTaskProcessorUnit::communicateTaskCreation(CTask* newTask) {
			INCTASKPROCESSINGSTAT(mStats.incStatisticTasksCreatedCount(newTask->getCount()));
			INCTASKPROCESSINGSTAT(mStats.incStatisticTasksCreatedDepthCount(newTask->getTaskDepth(),newTask->getCount()));

			addProcessingTask(newTask);
			return this;
		}

		CTaskProcessorCommunicator* CSingleThreadTaskProcessorUnit::communicateTaskAdditionalAllocation(CTask* task, CMemoryPool* additionalAllocatedMemoryPool) {
			task->appendMemoryPool(additionalAllocatedMemoryPool);
			return this;
		}


		bool CSingleThreadTaskProcessorUnit::verifyContinueTaskProcessing(CTask* task) {
			if (mEventSignalized) {
				return false;
			}
			if (!task->getTaskStatus()->isProcessable()) {
				return false;
			}
			if (mTaskProcessingQueue && mTaskProcessingQueue->getTaskPriority() > task->getTaskPriority()) {
				return false;
			}
			return true;
		}


		bool CSingleThreadTaskProcessorUnit::handleEvents() {
			bool handleNextRound = true;
			bool roundEventProcessed = false;
			bool eventProcessed = false;
			while (handleNextRound && !mProcessingStopped) {
				roundEventProcessed = false;
				CXLinker<CEventHandler*>* eventHandlerLinkerIt = mEventHandlerLinker;
				if (eventHandlerLinkerIt) {

					CEventHandler* eventHandler = eventHandlerLinkerIt->getData();
					if (eventHandler->needEventProcessing()) {
						cint64 handledEventCount = eventHandler->handleEvents(mTaskProcessorContext);
						INCTASKPROCESSINGSTAT(mStats.incStatisticEventsProcessedCount(handledEventCount));
						roundEventProcessed = handledEventCount > 0;
					}
					// round robin
					eventHandlerLinkerIt = eventHandlerLinkerIt->getNext();
					if (!eventHandlerLinkerIt) {
						if (mEventSignalized || roundEventProcessed) {
							handleNextRound = true;
							mEventSignalized = false;
						} else {
							handleNextRound = false;
						}
						eventHandlerLinkerIt = mEventHandlerLinker;
					}
					eventProcessed |= roundEventProcessed;
				} else {
					handleNextRound = false;
				}
			}
			return eventProcessed;
		}



		cint64 CSingleThreadTaskProcessorUnit::completeTask(CTask* task) {
			// Guard held for classify()'s quiesce-wait: after prepareOntology() returns,
			// classify() acquires this mutex to ensure the last completeTask() has fully
			// exited before reasoner.delete() frees mCallbackExecuter.
			std::lock_guard<std::mutex> completeTaskGuard(*sCompleteTaskGuards[this]);
			cint64 completedCount = 0;
			mTaskCompletionQueue = task->getLastListLink()->setNext(mTaskCompletionQueue);
			while (mTaskCompletionQueue) {
				CTask* completionTask = mTaskCompletionQueue;
				mTaskCompletionQueue = mTaskCompletionQueue->getNext();

				if (completionTask && !completionTask->hasActiveReferencedTask()) {
					mDebugLastCompletedTask = completionTask;

					CTask* parentTask = completionTask->getParentTask();
					bool upPropagation = false;
					if (mTaskStatusPropagator && mTaskStatusPropagator->completeTaskStatus(completionTask,upPropagation)) {
						if (parentTask && upPropagation) {
							updateTaskStatus(parentTask);
						}
					}
					completionTask->completeTask();
					completionTask->getTaskStatus()->setTaskCOMPLETEDState();
					bool memoryReleaseable = completionTask->getTaskStatus()->isMemoryReleaseable();
					if (parentTask) {
						parentTask->decActiveReferenceCount();
						if (!parentTask->hasActiveReferencedTask()) {
							mTaskCompletionQueue = parentTask->setNext(mTaskCompletionQueue);
						}
					}
					if (completionTask) {
						// callbacks
						CCallbackData* callbackLinkerIt = completionTask->getCallbackLinker();
							while (callbackLinkerIt) {
							CCallbackData* callback = callbackLinkerIt;
							callbackLinkerIt = callbackLinkerIt->getNext();
							if (mCallbackExecuter) {
								mCallbackExecuter->executeCallback(completionTask,callback);
								INCTASKPROCESSINGSTAT(mStats.incStatisticCallbacksExecutedCount(1));
							} else {
								callback->doCallback();
							}
						}
					}
					if (memoryReleaseable) {
						for (CDeletionLinker* deletionLinkerIt = completionTask->takeDeletionLinker(); deletionLinkerIt; deletionLinkerIt = deletionLinkerIt->getNext()) {
							deletionLinkerIt->deleteObject();
						}
						mMemoryAllocator->releaseMemoryPoolContainer(completionTask);
					}
					completedCount++;
				}
			}
			INCTASKPROCESSINGSTAT(mStats.incStatisticTasksCompletedCount(completedCount));
			return completedCount;
		}


		bool CSingleThreadTaskProcessorUnit::processTask(CTask* task) {
			mDebugLastProcessedTask = task;
			task->clearNext();
			task->getTaskStatus()->setTaskPROCESSINGState();
			return mTaskHandleAlgo->handleTask(mTaskProcessorContext,task);
		}


		CTaskProcessorCommunicator* CSingleThreadTaskProcessorUnit::communicateTaskRelevant(CTask* task) {
			// nothing to do for single processor unit
			return this;
		}


		CTaskProcessorCommunicator* CSingleThreadTaskProcessorUnit::communicateTaskStatusUpdate(CTask* task) {
			updateTaskStatus(task);
			return this;
		}


		bool CSingleThreadTaskProcessorUnit::updateTaskStatusDown(CTask* task, cint64 depth) {
			if (depth < 1000) {
				bool downProp = false;
				bool upProp = false;
				CTask* updateTask = task;
				updateTask->setTaskID(-1);
				if (mTaskStatusPropagator && mTaskStatusPropagator->updateTaskStatus(updateTask, downProp, upProp)) {
					INCTASKPROCESSINGSTAT(mStats.incStatisticTasksUpdatedCount(1));

					if (downProp) {
						CXNegLinker<CTask*>* refTaskIt = updateTask->getReferencedTaskLinker();
						while (refTaskIt) {
							if (refTaskIt->isNegated()) {
								CTask* refTask = refTaskIt->getData();
								updateTaskStatusDown(refTask, depth + 1);
							}
							refTaskIt = refTaskIt->getNext();
						}
					}
				}

			} else {
				QList<CTask*> updateTaskList;
				updateTaskList.append(task);
				while (!updateTaskList.isEmpty()) {
					bool downProp = false;
					bool upProp = false;
					CTask* updateTask = updateTaskList.takeFirst();
					if (mTaskStatusPropagator && mTaskStatusPropagator->updateTaskStatus(updateTask, downProp, upProp)) {
						INCTASKPROCESSINGSTAT(mStats.incStatisticTasksUpdatedCount(1));

						if (downProp) {
							CXNegLinker<CTask*>* refTaskIt = updateTask->getReferencedTaskLinker();
							while (refTaskIt) {
								if (refTaskIt->isNegated()) {
									CTask* refTask = refTaskIt->getData();
									updateTaskList.append(refTask);
								}
								refTaskIt = refTaskIt->getNext();
							}
						}
					}

				}
			}
			return true;
		}


		bool CSingleThreadTaskProcessorUnit::updateTaskStatus(CTask* task) {
			CTask* updateTask = task;
			bool downProp = false;
			bool upProp = false;
			while (updateTask) {
				if (mTaskStatusPropagator && mTaskStatusPropagator->updateTaskStatus(updateTask,downProp,upProp)) {
					INCTASKPROCESSINGSTAT(mStats.incStatisticTasksUpdatedCount(1));
					if (downProp) {
						CXNegLinker<CTask*>* refTaskIt = updateTask->getReferencedTaskLinker();
						while (refTaskIt) {
							if (refTaskIt->isNegated()) {
								CTask* refTask = refTaskIt->getData();
								updateTaskStatusDown(refTask, 0);
							}
							refTaskIt = refTaskIt->getNext();
						}

					}
					if (upProp) {
						updateTask = updateTask->getParentTask();
					} else {
						updateTask = nullptr;
					}
				} else {
					updateTask = nullptr;
				}
			}
			return true;
		}



	}; // end namespace Scheduler

}; // end namespace Konclude
