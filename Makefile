.PHONY: build build-wasm test test-browser smoke reason shell patches reset-patches fmt lint

build:
	npm run build

build-wasm:
	docker compose run --rm build

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
