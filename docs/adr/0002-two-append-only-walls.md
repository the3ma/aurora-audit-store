# ADR 0002 - Append-only, enforced twice

**Status:** accepted

## Context

"Append-only" in the old design was a convention. An auditor needs a control that holds even when
one layer is misconfigured - a role granted too much, or a trigger disabled.

## Decision

Two independent walls, each sufficient on its own, each failing with its own SQLSTATE so a test can
tell which wall stopped a statement:

1. **GRANT wall.** `audit_writer` holds only `INSERT, SELECT`; `audit_reader` only `SELECT`. An
   `UPDATE`, `DELETE` or `TRUNCATE` by them fails with **42501** (insufficient_privilege) before any
   trigger runs.
2. **Trigger wall.** `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) triggers raise
   **23001** (restrict_violation). This stops the table owner too.

Every deployment runs the **immutability proofs** inside the migration transaction: each attempt
runs in a `SAVEPOINT` against a probe row that is rolled back, and the result is `pass`, `fail` or
`inconclusive` - inconclusive never counts as a pass. CI adds a **negative control**: it disables the
trigger and requires the owner proofs to fail, which shows the proofs can actually detect a hole.

## Consequences

- A compromised application credential cannot edit history.
- The owner can still `ALTER TABLE ... DISABLE TRIGGER`. That is the residual risk. It is covered by
  the hash chain ([0004](0004-tamper-evidence-outside-the-database.md)), which detects a rewritten
  row afterwards, and by the alarm on reads of the owner secret. Every blocked mutation also logs
  `audit_event is append-only`; a metric filter on the PostgreSQL log turns those into the
  `mutation-attempts` alarm.
- Corrections are new events that reference the old one, never edits.
