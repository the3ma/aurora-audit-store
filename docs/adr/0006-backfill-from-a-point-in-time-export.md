# ADR 0006 - Backfill from a point-in-time export, idempotent and reconciled

**Status:** accepted

## Context

Years of history live in the DynamoDB table. Moving them must not lose, duplicate or silently
"fix" a single event, and someone other than the author must be able to check that it didn't.

## Options

| Option | Against |
|---|---|
| Dual-write + dual-read during a transition | Every read path implemented twice, plus a merged cursor across two stores |
| Scan the live table | Consumes table capacity, sees a moving target, no fixed snapshot to reconcile against |
| DynamoDB Streams replay | Streams keep 24 hours, not years |
| **`ExportTableToPointInTime` to S3, then load** | Needs PITR enabled first; one more S3 bucket |

## Decision

1. Turn on PITR (and deletion protection) on the legacy table **before** anything else.
2. Export the table to S3 at a fixed point in time. No read capacity is used.
3. A manually invoked `backfill` function streams the export (`data/*.json.gz`, DynamoDB JSON):
   - maps each item to a row; a missing `EventId` becomes a **deterministic UUIDv5** of `PK + SK`, so
     re-runs map the same item to the same id;
   - **rejects, never coerces**: unknown scope, unparseable date, non-array `Changes`, malformed id -
     each reject is written with its reason;
   - inserts in batches of 500 as `audit_writer` with `INSERT ... ON CONFLICT (event_id) DO NOTHING`,
     counting inserted vs already-present from `RETURNING`;
   - marks rows `source = 'backfill'` so they are distinguishable from live writes forever.
4. Before it writes anything, it asserts the **reconciliation invariant**
   `read = inserted + alreadyPresent + rejected`, then writes a manifest (counts by scope and month,
   min/max timestamps, reject reasons) to the Object Lock bucket.
5. The run is repeated; the second manifest must show `inserted = 0`.

## Consequences

- The backfill can be stopped and re-run at any time.
- Rejected items are a list for a human, not a silent data change.
- Live writes go to Aurora from cutover; the legacy table stays read-only (no TTL) until the
  reconciliation is signed off, then is retained under its own backup.
