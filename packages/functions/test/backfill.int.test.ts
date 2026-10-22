import { REJECT_REASONS, silentLogger, type LegacyItem, type RejectReason } from '@audit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  describeWithPostgres,
  type TestDatabase,
} from '../../core/test/support/test-db.js';
import { MemoryObjectStore } from '../src/adapters/memory.js';
import { runBackfill, type BackfillDeps, type BackfillManifest } from '../src/backfill/run.js';
import { writeDynamoDbExport } from '../src/legacy/export-layout.js';
import { generateLegacyItems } from '../src/legacy/generate.js';

const LEGACY = 'legacy-exports';
const EVIDENCE = 'evidence';
const PREFIX = 'exports/AWSDynamoDB/01700000000000-abcd1234';

describeWithPostgres('backfill against PostgreSQL 16', () => {
  let t: TestDatabase;
  let deps: BackfillDeps;
  const store = new MemoryObjectStore();
  const expectedRejects = Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as Record<
    RejectReason,
    number
  >;
  let items: LegacyItem[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.migrate();

    // DynamoDB keeps one item per PK+SK (later writes win), so the export never has key duplicates.
    const byKey = new Map<string, { item: LegacyItem; defect?: RejectReason }>();
    for (const g of generateLegacyItems({ count: 3000, seed: 7, defectRate: 0.02 })) {
      byKey.set(`${g.item.PK}|${g.item.SK}`, g);
    }
    for (const { defect } of byKey.values()) if (defect) expectedRejects[defect] += 1;
    items = [...byKey.values()].map((g) => g.item);
    await writeDynamoDbExport(store, items, {
      bucket: LEGACY,
      exportPrefix: PREFIX,
      itemsPerFile: 700,
    });

    deps = {
      db: t.db,
      store,
      legacyExportBucket: LEGACY,
      evidenceBucket: EVIDENCE,
      manifestPrefix: 'backfill/',
      logger: silentLogger,
    };
  });

  afterAll(async () => {
    await t.drop();
  });

  const count = async () =>
    Number(
      (
        await t.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_event WHERE source = 'backfill'`,
        )
      ).rows[0]?.n,
    );

  const evidence = (runId: string) => ({
    manifest: JSON.parse(
      store.read(EVIDENCE, `backfill/${runId}/manifest.json`).toString('utf8'),
    ) as BackfillManifest,
    rejected: store
      .read(EVIDENCE, `backfill/${runId}/rejected.jsonl`)
      .toString('utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { reason: RejectReason; pk: string; detail: string }),
  });

  let firstRun: BackfillManifest;

  it('dry run predicts the insert count and writes nothing to the table', async () => {
    const dry = await runBackfill({ exportPrefix: PREFIX, runId: 'dry-1', dryRun: true }, deps);
    expect(dry.dryRun).toBe(true);
    expect(dry.read).toBe(items.length);
    expect(dry.read).toBe(dry.inserted + dry.alreadyPresent + dry.rejected);
    expect(dry.alreadyPresent).toBe(0);
    expect(await count()).toBe(0);
    expect(evidence('dry-1').manifest).toEqual(dry);
  });

  it('first run: invariant holds, every reject carries its reason, rows land as backfill', async () => {
    firstRun = await runBackfill({ exportPrefix: `${PREFIX}/`, runId: 'run-1' }, deps);
    const total = Object.values(expectedRejects).reduce((a, b) => a + b, 0);

    expect(firstRun.read).toBe(items.length);
    expect(firstRun.read).toBe(firstRun.inserted + firstRun.alreadyPresent + firstRun.rejected);
    expect(firstRun.rejected).toBe(total);
    expect(firstRun.rejectReasons).toEqual(expectedRejects);
    for (const reason of [
      'invalid_scope',
      'invalid_date',
      'invalid_changes',
      'invalid_event_id',
    ] as const) {
      expect(firstRun.rejectReasons[reason]).toBeGreaterThan(0);
    }
    expect(firstRun.inserted).toBe(firstRun.read - firstRun.rejected);
    expect(await count()).toBe(firstRun.inserted);

    const dry = evidence('dry-1').manifest;
    expect(dry.inserted).toBe(firstRun.inserted);

    const { manifest, rejected } = evidence('run-1');
    expect(manifest).toEqual(firstRun);
    expect(rejected).toHaveLength(total);
    for (const reason of REJECT_REASONS) {
      expect(rejected.filter((r) => r.reason === reason)).toHaveLength(expectedRejects[reason]);
    }
    expect(rejected.every((r) => r.pk.startsWith('TENANT#') && r.detail.length > 0)).toBe(true);

    expect(Object.values(firstRun.byScope).reduce((a, b) => a + b, 0)).toBe(firstRun.inserted);
    expect(Object.values(firstRun.byMonth).reduce((a, b) => a + b, 0)).toBe(firstRun.inserted);
    expect(
      firstRun.minOccurredAt &&
        firstRun.maxOccurredAt &&
        firstRun.minOccurredAt < firstRun.maxOccurredAt,
    ).toBe(true);
  });

  it('stores case-folded scopes and derived ids for items without EventId', async () => {
    const { rows } = await t.admin.query<{ scopes: string[]; derived: string }>(
      `SELECT array_agg(DISTINCT scope::text ORDER BY scope::text) AS scopes,
              count(*) FILTER (WHERE substring(event_id::text, 15, 1) = '5')::text AS derived
       FROM audit_event`,
    );
    expect(rows[0]?.scopes).toEqual([
      'accounts',
      'billing',
      'catalog',
      'orders',
      'security',
      'settings',
    ]);
    expect(Number(rows[0]?.derived)).toBeGreaterThan(0);
  });

  it('second run over the same export inserts nothing', async () => {
    const second = await runBackfill({ exportPrefix: PREFIX, runId: 'run-2' }, deps);
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(firstRun.inserted);
    expect(second.rejected).toBe(firstRun.rejected);
    expect(await count()).toBe(firstRun.inserted);
  });

  it('refuses to reuse a runId and leaves the existing evidence untouched', async () => {
    const before = store.read(EVIDENCE, 'backfill/run-1/manifest.json').toString('utf8');
    await expect(runBackfill({ exportPrefix: PREFIX, runId: 'run-1' }, deps)).rejects.toThrow(
      /already has evidence/,
    );
    expect(store.read(EVIDENCE, 'backfill/run-1/manifest.json').toString('utf8')).toBe(before);
  });

  describe('the backfilled rows are append-only like any other', () => {
    it('writer cannot change them', async () => {
      const writer = await t.connectAs('writer');
      try {
        await expect(
          writer.query(`UPDATE audit_event SET comment = 'x' WHERE source = 'backfill'`),
        ).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await writer.end();
      }
    });
  });
});
