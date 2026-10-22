# ADR 0001 - Aurora PostgreSQL instead of DynamoDB

**Status:** accepted

## Context

The audit log's read side is ad-hoc filtering, ordering by time, exact counts, facets and
reconciliation queries. DynamoDB answers only the access patterns its keys were designed for; every
new filter meant a new GSI, a scan, or filtering after `Limit` - which is how matching rows were
silently dropped (problem #2).

## Options

| Option | For | Against |
|---|---|---|
| Keep DynamoDB, add GSIs | No migration | Each filter combination needs its own index; still no totals, facets or `DISTINCT`; the overloaded-key and TTL problems remain |
| DynamoDB + OpenSearch (via streams) | Full-text and facets | Two stores to keep consistent; the search index is not the system of record, so "complete" depends on a pipeline; append-only still unenforced |
| **Aurora PostgreSQL Serverless v2** | Arbitrary predicates, keyset paging, counts, materialized views, constraints, triggers, roles - append-only becomes enforceable | A capacity floor that bills while idle; schema migrations must run inside the VPC; connection management |
| RDS PostgreSQL (provisioned) | Cheapest steady-state | Manual sizing; the read load is bursty (auditors, exports) |

## Decision

Aurora PostgreSQL 16, Serverless v2, 0.5-4 ACU by default, writer-only with an optional reader
(redundancy, not read scaling - the write volume of an audit log is modest).

## Consequences

- Correctness moves into the database: types, constraints, uniqueness, two append-only walls.
- The 0.5 ACU floor is a fixed monthly cost DynamoDB on-demand did not have; it buys predictable
  latency and keeps connections warm (see `infra/README.md` for the rough figure).
- A migration runner is needed in the VPC ([0003](0003-schema-migrations-as-a-custom-resource.md)).
- History must be moved across ([0006](0006-backfill-from-a-point-in-time-export.md)).
