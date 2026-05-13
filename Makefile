.PHONY: build build-wasm test smoke reason shell patches fmt lint

build:
	npm run build

build-wasm:
	docker compose run --rm build

test:
	npm test

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
