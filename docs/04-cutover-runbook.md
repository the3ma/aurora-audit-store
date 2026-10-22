# 4. Cutover runbook: DynamoDB -> Aurora

The order matters: protect the old data first, move it second, switch writes third, and only retire
the old table after someone other than the operator has signed off the reconciliation.

## 0. Before the first deploy that touches the legacy table

- [ ] Enable **point-in-time recovery** and **deletion protection** on the legacy table; set its
      removal policy to `RETAIN`. Deploy that change on its own.
- [ ] **Disable TTL** on the legacy table. From this moment nothing expires.
- [ ] Record the item count (`DescribeTable.ItemCount` is approximate - note the time).

## 1. Stand up the new store

- [ ] Deploy `AuditDrVault` in the DR region (once per account).
- [ ] Deploy `AuditStore-<stage>`. The `migrate` custom resource applies the schema, sets the role
      passwords and runs the immutability proofs; the deploy fails if any proof fails.
- [ ] Check the dashboard: migration succeeded, `mv-refresh` running, no alarms.
- [ ] Expected noise: `archive-export` fails (and alarms) every day until the first monthly archive
      exists - it treats "no archive yet" as stale on purpose. Acknowledge it, or run the first export
      by hand once the first automated snapshot exists.

## 2. Export and backfill (repeatable)

```bash
aws dynamodb export-table-to-point-in-time \
  --table-arn <legacy table arn> --s3-bucket <legacy export bucket> \
  --s3-prefix exports/<date> --export-format DYNAMODB_JSON
# wait for ExportStatus = COMPLETED, note the export's AWSDynamoDB/<id>/ prefix

aws lambda invoke --function-name <prefix>-backfill \
  --payload '{"exportPrefix":"exports/<date>/AWSDynamoDB/<id>","dryRun":true}' out.json
# review out.json: counts, reject reasons; then run for real
aws lambda invoke --function-name <prefix>-backfill \
  --payload '{"exportPrefix":"exports/<date>/AWSDynamoDB/<id>"}' out.json
```

- [ ] Manifest invariant holds: `read = inserted + alreadyPresent + rejected` (the function refuses to
      write a manifest otherwise).
- [ ] `rejected.jsonl` reviewed; every reject has an owner and a decision (fix at source and re-export,
      or accept as documented loss).
- [ ] Per-scope and per-month counts compared with an independent count of the export.
- [ ] **Run the same backfill again**: `inserted` must be `0`.

## 3. Switch writes

- [ ] Deploy the writers pointing at `POST /v1/events` (each event carries its own `event_id`, so a
      retried write is idempotent).
- [ ] Take a **second** export covering the window between the first export and the switch; backfill
      it. Already-present events are skipped; only the gap is inserted.
- [ ] Spot-check: newest legacy item and newest backfilled row match.

## 4. After cutover

- [ ] The legacy table stays read-only, PITR on, no TTL, until the reconciliation is signed off by
      someone other than the operator.
- [ ] The first nightly `digest` seals the backfilled ranges; check `DigestMismatchCount = 0`.
- [ ] The first monthly backup and archive export appear; check the freshness metrics.
- [ ] Then: final export of the legacy table into the evidence bucket, and retire the table.

## Rollback

Before step 3, rollback is "keep writing to DynamoDB" - the Aurora store has only copied data. After
step 3, rolling writes back means a reverse backfill of `source = 'live'` rows; the runbook for that
is deliberately not automated.
