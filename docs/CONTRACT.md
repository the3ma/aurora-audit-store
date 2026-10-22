# Integration contract

Single source of truth for everything that crosses a component boundary: schema, roles, secrets,
function names and env vars, the legacy DynamoDB item shape, the backfill manifest, the API, file
layout and ports. If code and this file disagree, fix one of them in the same change.

Domain (generic): a multi-tenant SaaS keeps an **append-only audit log** - one row per user action
(sign-in, record created, setting changed, invoice voided, file downloaded). Auditors and support
filter it, page through it and export it. It must never be edited or deleted, and must be kept for
7 years.

## 1. Layout

```
package.json            npm workspaces: packages/* (infra is a separate package with its own lockfile); Node 22
tsconfig.base.json      strict, ES2022, NodeNext
db/
  migrations/           0001_schema.sql ... applied in filename order, each exactly once
  seed/                 legacy-items generator input (optional)
packages/
  core/                 @audit/core - shared: db connections, secrets, TLS bundle, types, SQL, mapping, proofs
  functions/            @audit/functions - Lambda handlers + local CLIs + local API server
    src/handlers/migrate.ts         CloudFormation custom resource (also CLI: npm run migrate)
    src/handlers/mv-refresh.ts      EventBridge rate(10 minutes)
    src/handlers/digest.ts          EventBridge cron daily 03:00 UTC
    src/handlers/archive-export.ts  EventBridge cron daily 04:00 UTC
    src/handlers/backfill.ts        manual invoke (also CLI: npm run backfill)
    src/handlers/api.ts             HTTP API (Lambda) ; src/api/server.ts runs the same app locally
    src/handlers/master-secret-alert.ts  (optional) formats the EventBridge alert -> SNS (env ALERT_TOPIC_ARN)
    src/cli/seed-legacy.ts               npm run seed-legacy (LocalStack DynamoDB table audit-legacy)
    src/cli/simulate-dynamodb-export.ts  npm run simulate-export (prints the exportPrefix for backfill)
infra/                  AWS CDK v2 (TypeScript) app, jest tests, cdk-nag
scripts/                smoke.sh, test-pg-local.mjs (integration tests on embedded PostgreSQL 16)
Dockerfile.functions    one image for every local job: `docker run <img> migrate|api|backfill|...`
docs/                   problem, solution, ADRs, runbooks, this contract
docker-compose.yml
```

Every handler file exports `handler`. infra bundles them with `NodejsFunction` (esbuild) from
`packages/functions/src/handlers/<name>.ts`; `.sql` files and the RDS CA bundle are loaded with the
esbuild `text` loader (`loader: { '.sql': 'text', '.pem': 'text' }`), so the Lambda never reads the
filesystem for them. Runtime **Node.js 22, arm64**.

## 2. Schema (PostgreSQL 16 / Aurora PostgreSQL 16.x)

Migrations live in `db/migrations/NNNN_name.sql`, are idempotent where possible, and are tracked in
`audit_schema_migrations(version text primary key, checksum text not null, applied_at timestamptz
not null default now())`. A migration whose checksum changed after it was applied is an ERROR (never
silently re-applied). All pending migrations run in **one transaction** with
`SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '120s'`.

```sql
CREATE TYPE audit_scope AS ENUM ('accounts','billing','catalog','orders','settings','security');

CREATE TABLE audit_event (
  event_row_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- ordering tiebreaker, gap-tolerant
  event_id      UUID        NOT NULL,                             -- idempotency key from the writer
  tenant_id     TEXT        NOT NULL,
  project_id    TEXT,                                             -- optional sub-scope
  scope         audit_scope NOT NULL,
  entity_type   TEXT        NOT NULL,
  entity_id     TEXT        NOT NULL,
  entity_label  TEXT        NOT NULL,
  action        TEXT        NOT NULL,   -- create | update | delete | view | export | sign_in | ... (open set)
  actor_id      TEXT        NOT NULL,
  actor_email   TEXT        NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  changes       JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{"field","old","new"}]
  comment       TEXT,
  source        TEXT        NOT NULL DEFAULT 'live',       -- 'live' | 'backfill'
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_event_changes_is_array CHECK (jsonb_typeof(changes) = 'array'),
  CONSTRAINT audit_event_source_valid     CHECK (source IN ('live','backfill'))
);
CREATE UNIQUE INDEX ux_audit_event_event_id ON audit_event (event_id);
-- read paths (all newest first):
--   (tenant_id, occurred_at DESC, event_row_id DESC)
--   (tenant_id, scope, occurred_at DESC, event_row_id DESC)
--   (tenant_id, actor_id, occurred_at DESC)
--   (tenant_id, entity_type, entity_id, occurred_at DESC)
--   (tenant_id, project_id, occurred_at DESC) WHERE project_id IS NOT NULL
--   (occurred_at DESC, event_row_id DESC)            -- cross-tenant ops / digest ranges use the PK
```

Append-only, **two independent walls** (each must hold on its own):
1. **GRANT wall** - `audit_writer` has only `INSERT, SELECT`; `audit_reader` only `SELECT`. UPDATE/
   DELETE/TRUNCATE by them fail with SQLSTATE **42501** (insufficient_privilege).
2. **Trigger wall** - `audit_event_deny_mutation()` raises SQLSTATE **23001** (restrict_violation)
   with message `audit_event is append-only`; row trigger `BEFORE UPDATE OR DELETE FOR EACH ROW`,
   statement trigger `BEFORE TRUNCATE FOR EACH STATEMENT`. Stops even the owner.

Materialized views (refreshed by `refresh_audit_views()`, `SECURITY DEFINER`,
`SET search_path = pg_catalog, public`, plain `REFRESH`, owned by `audit_owner`):
- `mv_audit_facets(tenant_id, facet, value)` - facet in ('scope','entity_type','action','actor_email'), unique index on all 3.
- `mv_audit_daily_counts(tenant_id, scope, day date, action, events bigint)` - unique index on the first 4.

Indexes on a **populated** table: the migration creates them only while `audit_event` is empty; on a
populated table it emits WARNING and leaves `CREATE INDEX CONCURRENTLY` to the runbook - except
`ux_audit_event_event_id`, whose absence is an EXCEPTION (the `ON CONFLICT (event_id)` arbiter would
fail with 42P10).

`REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE ALL ON DATABASE <db> FROM PUBLIC;`

## 3. Roles and secrets

| Role | Login | Rights | Used by | Secret (AWS) |
|---|---|---|---|---|
| `audit_owner` | yes (cluster master) | owns everything; only DDL role | migrate | `<prefix>/db/owner` (generated by RDS, rotated 30 d, single-user) |
| `audit_writer` | yes | CONNECT, USAGE public, INSERT+SELECT audit_event, SELECT MVs | api (POST), backfill | `<prefix>/db/writer` (rotated 30 d, single-user) |
| `audit_reader` | yes | CONNECT, USAGE public, SELECT audit_event + MVs, EXECUTE refresh_audit_views() | api (GET), mv-refresh, digest | `<prefix>/db/reader` (rotated 30 d, single-user) |

- `audit_writer` / `audit_reader` are created **without a password** (fail closed). `migrate` sets them
  with `ALTER ROLE ... PASSWORD` from their secrets inside the migration transaction. The password is
  never logged; PostgreSQL error text is scrubbed of quoted literals before it is logged or returned
  to CloudFormation.
- Secret JSON (RDS rotation format): `{"engine":"postgres","host","port":5432,"dbname":"audit","username","password"}`.
  `port` is a JSON number. Password generation excludes `"'\;:@/` and space.
- TLS everywhere: `rds.force_ssl=1`; clients verify the server against the RDS CA bundle
  (`packages/core/certs/rds-global-bundle.pem`, committed; `rejectUnauthorized: true`).

## 4. Function environment

Shared by all functions:

| Var | AWS | Local |
|---|---|---|
| `DB_OWNER_SECRET_ARN` / `DB_WRITER_SECRET_ARN` / `DB_READER_SECRET_ARN` | secret ARNs (only those a function needs) | unset |
| `DATABASE_URL_OWNER` / `DATABASE_URL_WRITER` / `DATABASE_URL_READER` | unset | `postgresql://<role>:<pw>@db:5432/audit` |
| `DB_SSL` | `verify-full` (default) | `disable` |
| `LOG_LEVEL` | `info` | `debug` |
| `AWS_ENDPOINT_URL` | unset | `http://localstack:4566` |

Resolution order in `@audit/core` `connect(role)`: `DATABASE_URL_<ROLE>` if set, else the secret ARN
(fetched lazily, cached; on 28P01/28000 drop the cached secret + pool and retry once - survives
rotation without a restart).

Per function:

| Function | Extra env | Role |
|---|---|---|
| migrate | `DB_WRITER_SECRET_ARN`, `DB_READER_SECRET_ARN` (to read passwords) | owner |
| api | `CORS_ORIGINS`, `AUTH_MODE` = `jwt` (AWS, tenant from claim `tenant_id`) or `header` (local: `X-Tenant-Id`, `X-Actor-Id`) | reader (GET), writer (POST) |
| mv-refresh | - | reader |
| digest | `EVIDENCE_BUCKET`, `DIGEST_PREFIX=audit-digest/`, `DIGEST_REVERIFY_DAYS=7` | reader |
| archive-export | `CLUSTER_ARN`, `EVIDENCE_BUCKET`, `ARCHIVE_PREFIX=archive/`, `EXPORT_ROLE_ARN`, `EXPORT_KMS_KEY_ARN`, `ARCHIVE_STALE_DAYS=40` | none (RDS API only) |
| backfill | `LEGACY_EXPORT_BUCKET`, `EVIDENCE_BUCKET`, `MANIFEST_PREFIX=backfill/` | writer |

## 5. Migrate custom resource

- Properties: `{ MigrationsChecksum: <sha256 of all db/migrations/*.sql concatenated in order> }` -
  any SQL change triggers an Update, nothing else does.
- Create/Update: apply pending migrations (one transaction), set role passwords, run the
  **immutability proofs**; any failed proof fails the deployment. Delete: no-op (never drops data).
- Proofs (`@audit/core` `runProofs(ownerClient)`), each inside a SAVEPOINT against a probe row that is
  rolled back; result per proof = `pass | fail | inconclusive` (inconclusive is NOT a pass):
  writer UPDATE/DELETE/TRUNCATE -> 42501; reader INSERT/UPDATE/DELETE -> 42501; owner UPDATE/DELETE/
  TRUNCATE -> 23001; triggers present and ENABLED (`pg_trigger.tgenabled = 'O'`); no role besides the
  owner holds UPDATE/DELETE/TRUNCATE/TRIGGER on audit_event; `PUBLIC` holds nothing; event_id
  unique index exists and is valid; `changes` CHECK rejects a non-array (23514); source CHECK
  rejects junk (23514); duplicate event_id INSERT ... ON CONFLICT DO NOTHING inserts 0 rows.
- Response `Data`: `{ Applied: "<n>", Proofs: "<passed>/<total>" }`.
- Physical resource id: constant `audit-schema`.

## 6. Legacy DynamoDB table (the "before")

Table `<prefix>-audit-legacy`, PAY_PER_REQUEST. Item:

| Attribute | Example | Notes |
|---|---|---|
| `PK` | `TENANT#t-042#ENTITY#invoice` | |
| `SK` | `DATE#2024-03-01T10:15:30.123Z#CHANGE#1709288130` | change number = unix seconds (collides) |
| `GSI1PK` / `GSI1SK` | `ACTOR#u-17` / `DATE#...` | by actor |
| `GSI2PK` | `PROJECT#p-9` **or** `TENANT#t-042` | overloaded: project only when present |
| `GSI3PK` | `ENTITY#invoice#inv-1001` | by entity |
| `GSI4PK` | `SCOPE#billing` | by scope |
| `EventId` | uuid string (may be missing or malformed in old items) | |
| `TenantId`, `ProjectId`, `Scope`, `EntityType`, `EntityId`, `EntityLabel`, `Action`, `ActorId`, `ActorEmail`, `OccurredAt` (ISO), `Comment` | | Scope may be lower/upper case |
| `Changes` | JSON **string** `[{"field":..,"old":..,"new":..}]` | opaque string in the old design |
| `ExpiresAt` | epoch seconds | the TTL that was deleting regulated records |

## 7. Backfill

Input: a DynamoDB **ExportTableToPointInTime** export in `s3://$LEGACY_EXPORT_BUCKET/<exportPrefix>/`
(`manifest-summary.json`, `manifest-files.json`, `data/*.json.gz` in DynamoDB JSON format, one
`{"Item":{...}}` per line). Locally `packages/functions/src/cli/simulate-dynamodb-export.ts` scans the LocalStack table
and writes the identical layout (LocalStack has no export API).

Invoke payload / CLI args: `{ "exportPrefix": "...", "runId": "<optional>", "dryRun": false }`.

Mapping legacy -> row: `EventId` -> `event_id` (missing -> deterministic UUIDv5 of PK+SK in a fixed
namespace, so a re-run maps the same item to the same id); `Scope` case-folded and must be in the
enum; `OccurredAt` must parse; `Changes` JSON string must parse to an array (else reject);
`source='backfill'`. **Reject, never coerce**: invalid scope, unparseable date, invalid changes,
malformed EventId (present but not a UUID), missing required attribute (`missing_field`). Insert: batches of 500,
`INSERT ... ON CONFLICT (event_id) DO NOTHING` as `audit_writer`.

Manifest `s3://$EVIDENCE_BUCKET/backfill/<runId>/manifest.json` (PutObject only, never overwritten):

```json
{ "runId": "...", "exportPrefix": "...", "startedAt": "...", "finishedAt": "...",
  "read": 0, "inserted": 0, "alreadyPresent": 0, "rejected": 0,
  "rejectReasons": { "invalid_scope": 0, "invalid_date": 0, "invalid_changes": 0, "invalid_event_id": 0, "missing_field": 0 },
  "byScope": { "billing": 0 }, "byMonth": { "2024-03": 0 },
  "minOccurredAt": "...", "maxOccurredAt": "...", "dryRun": false }
```

Invariant (asserted before the manifest is written; violation = failure): `read == inserted +
alreadyPresent + rejected`. Rejected items go to `backfill/<runId>/rejected.jsonl` with the reason.
A second run over the same export must report `inserted == 0`.

## 8. Digest (tamper evidence)

Daily. Seals every **closed** range of `event_row_id` (rows recorded before today 00:00 UTC not yet
sealed) as one block: `sha256(prev_hash || sha256(canonical rows ordered by event_row_id))`, where a
canonical row is `to_jsonb(audit_event_row)::text` (jsonb normalises key order, so the text is
deterministic) and rows are joined with `\n`. The first block's `prev_hash` is 64 zeros.
Hashing is done in the database with `sha256()` (reader role, no extra grant). Each block is written to
`s3://$EVIDENCE_BUCKET/audit-digest/<yyyy>/<mm>/<dd>/<fromRowId>-<toRowId>.json`:
`{ "fromRowId", "toRowId", "rows", "hash", "prevHash", "sealedAt" }`. It re-verifies blocks of the last
`DIGEST_REVERIFY_DAYS` (and all blocks on the 1st of the month) and publishes metrics in namespace
`AuditStore`: `DigestMismatchCount`, `DigestAgeHours`, `RowIdGapCount` (gaps are expected - identity
values are not transactional - and reported, not failed).

## 9. Read/write API

All under `/v1`, JSON, tenant from the auth context (never from the query string).

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health` | `{status, checks:{db}}` |
| POST | `/v1/events` | body = one event (no row id, no source, no recorded_at); `event_id` required (idempotent: 201 first time, 200 + same row on replay) |
| GET | `/v1/events` | filters: `scope`, `entity_type`, `entity_id`, `actor_id`, `actor_email_prefix`, `action`, `project_id`, `from`, `to`, `q` (entity_label ILIKE, min 3 chars); `limit` 1-200 (default 50); `cursor` (opaque base64url of `occurred_at,event_row_id`) -> `{items, next_cursor}` |
| GET | `/v1/events/count` | same filters -> `{count}` (exact) |
| GET | `/v1/facets` | `{scope:[], entity_type:[], action:[], actor_email:[]}` from `mv_audit_facets` |
| GET | `/v1/stats/daily` | `from`, `to` -> rows of `mv_audit_daily_counts` |

Every predicate is in SQL before `LIMIT` (the bug the old design had). Keyset:
`(occurred_at, event_row_id) < ($c_at, $c_id) ORDER BY occurred_at DESC, event_row_id DESC`.
Errors: `{error:{code,message}}`; 400 invalid filter/cursor, 401/403 auth, 404 unknown route.

## 10. Local stack (docker compose) and ports

| Service | Port | Notes |
|---|---|---|
| db | 5432 | `postgres:16-alpine`, db `audit`, superuser `audit_owner`/`owner` (stands in for the RDS master) |
| localstack | 4566 | dynamodb, s3, secretsmanager, cloudwatch |
| migrate | - | one-shot: applies migrations, sets `audit_writer`/`audit_reader` passwords from env, runs proofs |
| api | 3000 | `AUTH_MODE=header` |
| jobs | - | profile `jobs`, one-shot runner for every CLI; `seed-legacy` writes `SEED_ITEMS` (default 20000) legacy items, about 4% bad (each reject reason) |

Local passwords (dev only): owner `owner`, writer `writer`, reader `reader`.
