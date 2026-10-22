.PHONY: help up seed smoke logs down test test-int test-pg-local test-infra

SEED_ITEMS ?= 20000

help:          ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

up:            ## build and start db, localstack, migrate (schema + proofs) and the api
	docker compose up -d --build --wait db localstack api

seed:          ## write SEED_ITEMS legacy DynamoDB items (about 4% deliberately bad (about 1% for each of four reject reasons))
	SEED_ITEMS=$(SEED_ITEMS) docker compose run --rm jobs seed-legacy

smoke:         ## export -> backfill twice -> walls -> API -> digest
	./scripts/smoke.sh

logs:          ## follow migrate + api logs
	docker compose logs -f migrate api

down:          ## stop and delete containers and volumes
	docker compose --profile jobs down -v

test:          ## lint, typecheck, format, unit tests, build (functions)
	npm ci && npm run lint && npm run typecheck && npm run format:check && npm test && npm run build

test-int:      ## integration tests; needs DATABASE_URL_ADMIN (superuser URL)
	npm run test:int

test-pg-local: ## integration tests on an embedded PostgreSQL 16 (no Docker)
	npm run test:pg:local

test-infra:    ## CDK lint, tests (cycles, DBA gate, cdk-nag), synth
	cd infra && npm ci && npm run lint && npm test && npm run synth -- -q
