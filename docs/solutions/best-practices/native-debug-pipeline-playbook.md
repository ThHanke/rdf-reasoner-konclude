---
title: Native C++ debug pipeline — playbook (correctness hunts and performance tuning)
module: native/, src/native_repro.cpp, scripts/oracle, scripts/repro-sample.sh
tags: [native-harness, debugging, oracle, determinism, gdb, asan, performance, bisect]
problem_type: best-practice
updated: 2026-10-09
---

# Native debug pipeline playbook

How we found the non-deterministic lossy realization (patch 019) without WASM or N3, and how to reuse the same pipeline for other bugs and for performance tuning. Companion log of the actual investigation: `docs/solutions/debugging/realization-loss-investigation.md`.

## 1. The pieces

| Piece | Where | Role |
| --- | --- | --- |
| Native kernel build | `native/CMakeLists.txt` → `build-native/` | Same kernel sources, patches, overrides and shims as WASM, built with glibc + pthreads, `-g3 -O1`, `NATIVE_DEBUG_BUILD` defined |
| Harness | `src/native_repro.cpp` → `build-native/konclude_repro` | Loads an `.nt` fixture, keeps ONE `KoncludeReasoner` in memory, runs a scripted op sequence, decodes the result buffer (`resultAsSortedNTriples`), watchdog `abort()` on hang. Modes: `reload`, `reload-split`, `reuse`, `incr-abox` |
| Pristine-upstream oracle | `scripts/oracle/build-upstream.sh`, `gen-oracle.py`, `canon.py` | Real Qt Konclude, none of our changes; per-property fingerprints of the correct result |
| Comparison | `scripts/compare-fingerprint.py` | Our dump vs oracle, per canonical property bucket; `known_deltas` documents accepted differences |
| Fresh-process sampler | `scripts/repro-sample.sh`, `make repro N=5` | N independent processes vs oracle; exit 0/1/2 |
| Variant runner | `scripts/bisect-variants.sh` | Serial runs of the sampler under `REPRO_*` env variants |
| Run identity | `scripts/baseline-info.sh` | commit, enabled patches, vendor diff hash, override hash printed per run |
| State dumps | `KoncludeReasoner::dumpRoleState`, `dumpState` (native-only) | Inspect the kernel's internal state at the end of a run (`--dump-role <substr>`) |
| Core hook | `--core-after /tmp/core` | `gcore` of the live process after realization for post-mortem gdb |

Build: `cmake -S native -B build-native -DCMAKE_BUILD_TYPE=Debug && cmake --build build-native --target konclude_repro -j8` (first build ~20 min, ~4 GB; edits to one `.cpp` ~2 min; editing `QtCompat.h` rebuilds everything).

## 2. Native-only switches (inert in WASM)

| Switch | Effect |
| --- | --- |
| `REPRO_HASH_SEED=n` | Mixes a seed into every pointer hash (QHash/QSet shim + `qHash(T*)`). With `setarch -R` (ASLR off) the run is deterministic per seed: seeds are reproducible test vectors |
| `REPRO_SEED_TYPES=a,b` | Only reorder containers whose key typeid contains one of the substrings (bisect aid; results were chaotic, treat with care) |
| `REPRO_THREADS=n` | Worker count (`-w 1` hangs in upstream too) |
| `REPRO_SLOT_WAIT_MAX`, `REPRO_UNCHANGED_LABELS_COMPAT`, `REPRO_THREADED_UPDATE_SYNC`, `REPRO_AUTO_CLASSIFIER_SELECT` | Override our `WasmConfigProvider` tunings with upstream defaults |
| `REPRO_NO_JUST_WALK=1` | Skip the justification dependency-chain walker |
| `-DREPRO_ORDERED_QHASH=ON`, `-DREPRO_STD_QHASH=ON` | Insertion-ordered / `std::unordered_map`-backed QHash (and ordered QSet) variants (separate build dirs) |
| `-DREPRO_ASAN=ON` | AddressSanitizer build (`ASAN_OPTIONS=detect_leaks=0:new_delete_type_mismatch=0:alloc_dealloc_mismatch=0`) |
| patch 018 | `RMSG` trace line per role marker-candidate message (stderr) |

## 3. Method for a correctness bug (what worked, in order)

1. **Build an oracle from pristine upstream.** Without it you cannot tell "wrong" from "different". Canonicalize (equivalent/inverse property representatives) and fingerprint per property; keep the fingerprint, not full dumps (disk).
2. **Sample fresh processes.** A second call in the same process returns cached results and is not an independent sample. Measure the failure *rate* first (here ~50%).
3. **Narrow with the oracle diff.** Which buckets differ (here only `isRelationOf`), how (random vs constant), shape of the missing set (chunks, coherent cluster).
4. **Cheap eliminations first:** late completion (re-read after a delay), config knobs (env switches), thread count, hierarchy equality across runs.
5. **Make it deterministic.** `setarch -R` showed identical results per binary → address dependent, not a race. Then `REPRO_HASH_SEED` turned randomness into test vectors (seeds 0,5 pass; 1-4 fail), one ~45 s run each.
6. **Look for memory errors:** `MALLOC_PERTURB_=85` (crash ⇒ uninitialized read), ASan build (found a real upstream bug; not the cause).
7. **Read kernel state, not output.** `--dump-role`: counts of known/possible/tested/testing links and the queue flags per role item showed "candidates present, never queued". Compare a good and a bad seed; never compare role/concept tags across runs (assigned in address-dependent order).
8. **Prove with a patch** (`scripts/new-multi-file-patch.sh`), re-run the failing seeds, then the fresh-process sampler (8/8).

Things that did **not** help: type-filtered seeding (needs several containers reordered together), single-thread runs (hang), repeated calls in one process, bisecting patches (they apply strictly in order against one shared vendor tree — use compile-time switches or env switches instead).

## 4. Tools and tricks

- **gdb breakpoint hit counts without code changes:** `break File.cpp:LINE`, `commands / silent / continue / end`, `run`, `info breakpoints` (hit counts). gdb disables ASLR by default, so layout-dependent behaviour is reproducible under gdb too (but a *different* deterministic layout than `setarch -R`).
- **Crash site under perturbation:** `MALLOC_PERTURB_=85 setarch -R gdb -batch -ex run -ex 'bt 12' --args ./build-native/konclude_repro ...`
- **Live core:** `--core-after /tmp/core` then `gdb build-native/konclude_repro /tmp/core.<pid>` (cores are ~hundreds of MB; delete afterwards).
- **Do not use `pkill -f <pattern>`** from the Bash tool (kills its own shell, exit 144): `killall konclude_repro`.
- **Instrumenting vendor code:** use a patch gated by `#ifdef NATIVE_DEBUG_BUILD` (see `scripts/mod_018_role_message_trace.py`); apply on top with `git -C vendor/konclude apply --ignore-whitespace ../../patches/NNN-*.patch`, keep the sentinel `vendor/konclude/.patches-applied`; before a WASM build run `make reset-patches` (verifies the whole stack from scratch).
- **Disk discipline:** variant build trees are ~4 GB each; one at a time, delete when done.

## 5. Reusing the pipeline for performance tuning

The harness is a good performance bench because it removes TS/worker/serialization noise and runs the exact kernel:

- **Correctness gate first:** every tuning change must still pass `make repro` (oracle equality); the sampler prints elapsed per step in Konclude's own log lines (`@NNNms` on `{info}` lines: preprocess, precompute, classify, realize, role realize).
- **Realistic timings need an optimized build:** `native/CMakeLists.txt` uses `-g3 -O1` (about 40 s for Roberts vs ~0.33 s class-only / ~93 s per role closure in upstream's `-O1` Qt build). For tuning, add a second build dir with `-O2 -g` (e.g. an `-DREPRO_OPT=2` option) and compare against the pristine-upstream binary run on the same fixture (`scripts/oracle/build-upstream.sh`; `Konclude realization -w 8 -i f.nt -o out.xml`, `sparqlfile` for roles).
- **Know what dominates:** in the unlucky processing orders the fixed build runs ~130k role-confirmation tableau tests (several minutes at `-O1`); in good orders those links are deterministic and skip tests. The *order* in which individuals/roles are processed changes the work by orders of magnitude, so a deterministic, favourable processing order is a performance lever as well as a correctness one (candidate: sort role items / individuals by tag or id before processing; compare test counts via the `RMSG` trace and the callback counter breakpoints).
- **Knobs available without rebuild:** `REPRO_THREADS`, the four config overrides, `REPRO_HASH_SEED` (different orders ⇒ different amounts of work: a free "design of experiments" over processing orders, one deterministic run each).
- **Profilers:** none installed (`perf`/`valgrind` absent). `sudo apt install linux-tools-common linux-perf valgrind` then `perf record -g ./build-native/konclude_repro ...` (use the `-fno-omit-frame-pointer` build) or `valgrind --tool=callgrind` on a small fixture. gdb sampling (`gdb -p PID -batch -ex 'thread apply all bt 3'` a few times) works without installs.
- **Metrics to track per run:** wall time per phase (Konclude log), number of tableau tests (`doCallback` hit count or `RMSG` count), peak RSS (`/usr/bin/time -v`), triples emitted; store them next to `scripts/baseline-info.sh` output so runs stay comparable (commit, patch set, build type).
- **Incremental work uses the same bench:** `--mode incr-abox` compares an incremental revision run with the from-scratch oracle; add counters (individuals reprocessed, satisfiable tests) to prove it is actually incremental.

## 6. Checklist when starting a new investigation

1. `bash scripts/baseline-info.sh` and note the patch set; make sure `make repro N=3` passes on the current build (or write down what fails).
2. Reproduce with a fresh-process sampler; get a rate.
3. Try ASLR off + a hash seed to get a deterministic repro.
4. Add a state dump for the structure you suspect; compare good vs bad.
5. Fix via patch; re-run the deterministic vectors; then the sampler; then WASM (`make reset-patches`, `make build-wasm`, vitest to a file).
6. Document in `docs/solutions/` (ce-compound) and update `patches/ENABLED` comments.
