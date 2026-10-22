# ADR 0003 - Schema migrations run inside the deployment

**Status:** accepted

## Context

CloudFormation cannot run DDL, the cluster has no public endpoint, and the application must never
start against a schema it does not expect. A separate manual step is the usual source of "deployed
the code, forgot the migration".

## Decision

A CloudFormation **custom resource** backed by an in-VPC Lambda (`migrate`):

- Its only property is the SHA-256 of all `db/migrations/*.sql`; any SQL change triggers an update,
  nothing else does.
- It applies pending migrations in **one transaction** (`lock_timeout 10s`, `statement_timeout 120s`)
  and records each file's checksum; an already-applied file whose checksum changed is an error, never
  a silent re-run.
- It sets the writer and reader passwords from their secrets (`ALTER ROLE`), inside the same
  transaction - the roles are created without passwords and stay unusable until this succeeds.
- It runs the immutability proofs; any failure fails the deployment and CloudFormation rolls back.
- Every function that talks to the database depends on this resource.
- `Delete` is a no-op: removing the stack never drops data.
- Indexes are created only while the table is empty. On a populated table the migration warns and
  leaves `CREATE INDEX CONCURRENTLY` to the runbook - except the unique `event_id` index, whose
  absence fails the migration, because every insert's `ON CONFLICT` depends on it.
- A CI "DBA gate" fails the build on destructive statements in migration files.

## Consequences

- Schema and code ship together and roll back together.
- Heavy-lock DDL on a large table is deliberately not automated.
- Error text from PostgreSQL is scrubbed of quoted literals before it reaches CloudFormation events
  or logs (a syntax error can echo a password).
