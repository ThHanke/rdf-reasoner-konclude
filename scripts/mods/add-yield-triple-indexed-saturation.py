#!/usr/bin/env python3
"""Add a pthread yield after processCalculationJob in
createTripleIndexedIndividualsSaturationProcessingJob so that KPSet worker
pthreads (Web Workers) get CPU time to complete saturation jobs before the
precomp thread blocks on its wakeup semaphore.

Without ASYNCIFY, emscripten_sleep(0) is unavailable. std::this_thread::sleep_for
with a 1 ms duration maps to Atomics.wait() inside a Web Worker pthread, which
genuinely yields the calling worker and lets other workers run.
"""
import sys

src = sys.stdin.buffer.read()

old = (
    b"\t\t\t\ttotallyPreCompItem->setSaturationCalculationJob(satCalculationJob);\r\n"
    b"\t\t\t\tprocessCalculationJob(satCalculationJob,totallyPreCompItem,satTestingItem);\r\n"
    b"\t\t\t}"
)

new = (
    b"\t\t\t\ttotallyPreCompItem->setSaturationCalculationJob(satCalculationJob);\r\n"
    b"\t\t\t\tprocessCalculationJob(satCalculationJob,totallyPreCompItem,satTestingItem);\r\n"
    b"#ifdef __EMSCRIPTEN__\r\n"
    b"\t\t\t\t// Yield this pthread so KPSet worker Web Workers get CPU time to start\r\n"
    b"\t\t\t\t// their saturation jobs.  Without this, the precomp thread blocks on\r\n"
    b"\t\t\t\t// mProcessingWakeUpSemaphore.acquire() via Atomics.wait() before KPSet\r\n"
    b"\t\t\t\t// workers are scheduled, causing a deadlock with restriction ontologies.\r\n"
    b"\t\t\t\t// sleep_for maps to Atomics.wait() in a worker pthread -- safe here.\r\n"
    b"\t\t\t\tstd::this_thread::sleep_for(std::chrono::milliseconds(1));\r\n"
    b"#endif\r\n"
    b"\t\t\t}"
)

if old not in src:
    sys.stderr.write("ERROR: target string not found in source\n")
    sys.exit(1)

sys.stdout.buffer.write(src.replace(old, new, 1))
