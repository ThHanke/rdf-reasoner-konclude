.PHONY: repro-wasm repro repro-selftest build build-wasm test test-browser smoke reason shell patches reset-patches fmt lint

build:
	npm run build

build-wasm:
	docker compose run --rm build
	npm run patch-wasm

test:
	npm test

test-browser:
	npm run test:browser

smoke:
	docker compose run --rm smoke-test

# Usage: make reason ARGS="--input ont.ttl"
reason:
	node dist/cli.js $(ARGS)

shell:
	docker compose run --rm shell

patches:
	npm run apply-patches

# Reset vendor to clean state and re-apply all patches from scratch.
# Run this after adding or modifying patch files before a WASM rebuild.
reset-patches:
	bash scripts/apply-patches.sh --force

fmt:
	trunk fmt

lint:
	trunk check

# Native (no WASM, no N3) realization determinism gate: N fresh-process samples vs oracle.
# Usage: make repro N=5   (needs build-native/konclude_repro; ~40 s per sample at -O1)
repro-selftest:
	python3 scripts/oracle/test_canon.py

repro: repro-selftest
	bash scripts/repro-sample.sh tests/fixtures/roberts-family.nt tests/fixtures/oracle/roberts-family.oracle.json $(or $(N),5)

# Usage: make repro-wasm N=8   (needs dist/ built; ~35 s per sample)
repro-wasm:
	bash scripts/wasm-sample.sh tests/fixtures/roberts-family.nt tests/fixtures/oracle/roberts-family.oracle.json $(or $(N),5)
