# infra - AWS CDK v2 app

Infrastructure for the audit store: Aurora PostgreSQL Serverless v2 behind private networking, the
schema-migration custom resource, the six Lambda functions from the [contract](../docs/CONTRACT.md),
an Object-Locked evidence bucket, AWS Backup with cross-region copy, and alarms.

This is its own npm package (own `package-lock.json`), not part of the root workspace. Bundling reads
the handlers from `../packages/functions/src/handlers/*.ts` and the root `package-lock.json`, so run
`npm ci` at the repo root before a real (bundled) synth or deploy.

> **Status: synthesized and tested, not deployed by the author.** Every template property below is
> asserted by unit tests and cdk-nag; behaviour that only a real account can show (rotation Lambdas
> connecting, RDS export into an Object-Locked bucket, EventBridge delivery of read-only CloudTrail
> events) has not been exercised. Treat a first deploy as a test.

## Stacks

| Stack | Region | Contents |
|---|---|---|
| `AuditStore-<stage>` | your region | VPC (or imported), Aurora cluster, KMS keys, 3 DB secrets + hosted rotation, migrate custom resource, api / mv-refresh / digest / archive-export / backfill Lambdas, HTTP API, evidence + legacy-export + access-log buckets, optional legacy DynamoDB table, Backup vault + monthly plan, SNS alarm topic, alarms, dashboard |
| `AuditDrVault` | `drRegion` | KMS key + Backup vault that receives the cross-region copies. One per account, shared by all stages. Only synthesized when `drRegion` is set. |

### Design notes

- **Network.** By default a new VPC with 2 AZs: `db` (PRIVATE_ISOLATED) and `app` subnets, **no NAT**.
  Lambdas reach AWS through gateway endpoints (S3, DynamoDB; policies restricted to this account's
  resources) and interface endpoints (Secrets Manager, KMS, Logs, Monitoring, RDS, STS). The cluster
  SG accepts 5432 only from six named client SGs (`migrate`, `api`, `mv-refresh`, `digest`,
  `backfill`, `rotation`) - never a CIDR. All SG-to-SG rules are standalone
  `AWS::EC2::SecurityGroupIngress/Egress` resources, so the SGs never reference each other inline.
- **Aurora.** PostgreSQL 16.13 (latest non-limitless 16.x in the pinned `aws-cdk-lib`), Serverless v2
  writer (+ `scaleWithWriter` reader in prod), storage, Performance Insights and all DB secrets
  encrypted with one rotating CMK, `rds.force_ssl=1`, slow-statement and lock-wait logging,
  `postgresql` log export. IAM DB auth is off on purpose (password roles with rotation; IAM auth
  caps new connections at ~200/s and needs a token per connect). pgaudit is not preloaded: the
  application already records every business action, and statement auditing would duplicate it into
  CloudWatch.
- **Secrets.** `<prefix>/db/owner` (cluster master), `<prefix>/db/writer`, `<prefix>/db/reader`, each
  with Secrets Manager hosted single-user rotation every 30 days in the `rotation` SG.
  `rotateImmediatelyOnUpdate=false`, and the rotation schedules depend on the migration: writer and
  reader have no password until `migrate` sets one.
- **Migration.** `Custom::AuditSchemaMigration` with `MigrationsChecksum` = sha256 of
  `db/migrations/*.sql` in filename order (CRLF normalised), so only a SQL change triggers an Update.
  It waits for the writer instance, the SG rules and the endpoints; api, mv-refresh, digest and
  backfill `DependsOn` it. migrate has reserved concurrency 1.
- **Evidence bucket.** Object Lock (COMPLIANCE in prod, GOVERNANCE in dev), versioned, SSE-KMS with a
  bucket key, BLOCK_ALL, TLS only, plus a bucket-policy deny of `DeleteObject`, `DeleteObjectVersion`,
  `PutObjectRetention` and `BypassGovernanceRetention` for every principal. Writers get `PutObject` on
  their own prefix only (`audit-digest/`, `backfill/`, `archive/`); digest may also read
  `audit-digest/` to re-verify. Always RETAIN: locked objects cannot be deleted anyway.
- **Backup.** Monthly (1st, 05:00 UTC) rather than daily: Aurora already gives 7/35 days of PITR, the
  vault is for long-term retention, and with Vault Lock + 7 years a daily rule would pin ~2,555
  immutable recovery points instead of 84. Copies go to `AuditDrVault` in `drRegion`.
- **Owner-secret read detection.** An EventBridge rule on CloudTrail `GetSecretValue` for the owner
  secret, excluding the migrate role session and the owner rotation Lambda, publishes to the alarm
  topic. **It needs a CloudTrail trail that records read management events in the region**;
  without one the rule never fires. CloudFormation resolving the master password during a cluster
  update also matches - expected, and it lines up with a deployment.
- **API auth.** With `jwtIssuer`/`jwtAudience` the `/v1/{proxy+}` routes use an HTTP API JWT
  authorizer. **Without them the gateway does not authenticate** (allowed for a sandbox only, with a
  cdk-nag suppression that says so); the handler still runs with `AUTH_MODE=jwt` and answers 401
  to any request without verified JWT claims, so it fails closed rather than open. `/v1/health` is
  always unauthenticated and returns no tenant data.

### Alarms (all to the KMS-encrypted SNS topic, alarm + OK)

- **Aurora:** ACU utilisation > 80 %, pinned at `maxAcu`, FreeableMemory < 256 MiB, connections
  > 80 % of the `max_connections` derived from `maxAcu`, Deadlocks > 0, EngineUptime < 10 min
  (restart/failover).
- **Functions** (none has a DLQ): errors > 0 for migrate, api, mv-refresh, digest, archive-export and
  backfill; mv-refresh slower than 2 min; archive-export not invoked for 2 days. digest also throws
  on a digest mismatch and archive-export throws when the archive is stale (including every day after
  a first deploy until the first monthly export completes), so their error alarms double as tamper
  and staleness alarms.
- **Custom metrics** (namespace `AuditStore`): `DigestMismatchCount` > 0, `DigestAgeHours` > 30, digest
  not reporting for 30 h, `ArchiveStale` > 0.
- **`mutation-attempts`:** a CloudWatch Logs metric filter on the cluster's `postgresql` log group
  matches `"audit_event is append-only"`, the message of the SQLSTATE 23001 ERROR raised by the
  append-only trigger. ERROR lines are logged by default (`log_min_error_statement`). The filter
  emits `AuditStore/MutationAttempts` (1 per match, default 0), and the alarm fires on > 0 in 5 min
  (missing data = not breaching). It also has a dashboard graph. `log_statement=ddl` is deliberately
  **not** enabled: it would log `ALTER ROLE ... PASSWORD` with the SCRAM verifier.
- **API:** 5xx > 5 per 5 min, p99 latency > 2 s.
- **Owner-secret reads** by anyone other than migrate or its rotation Lambda (EventBridge, see above).

## Context flags

Pass with `-c key=value` (values from `-c` are strings; they are parsed and validated at synth).

| Flag | Default (dev / prod) | Notes |
|---|---|---|
| `stage` | `dev` | `dev` or `prod` |
| `prefix` | `audit-<stage>` | resource-name prefix, `^[a-z][a-z0-9-]{1,23}$` |
| `vpcId` | - | import this VPC (`Vpc.fromLookup`, needs `CDK_DEFAULT_ACCOUNT/REGION`) instead of creating one |
| `dbSubnetGroupName` / `appSubnetGroupName` | isolated / private-with-egress | subnet groups to use in an imported VPC |
| `createEndpoints` | `false` | create the VPC endpoints in an imported VPC |
| `natGateways` | `0` | 0-2, created VPC only; >0 adds public subnets and makes `app` private-with-egress |
| `minAcu` / `maxAcu` | `0.5` / `4` | multiples of 0.5; `minAcu=0` enables auto-pause |
| `enableReader` | `false` / `true` | Serverless v2 reader that scales with the writer |
| `backupRetentionYears` | `7` | AWS Backup retention (365 x years days) |
| `vaultLockMode` | `none` / `governance` | `none`, `governance`, `compliance`; compliance (3-day grace, then immutable) is rejected unless `stage=prod` |
| `drRegion` | - | enables the DR stack and the cross-region copy |
| `drVaultArn` | derived | override the DR vault ARN (default `arn:aws:backup:<drRegion>:<account>:backup-vault:<drVaultName>`) |
| `drVaultName` | `audit-store-dr` | name of the DR vault |
| `drVaultLockMode` | `governance` | Vault Lock mode of the DR vault |
| `alarmEmail` | - | email subscription on the alarm topic |
| `jwtIssuer` / `jwtAudience` | - | enables the JWT authorizer (both required, issuer must be https) |
| `corsOrigins` | none | comma-separated `https://host` origins |
| `evidenceRetentionDays` | `1` / `2557` | Object Lock default retention |
| `legacyTableName` | `<prefix>-audit-legacy` | the "before" DynamoDB table (imported by name) |
| `createLegacyTable` | `false` | create it instead (PAY_PER_REQUEST, PITR, deletion protection, RETAIN, CMK, no TTL) |
| `logRetentionDays` | `30` / `365` | Lambda, API, VPC flow and PostgreSQL log retention |
| `apiReservedConcurrency` | - / `25` | caps DB connections from the API |
| `apiThrottleRate` / `apiThrottleBurst` | `50/100` / `200/400` | HTTP API stage throttling |
| `skipBundling` | `false` | inline placeholder code instead of esbuild bundles (tests, CI synth) |

## Commands

```bash
npm ci
npm run lint      # eslint (typescript-eslint strict, type-checked), --max-warnings 0
npm run build     # tsc
npm test          # jest; synthesizes with skipBundling=true - no Docker, no esbuild
npm run synth     # cdk synth -c stage=dev -c skipBundling=true
npm run synth:prod
```

Tests cover the critical template properties, a CloudFormation dependency-cycle detector (Tarjan
SCC over `Ref`/`Fn::GetAtt`/`Fn::Sub`/`DependsOn` - `cdk synth` alone does not catch every cycle),
a "DBA gate" that fails on destructive statements in `db/migrations/*.sql`, and cdk-nag
(`AwsSolutionsChecks`) with zero unsuppressed findings.

## Deploy order

```bash
# 0. once per account/region pair
npx cdk bootstrap aws://111111111111/eu-central-1 aws://111111111111/eu-west-1

# 1. DR vault first (the stage stack's copy action points at it)
npx cdk deploy AuditDrVault -c stage=prod -c drRegion=eu-west-1

# 2. the stage stack (bundles the handlers with esbuild; run `npm ci` at the repo root first)
npx cdk deploy AuditStore-prod -c stage=prod -c drRegion=eu-west-1 \
  -c jwtIssuer=https://auth.example.test/ -c jwtAudience=audit-api \
  -c alarmEmail=oncall@example.test -c corsOrigins=https://app.example.test
```

The first deploy creates the cluster, then the migration custom resource applies the schema, sets the
writer/reader passwords and runs the immutability proofs; a failed proof fails the deployment.
Reserved concurrency (5 singletons + API) needs an account concurrency limit above the default 10 of
new accounts.

## Rough monthly cost floor

List prices, us-east-1-style, as of writing; check the AWS pricing pages for your region.

| Item | dev | prod |
|---|---|---|
| Aurora Serverless v2 at 0.5 ACU minimum (writer; prod + reader) | ~$44 | ~$88 |
| Aurora storage + I/O (10 GB, light I/O) | ~$2 | ~$2 |
| 6 interface endpoints x 2 AZ | ~$88 | ~$88 |
| KMS keys (3 + 1 DR), Secrets Manager (3) | ~$4 | ~$5 |
| CloudWatch: ~20 alarms, 1 dashboard, logs | ~$6 | ~$8 |
| AWS Backup: monthly snapshots + DR copy (10 GB, grows to 84 points over 7 years) | ~$1 | ~$1, rising |
| **Floor** | **~$145** | **~$190** |

The interface endpoints are the largest fixed cost of a no-NAT design; one NAT gateway (~$33 + data)
is cheaper but gives every Lambda a route to the internet. `minAcu=0` (auto-pause) removes most of the
Aurora floor in dev.

## cdk-nag suppressions

All scoped to a construct, granular ones with `appliesTo`:

| Rule | Where | Why |
|---|---|---|
| IAM5 `Resource::*` | each Lambda role | ENI management (no resource-level permissions), `cloudwatch:PutMetricData` (namespace condition), `rds:DescribeExportTasks` |
| IAM5 object prefix | digest, backfill, export role | object keys are generated under a fixed prefix of a single bucket |
| IAM5 snapshot ARN | archive-export | `cluster-snapshot:rds:<cluster-id>-*` = this cluster's automated snapshots |
| IAM4 / IAM5 | migration provider framework | CDK-managed Lambda that only invokes migrate |
| IAM4 | Backup selection role | AWS-maintained `AWSBackupServiceRolePolicyForBackup` |
| L1 | the six handlers | Node.js 22 pinned by the contract |
| RDS6 | cluster | password roles + rotation instead of IAM auth (see above) |
| RDS10 | cluster, dev only | dev is disposable; prod has deletion protection |
| APIG4 | `/v1/health`; `/v1/{proxy+}` only without `jwtIssuer` | open health probe; sandbox without an issuer |
