import { silentLogger, type DbAccess, type DbClient, type LegacyItem } from '@audit/core';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../src/adapters/memory.js';
import {
  assertInvariant,
  BackfillInvariantError,
  runBackfill,
  type BackfillDeps,
} from '../src/backfill/run.js';
import { writeDynamoDbExport } from '../src/legacy/export-layout.js';
import { generateLegacyItems } from '../src/legacy/generate.js';

/** Fake writer: remembers event ids so ON CONFLICT DO NOTHING can be simulated without PostgreSQL. */
function fakeDb(): DbAccess & { ids: Set<string> } {
  const ids = new Set<string>();
  const client = {
    query: (_sql: string, [json]: [string]) => {
      let inserted = 0;
      for (const r of JSON.parse(json) as { event_id: string }[]) {
        if (!ids.has(r.event_id)) {
          ids.add(r.event_id);
          inserted += 1;
        }
      }
      return Promise.resolve({ rowCount: inserted, rows: [] });
    },
  } as unknown as DbClient;
  return { ids, withClient: (_role, fn) => fn(client) };
}

const items = (n: number): LegacyItem[] =>
  [...generateLegacyItems({ count: n, seed: 3 })].map((g) => g.item);

async function setup(n = 120) {
  const store = new MemoryObjectStore();
  await writeDynamoDbExport(store, items(n), {
    bucket: 'legacy',
    exportPrefix: 'exp/1',
    itemsPerFile: 50,
  });
  const db = fakeDb();
  const deps: BackfillDeps = {
    db,
    store,
    legacyExportBucket: 'legacy',
    evidenceBucket: 'evidence',
    manifestPrefix: 'backfill/',
    logger: silentLogger,
    batchSize: 25,
  };
  return { store, db, deps };
}

const evidenceKeys = (store: MemoryObjectStore) =>
  [...store.objects.keys()].filter((k) => k.startsWith('evidence/'));

describe('assertInvariant', () => {
  it('accepts read == inserted + alreadyPresent + rejected', () => {
    expect(() => {
      assertInvariant({ read: 10, inserted: 6, alreadyPresent: 3, rejected: 1 }, 10);
    }).not.toThrow();
  });

  it.each([
    [{ read: 10, inserted: 6, alreadyPresent: 3, rejected: 0 }, undefined],
    [{ read: 10, inserted: 7, alreadyPresent: 3, rejected: 1 }, undefined],
    [{ read: 10, inserted: 6, alreadyPresent: 3, rejected: 1 }, 11],
  ])('rejects %j (expected items %s)', (m, expected) => {
    expect(() => {
      assertInvariant(m, expected);
    }).toThrow(BackfillInvariantError);
  });
});

describe('runBackfill (fake database)', () => {
  it('writes rejected.jsonl and then manifest.json, and nothing else', async () => {
    const { store, deps, db } = await setup();
    const m = await runBackfill({ exportPrefix: 'exp/1', runId: 'r1' }, deps);
    expect(m.read).toBe(120);
    expect(db.ids.size).toBe(m.inserted);
    expect(evidenceKeys(store)).toEqual([
      'evidence/backfill/r1/rejected.jsonl',
      'evidence/backfill/r1/manifest.json',
    ]);
  });

  it('fails the invariant and writes no evidence when a data file is short', async () => {
    const { store, deps } = await setup();
    const files = store
      .read('legacy', 'exp/1/manifest-files.json')
      .toString('utf8')
      .trim()
      .split('\n');
    const first = JSON.parse(files[0] ?? '{}') as { itemCount: number };
    files[0] = JSON.stringify({ ...first, itemCount: first.itemCount + 1 });
    store.put('legacy', 'exp/1/manifest-files.json', files.join('\n'));
    await expect(runBackfill({ exportPrefix: 'exp/1', runId: 'r2' }, deps)).rejects.toThrow(
      BackfillInvariantError,
    );
    expect(evidenceKeys(store)).toEqual([]);
  });

  it('fails when the summary item count disagrees with what was read', async () => {
    const { store, deps } = await setup();
    const summary = JSON.parse(
      store.read('legacy', 'exp/1/manifest-summary.json').toString('utf8'),
    ) as Record<string, unknown>;
    store.put(
      'legacy',
      'exp/1/manifest-summary.json',
      JSON.stringify({ ...summary, itemCount: 999 }),
    );
    await expect(runBackfill({ exportPrefix: 'exp/1', runId: 'r3' }, deps)).rejects.toThrow(
      /declares 999/,
    );
    expect(evidenceKeys(store)).toEqual([]);
  });

  it('surfaces a corrupt gzip data file instead of under-counting', async () => {
    const { store, deps } = await setup();
    const key = 'exp/1/data/00001.json.gz';
    const good = store.read('legacy', key);
    store.put(
      'legacy',
      key,
      Buffer.concat([good.subarray(0, good.length / 2), Buffer.from('garbage')]),
    );
    await expect(runBackfill({ exportPrefix: 'exp/1', runId: 'r4' }, deps)).rejects.toThrow();
    expect(evidenceKeys(store)).toEqual([]);
  });

  it('rejects a corrupt export line as a hard failure', async () => {
    const { store, deps } = await setup();
    store.put('legacy', 'exp/1/data/00000.json.gz', gzipSync('{"not":"an item"}\n'));
    await expect(runBackfill({ exportPrefix: 'exp/1', runId: 'r5' }, deps)).rejects.toThrow(/Item/);
  });

  it('refuses non-DynamoDB-JSON exports', async () => {
    const { store, deps } = await setup();
    const summary = JSON.parse(
      store.read('legacy', 'exp/1/manifest-summary.json').toString('utf8'),
    ) as Record<string, unknown>;
    store.put(
      'legacy',
      'exp/1/manifest-summary.json',
      JSON.stringify({ ...summary, outputFormat: 'ION' }),
    );
    await expect(runBackfill({ exportPrefix: 'exp/1', runId: 'r6' }, deps)).rejects.toThrow(/ION/);
  });

  it.each([['../other'], ['/abs'], ['a b']])('rejects exportPrefix %j', async (exportPrefix) => {
    const { deps } = await setup(1);
    await expect(runBackfill({ exportPrefix }, deps)).rejects.toThrow();
  });

  it('rejects a malformed runId', async () => {
    const { deps } = await setup(1);
    await expect(runBackfill({ exportPrefix: 'exp/1', runId: '../x' }, deps)).rejects.toThrow(
      /runId/,
    );
  });
});

describe('generateLegacyItems', () => {
  it('is deterministic for a seed and produces every defect', () => {
    const a = [...generateLegacyItems({ count: 5000, seed: 11 })];
    const b = [...generateLegacyItems({ count: 5000, seed: 11 })];
    expect(a).toEqual(b);
    const defects = new Map<string, number>();
    for (const g of a) if (g.defect) defects.set(g.defect, (defects.get(g.defect) ?? 0) + 1);
    for (const reason of ['invalid_scope', 'invalid_date', 'invalid_changes', 'invalid_event_id']) {
      // ~1% each of 5000
      expect(defects.get(reason)).toBeGreaterThan(20);
      expect(defects.get(reason)).toBeLessThan(90);
    }
    expect(a.some((g) => g.item.EventId === undefined)).toBe(true);
    expect(a.some((g) => g.item.Scope !== g.item.Scope?.toLowerCase())).toBe(true);
    expect(new Set(a.map((g) => g.item.TenantId)).size).toBeGreaterThan(5);
  });
});
