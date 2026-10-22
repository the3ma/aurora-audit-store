# 3. Running locally

PostgreSQL 16 stands in for Aurora, LocalStack for DynamoDB, S3 and CloudWatch. Every job runs the
same esbuild bundles the Lambdas run.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Docker + Compose v2 | 24+ | the stack and the smoke test |
| Node.js | 22 | tests, CDK |
| GNU make | any | shortcuts (optional; every target is a one-liner) |

## Start, seed, check

```bash
make up      # db, localstack, migrate (schema + role passwords + 16 proofs), api
make seed    # 20,000 legacy DynamoDB items, about 4% deliberately bad (SEED_ITEMS to change)
make smoke   # export -> backfill twice -> both walls -> API -> views -> digest
```

| URL / port | What |
|---|---|
| http://localhost:3000/v1/health | the API (`X-Tenant-Id` / `X-Actor-Id` headers stand in for the JWT) |
| localhost:5432 | PostgreSQL, database `audit` (`audit_owner`/`owner`, `audit_writer`/`writer`, `audit_reader`/`reader`) |
| http://localhost:4566 | LocalStack |

## What `make smoke` proves

1. The simulated point-in-time export has the same S3 layout as `ExportTableToPointInTime`.
2. The backfill's manifest satisfies `read = inserted + alreadyPresent + rejected`, the bad seed items
   are rejected with reasons, and the table holds exactly `inserted` backfilled rows.
3. A second backfill over the same export inserts **0** rows.
4. `UPDATE` as the writer fails with `42501` (GRANT wall); as the owner with `23001` (trigger wall).
5. `POST /v1/events` returns 201, then 200 for the same `event_id`.
6. Keyset paging over a filter returns exactly `/v1/events/count` events, with no duplicates.
7. A misspelt filter is a 400, never a silently unfiltered result.
8. The materialized views refresh and serve facets; the digest runs with 0 mismatches.

## Without Docker

```bash
npm ci
npm test                # unit tests
npm run test:pg:local   # integration tests on an embedded PostgreSQL 16 (downloads the binaries once)
npm run test:int        # the same, against DATABASE_URL_ADMIN=postgresql://<superuser>@host/db
cd infra && npm ci && npm test   # CDK assertions, cycle detector, DBA gate, cdk-nag
```

## Poking at it

```bash
curl -s -H 'X-Tenant-Id: t-005' -H 'X-Actor-Id: me' 'localhost:3000/v1/events?scope=billing&limit=5'
docker compose exec db psql -U audit_owner audit -c '\d+ audit_event'
docker compose run --rm jobs backfill -- --export-prefix <prefix> --dry-run
make down               # stop and delete everything
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `migrate` exits 1 | Read its log: a failed proof or a changed migration checksum stops it on purpose. `make down` resets the database. |
| `api` never healthy | It waits for `migrate` to succeed - check `docker compose logs migrate`. |
| Rejects far from ~4% of the seed | The seed is random but seeded (`SEED_RANDOM`); a big jump means a mapping change. |
| Port in use | Change the left side of the port mapping in `docker-compose.yml`. |
