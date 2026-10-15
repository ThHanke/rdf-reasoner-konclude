---
module: reasoner-kernel
tags: [debugging, sequential-calls, memory-lifecycle, core-dump-analysis]
problem_type: multi-call state management
---

# Sequential Call Object Lifecycle Analysis

**Date:** 2026-10-08  
**Branch:** experiment/native-konclude-baseline (patches 000-008)  
**Tool:** `build-native/konclude_debug tests/fixtures` + GDB core dump  
**Pattern:** 8 sequential calls on shared KoncludeReasoner (same pattern as explanation-persistence.test.ts)

```
call 1: classify  (simple TBox, 4 triples)
call 2: classify  (simple TBox, 4 triples)
call 3: realize   (Roberts family, ~405 individuals)
call 4: realize   (Roberts family) ← CRASH (native) / HANG (WASM at call 7)
...
```

---

## State Dump Evidence

State dumps written to `/tmp/konclude-state-{N}-{phase}.json` by the debug harness.

| Call | Phase | end_set | start_set | stopped_realizers |
|------|-------|---------|-----------|-------------------|
| 1 | after-reset | 0 | 0 | 0 |
| 1 | after-load  | 0 | 0 | 0 |
| 1 | after-reason | **5** | **5** | 0 |
| 2 | after-reset | **5** | **5** | 0 |  ← NOT cleared
| 2 | after-load  | 5 | 5 | 0 |
| 2 | after-reason | **10** | **10** | 0 |
| 3 | after-reset | **10** | **10** | 0 |  ← NOT cleared
| 3 | after-load  | 10 | 10 | 0 |
| 3 | after-reason | **16** | **16** | **1** |  ← realizer not released
| 4 | after-reset | **16** | **16** | **1** |  ← realizer still alive
| 4 | after-load  | 16 | 16 | 1 |
| 4 | during-reason | **CRASH** | — | — |

**Growth rate:**
- Classify adds 5 entries per call
- Realize adds 6 entries per call
- `mProcessingEndMessageSet` and `mProcessingStartMessageSet` never cleared across `reset()`

---

## Crash Site (GDB post-mortem)

**Signal:** SIGSEGV  
**Thread:** KPSet class subsumption classifier thread  
**Stack:**
```
#0  COptimizedKPSetClassPossibleSubsumptionData::getClassItem(this=0x0)
    → COptimizedKPSetClassSubsumptionClassifierThread.cpp:83
    (null `this` pointer → dereferencing null `mClassItem`)

#1  flushPendingInitMessages(optKPSetClassificationItem=0x7f8a6000b040)
    → COptimizedKPSetClassSubsumptionClassifierThread.cpp:2079

#2  createNextSubsumtionTest()
    → COptimizedKPSetClassSubsumptionClassifierThread.cpp:967

#3  CSubsumptionClassifierThread::doNextPendingTests()

#4  CSubsumptionClassifierThread::processCustomsEvents(type=2001)

#5  CThread::event()
```

---

## Root Cause: Upstream Konclude Bug at Line 2078

**File:** `vendor/konclude/Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp`  
**Lines 2050–2090 — merge loop with iterator bug:**

```cpp
// Merge loop: advance both iterators while both have items
while (itPoss != itPossEnd && itDownPoss != itDownPossEnd) {
    // ... correctly uses itPoss.value() in the else branch
    ++itPoss;  // or ++itDownPoss
}

// Drain loop: drain remaining itPoss items
while (itPoss != itPossEnd) {
    // BUG: reads itDownPoss.value() — but itDownPoss is PAST END here!
    COptimizedKPSetClassPossibleSubsumptionData* possData = itDownPoss.value();  // line 2078
    // SHOULD BE: itPoss.value()
    possData->getClassItem();  // SIGSEGV: possData == nullptr (past-end iterator value)
    ++itPoss;  // Never advances itDownPoss — infinite loop if not crashing
}
```

**Evidence this is a copy-paste bug:** The identical pattern at line 2091–2100 (the `else if` branch) correctly uses `itPoss.value()`:
```cpp
} else if (downPropItem->isPossibleSubsumptionMapInitialized()) {
    for (...itPoss...) {
        COptimizedKPSetClassPossibleSubsumptionData* possData = itPoss.value();  // correct
```

**Why it only manifests in sequential calls:** In native Konclude (one process per ontology), each classification is fresh — the `downPropItemPossSubsumMap` is always empty or has the same items as `possSubsumMap`, so the merge loop exhausts both iterators simultaneously and the drain loop is never entered. In our multi-call port, reusing classifier state means `downPropItem` from call N has a populated `possSubsumptionMap` that diverges from the current call's map — the drain loop triggers and reads past-end.

---

## Objects Created Per Call (What Persists Incorrectly)

### `mProcessingEndMessageSet` / `mProcessingStartMessageSet` (in CReasonerManagerThread)

Type: `QSet<QPair<CConcreteOntology*, int>>`  
Added: when a processor (precomputer, classifier, realizer) starts/ends for an ontology  
Cleared: **NEVER** across `reset()`  
Effect: at call N, new `CConcreteOntology` may be allocated at recycled address from call N-5 → set lookup matches stale entry → callback routing misfires → hang

**Entries per call:**
- Classify: 5 entries (precomputer ×1 + classifier ×2 roles + class ×1 + consistency ×1)
- Realize: 6 entries (above + realizer ×1)

### Stopped Realizer State

`stopped_realizer_count=1` after call 3 (first realization), still 1 at call 4 start.  
The realizer from call 3 is tracked in `mStoppedRealizers` in `KoncludeReasoner` but its internal `COptimizedKPSetClassOntologyClassificationItem` still holds pointers to call-3 classification items.

### KPSet Classifier Internal State

`COptimizedKPSetClassOntologyClassificationItem* = 0x7f8a6000b040` (call 4 crash)  
This item references `downPropSet` containing `COptimizedKPSetClassTestingItem*` objects with populated `mPossibleSubsumptionMap`. These maps contain `COptimizedKPSetClassPossibleSubsumptionData*` entries. When `downPropItemPossSubsumMap` has fewer items than `possSubsumMap`, the drain loop hits the bug.

The `COptimizedKPSetClassSubsumptionClassifierThread` at `0x7f8a88274ee0` is **the same thread** reused from call 3. Its internal `mClassItemMap` retains testing items and their possible subsumption maps across calls.

---

## What Must Be Fixed

### Fix 1 (upstream bug): Line 2078 in flushPendingInitMessages

```cpp
// Change:
COptimizedKPSetClassPossibleSubsumptionData* possData = itDownPoss.value();
// To:
COptimizedKPSetClassPossibleSubsumptionData* possData = itPoss.value();
```

This must be a patch (`patches/009-...`). Without it, call 4 (any second realization after first realization changes the class hierarchy) crashes.

### Fix 2 (lifecycle): Clear processing sets in CReasonerManagerThread::reset()

`mProcessingEndMessageSet.clear()` + `mProcessingStartMessageSet.clear()` — either at start of `continueRequirementProcessing()` (patch-009 approach) or in `reset()` proper.

### Fix 3 (lifecycle): Classifier item state reset between calls

`COptimizedKPSetClassSubsumptionClassifierThread::mClassItemMap` must be cleared or reset when a new classification starts on a new ontology. Otherwise stale `downPropSet` entries from a previous call trigger the iterator bug above.

---

## Next Investigation Steps

1. **Rebuild native with upstream bug fix (line 2078)** — confirm crash moves to call 5+ or disappears
2. **Extend state dump** to track:
   - `mClassItemMap.size()` in KPSet classifier per call
   - `mStoppedRealizers.size()` per call boundary
   - `mOntologyIdentifierDataHash.size()` in BackendAssCache per call
3. **Run WASM under Valgrind** (if possible) or AddressSanitizer on native binary to find all dangling reads
4. **Diff calls 3 vs 4** in state dumps once call 4 reaches `after-reason`

---

## After Fix — State Dump Evidence (patches 009 + 011)

**Branch:** experiment/native-konclude-baseline (patches 000–008 + 009 + 011)  
**Result:** all 8 calls complete — no crash, no hang  
**Binary:** `build-native/konclude_debug` (clean build 2026-10-08)

| Call | Type | after-reason end_set | Stabilized? | stopped_realizers |
|------|------|----------------------|-------------|-------------------|
| 1 | classify | 5 | — (baseline) | 0 |
| 2 | classify | **5** | ✓ (was 10) | 0 |
| 3 | realize  | 6 | — (baseline) | 1 |
| 4 | realize  | **6** | ✓ (was CRASH) | 2 |
| 5 | classify | 5 | ✓ | 2 |
| 6 | classify | 5 | ✓ | 2 |
| 7 | realize  | **6** | ✓ (was HANG) | 3 |
| 8 | realize  | **6** | ✓ | 4 |

**Observation:** `processing_end_set_size` stabilizes at 5 (classify) and 6 (realize) per call, instead
of growing by 5–6 per call. Patch-009 clears the stale dedup sets at the start of each new pipeline
in `prepareOntologyReasoning()`, before `continueRequirementProcessing()` inserts the new call's entries.

Note: `after-reset` still shows the **prior call's** count (5 or 6) because the clear happens inside
the reasoning pipeline, not in `reset()`. This is correct and expected — cleared at pipeline start,
not at reset.

**Timing (from harness log):**
```
Call 3 (realize, first): ~20–30 s (KPSet parallel tests)
Call 4 (realize, second): similar — no TBox reuse yet (Phase B)
Call 7 (realize): completes without watchdog abort
Call 8 (realize): completes without watchdog abort
```

---

## Debug Commands

```bash
# Rebuild native
cmake --build build-native -j4

# Run with core dump
ulimit -c unlimited && ./build-native/konclude_debug tests/fixtures 2>/tmp/harness.log

# GDB post-mortem
gdb -batch -ex "thread apply all bt 10" ./build-native/konclude_debug core 2>/dev/null

# State diff between calls
jq -s 'map({call: .label, end: .processing_end_set_size, realizers: .stopped_realizer_count})' \
  /tmp/konclude-state-*-after-reason.json
```
