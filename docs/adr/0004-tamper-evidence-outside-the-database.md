# ADR 0004 - Tamper evidence lives outside the database

**Status:** accepted

## Context

The walls in [0002](0002-two-append-only-walls.md) stop accidents and compromised application
credentials, but the database owner can always disable a trigger. Evidence stored in the same
database could be rewritten by the same person.

## Decision

A daily `digest` job seals every **closed** range of rows (recorded before today 00:00 UTC):

```
block_hash = sha256( prev_hash || sha256( row_1 \n row_2 \n ... ) )   rows ordered by event_row_id
```

- Rows are canonicalised as `to_jsonb(row)::text` and hashed **in the database** with `sha256()`, so
  the job needs only the reader role and moves no row data over the network.
- Each block is written to an **S3 Object Lock** bucket (compliance mode in production). The job's
  role may `PutObject` there but not delete or shorten retention.
- Recent blocks are re-verified daily, all blocks monthly. `DigestMismatchCount > 0` and a stale
  digest both alarm.
- Gaps in `event_row_id` are expected (identity values are not transactional) and are reported as a
  metric, not treated as tampering.

## Consequences

- Rewriting a sealed row - even by the owner with triggers disabled - is detected at the next
  verification, and the evidence cannot be rewritten to match.
- Rows written today are protected by the walls only until tonight's seal.
- Backfilled rows get recorded-at times of the load, so their blocks are sealed the night after.
