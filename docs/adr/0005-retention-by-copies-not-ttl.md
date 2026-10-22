# ADR 0005 - Retention by immutable copies, never by expiry

**Status:** accepted

## Context

The old design's "7-year retention" was a DynamoDB TTL: the platform deleted regulated records on a
timer. Retention for an audit log means *being able to produce the record*, not *deleting it later*.

## Decision

- The table has **no expiry column**; nothing deletes rows.
- **Point-in-time recovery** (7 days dev, 35 days prod) is the operational safety net.
- **AWS Backup, monthly** (1st of the month, 05:00 UTC), retention 7 years, optional **Vault Lock**
  (compliance mode allowed only for prod; synth fails otherwise), with a **cross-region copy** to a
  DR vault. Monthly, not daily: under a compliance lock every recovery point is undeletable for its
  whole retention, and daily points over 7 years would be about 2,555 locked snapshots.
- **archive-export**: once a month the latest automated snapshot is exported to **Parquet** in the
  Object Lock bucket (`StartExportTask`), so the history stays queryable with Athena without
  restoring a cluster. The job is idempotent per month and publishes a freshness metric.

## Consequences

- Deleting history requires breaking a lock, not forgetting to disable a TTL.
- Between PITR (35 days) and the monthly archive, the recovery point objective is up to one month;
  that is documented, not hidden.
- Storage grows forever in the live table; partitioning by month is the planned next step once a
  disposal policy exists (see the README roadmap).
