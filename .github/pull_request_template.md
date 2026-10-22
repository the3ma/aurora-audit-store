## What & why

<!-- One or two sentences. Link the issue. -->

## Changes

-

## Checklist

- [ ] `npm test` (functions) and `npm test --prefix infra` pass locally
- [ ] Integration tests pass against PostgreSQL 16 if `db/` or a query changed
- [ ] `make up && make seed && make smoke` passes if the backfill or the API changed
- [ ] New migration file, never an edit to an applied one (the checksum check rejects edits)
- [ ] `docs/CONTRACT.md` updated if a table, role, env var, payload or endpoint changed
- [ ] An ADR added or updated for a design decision
- [ ] No secrets, real credentials or personal data in code, fixtures or logs
