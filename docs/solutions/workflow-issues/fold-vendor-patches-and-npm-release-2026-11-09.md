---
title: Folding vendor patches with a verified-identical tree, and the 0.9.0 npm release flow
date: 2026-11-09
category: workflow-issues
module: patches
problem_type: workflow_issue
component: development_workflow
severity: low
applies_when:
  - Aggregating separate vendor patches (005+) into the scoped 000-004 patches before a release tag
  - Publishing the npm package from a machine without GitHub SSH or gh
  - A Roberts-size vitest test times out only when a second RdfReasoner is alive
tags: [patches, vendor, release, npm, flaky, second-worker]
---

# Folding vendor patches with a verified-identical tree, and the 0.9.0 npm release flow

## Context

Patches 005-009 were kept separate while testing (bisectable). Before tagging 0.9.0 they had to fold into `002-realizer-kernel-correctness` (009) and `004-memory-lifecycle` (005-008) without changing the resulting vendor tree.

## Guidance

Do the fold in a scratch git repo, never in `vendor/konclude` (avoids touching ~290 files and a 12 min native rebuild).

1. `git -C vendor/konclude archive HEAD | tar x` into `/tmp/fold/w`, `git init`, commit base, then apply and commit patches 000..009 one by one with `git apply --ignore-whitespace` (same flags as `scripts/apply-patches.sh`; vendor Cache files mix CRLF/LF). Check every changed file's blob equals the live vendor file (`git hash-object` vs `git rev-parse HEAD:path`). Compare blobs, not `git diff | sha256sum`; diff headers differ.
2. Branch from the commit of 002, `git cherry-pick` 009, then 003, 004, 005..008. A clean cherry-pick chain is the fast test that reordering is safe. Compare `HEAD^{tree}` to the old final tree (`d9a43770...` for 0.9.0).
3. Regenerate only the changed patches: `git diff <001> <new-002>` and `git diff <new-003> <final>` (as 004). Keep the two comment header lines and extend them with the folded numbers.
4. Verify in a second fresh archive by sequentially applying `000, 001, 002', 003, 004'` and comparing `git write-tree` to the expected tree.
5. Archive the originals (`patches/archive/0.9.0-pre-fold/`, plus `*.pre-fold.patch` copies of old 002/004), update `patches/ENABLED` and `patches/README.md` (old-number mapping), `make reset-patches`, confirm the vendor diff hash is unchanged, then rebuild WASM.

## npm release without gh / SSH

- Token is in `.env` as `NPM_TOKEN`. Do not print it. Use a temp userconfig: `printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n' > /tmp/npmrc-pub`, `set -a; . ./.env; set +a; NPM_CONFIG_USERCONFIG=/tmp/npmrc-pub npm publish --dry-run`, then publish, then delete the file.
- `npm view ... version` lags for a few minutes after publish.
- Push/merge/GitHub release are done by the user (no SSH key or `gh` on this machine).

## Known intermittent slow run (not a release blocker)

`tests/integration/explanation-persistence.test.ts` (Roberts materialize with explanations; the test makes a second `RdfReasoner` while the `beforeAll` one is alive) is bimodal: ~30 s on a good run, 150-180 s on a slow run, which exceeds its 120 s limit (passes on the file's retry). Same output, standalone single-worker run is ~28 s. One comparison with the old committed WASM happened to be fast, which proved nothing: the slow mode is intermittent (see Known limits in `docs/release-notes-v0.9.0.md` and [[project_wasm_stall_hunt]] in memory). Rerun twice before suspecting a regression.

## Why This Matters

Byte-identical fold means no retesting of kernel behaviour is needed beyond the build; one-run before/after timings on this test mislead.

## When to Apply

Any future fold of 005+ patches into scoped patches before a tag; any time a heavy Roberts test times out once.
