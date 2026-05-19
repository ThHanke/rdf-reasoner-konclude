.PHONY: build build-wasm test test-browser smoke reason shell patches fmt lint

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

fmt:
	trunk fmt

lint:
	trunk check
