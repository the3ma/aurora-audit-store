import { GENESIS_HASH, silentLogger } from '@audit/core';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createTestDatabase,
  describeWithPostgres,
  insertEvents,
  type TestDatabase,
} from '../../core/test/support/test-db.js';
import { MemoryMetrics, MemoryObjectStore } from '../src/adapters/memory.js';
import { runDigest, type DigestBlock, type DigestDeps } from '../src/digest/run.js';

const BUCKET = 'evidence';
const DAY = 86_400_000;

describeWithPostgres('digest (tamper evidence) against PostgreSQL 16', () => {
  let t: TestDatabase;
  const store = new MemoryObjectStore();
  const metrics = new MemoryMetrics();
  const tomorrow = () => new Date(Date.now() + DAY);

  const deps = (clock: () => Date): DigestDeps => ({
    db: t.db,
    store,
    metrics,
    bucket: BUCKET,
    prefix: 'audit-digest/',
    reverifyDays: 7,
    maxBlockRows: 20,
    clock,
    logger: silentLogger,
  });

  const blocks = () =>
    [...store.objects.keys()]
      .filter((k) => k.startsWith(`${BUCKET}/audit-digest/`))
      .map(
        (k) =>
          JSON.parse(
            store.read(BUCKET, k.slice(BUCKET.length + 1)).toString('utf8'),
          ) as DigestBlock,
      )
      .sort((a, b) => Number(BigInt(a.fromRowId) - BigInt(b.fromRowId)));

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.migrate();
    await insertEvents(
      t.db,
      Array.from({ length: 50 }, (_, i) => ({
        occurredAt: new Date(Date.parse('2025-01-01T00:00:00Z') + i * 1000).toISOString(),
        changes: [{ field: 'n', new: i }],
      })),
    );
  });

  afterAll(async () => {
    await t.drop();
  });

  it('seals closed ranges as a chain of blocks starting from the genesis hash', async () => {
    const result = await runDigest(deps(tomorrow));
    const sealed = blocks();
    expect(result.sealed).toEqual(sealed);
    expect(sealed.length).toBeGreaterThanOrEqual(3);
    expect(sealed[0]?.prevHash).toBe(GENESIS_HASH);
    expect(sealed[0]?.fromRowId).toBe('1');
    for (let i = 1; i < sealed.length; i += 1) {
      expect(sealed[i]?.prevHash).toBe(sealed[i - 1]?.hash);
      expect(BigInt(sealed[i]?.fromRowId ?? 0)).toBe(BigInt(sealed[i - 1]?.toRowId ?? 0) + 1n);
    }
    expect(sealed.reduce((n, b) => n + b.rows, 0)).toBe(50);
    // The proofs' rolled-back probe inserts consumed identity values: gaps are reported, not failed.
    expect(result.rowIdGaps).toBe(Number(sealed.at(-1)?.toRowId) - 50);
    expect(result.mismatches).toEqual([]);
    expect(metrics.last('DigestMismatchCount')).toBe(0);
    expect(metrics.last('RowIdGapCount')).toBe(result.rowIdGaps);
    expect(metrics.last('DigestAgeHours')).toBe(0);
  });

  it('does not seal rows recorded today', async () => {
    const before = blocks().length;
    await insertEvents(t.db, [{ occurredAt: '2025-02-01T00:00:00Z' }]);
    const result = await runDigest(deps(() => new Date()));
    expect(result.sealed).toEqual([]);
    expect(blocks()).toHaveLength(before);
  });

  it('matches an independent recomputation of the documented formula', async () => {
    const block = blocks()[0] as DigestBlock;
    const client = await t.connectAs('reader');
    try {
      await client.query(`SET TimeZone = 'UTC'`);
      const { rows } = await client.query<{ j: string }>(
        'SELECT to_jsonb(e)::text AS j FROM audit_event e WHERE event_row_id BETWEEN $1 AND $2 ORDER BY event_row_id',
        [block.fromRowId, block.toRowId],
      );
      const rowsHash = createHash('sha256')
        .update(rows.map((r) => r.j).join('\n'), 'utf8')
        .digest();
      const hash = createHash('sha256')
        .update(Buffer.from(block.prevHash, 'hex'))
        .update(rowsHash)
        .digest('hex');
      expect(hash).toBe(block.hash);
    } finally {
      await client.end();
    }
  });

  it('re-verifies without mismatches, independent of the session time zone', async () => {
    await t.admin.query(`ALTER ROLE audit_reader SET TimeZone = 'America/New_York'`);
    try {
      await t.db.end();
      const result = await runDigest(deps(() => new Date(Date.now() + DAY + 3_600_000)));
      expect(result.verified).toBe(blocks().length - result.sealed.length);
      expect(result.mismatches).toEqual([]);
    } finally {
      await t.admin.query('ALTER ROLE audit_reader RESET TimeZone');
      await t.db.end();
    }
  });

  it('continues the chain on the next day', async () => {
    await insertEvents(t.db, [{ occurredAt: '2025-03-01T00:00:00Z' }]);
    const lastBefore = blocks().at(-1) as DigestBlock;
    const result = await runDigest(deps(() => new Date(Date.now() + 2 * DAY)));
    expect(result.sealed.length).toBeGreaterThan(0);
    expect(result.sealed[0]?.prevHash).toBe(lastBefore.hash);
    expect(BigInt(result.sealed[0]?.fromRowId ?? 0)).toBe(BigInt(lastBefore.toRowId) + 1n);
  });

  it('detects a row changed behind the triggers (tampering by a privileged user)', async () => {
    const target = blocks()[1] as DigestBlock;
    await t.admin.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_deny_update_delete');
    try {
      await t.admin.query(
        `UPDATE audit_event SET comment = 'quietly edited'
         WHERE event_row_id = (SELECT min(event_row_id) FROM audit_event WHERE event_row_id BETWEEN $1 AND $2)`,
        [target.fromRowId, target.toRowId],
      );
    } finally {
      await t.admin.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_deny_update_delete');
    }
    const result = await runDigest(deps(() => new Date(Date.now() + 2 * DAY + 3_600_000)));
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]?.key).toContain(`/${target.fromRowId}-${target.toRowId}.json`);
    expect(metrics.last('DigestMismatchCount')).toBe(1);
  });

  it('detects a block whose evidence object was replaced', async () => {
    const all = blocks();
    const victim = all[0] as DigestBlock;
    const key = [...store.objects.keys()].find((k) =>
      k.endsWith(`/${victim.fromRowId}-${victim.toRowId}.json`),
    ) as string;
    store.objects.set(key, Buffer.from(JSON.stringify({ ...victim, hash: 'f'.repeat(64) })));
    const result = await runDigest(deps(() => new Date(Date.now() + 2 * DAY + 7_200_000)));
    expect(result.mismatches.map((m) => m.reason)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/recomputed/),
        expect.stringMatching(/prevHash/),
      ]),
    );
  });
});
