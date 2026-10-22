import {
  DIGEST_SESSION_SQL,
  GENESIS_HASH,
  HASH_RANGE_SQL,
  SEALABLE_UPPER_BOUND_SQL,
  silentLogger,
  type DbAccess,
  type DbClient,
  type Logger,
} from '@audit/core';
import { z } from 'zod';
import type { Metric, MetricsSink, ObjectStore } from '../ports.js';

export interface DigestBlock {
  fromRowId: string;
  toRowId: string;
  rows: number;
  hash: string;
  prevHash: string;
  sealedAt: string;
}

const blockSchema = z.strictObject({
  fromRowId: z.string().regex(/^\d+$/),
  toRowId: z.string().regex(/^\d+$/),
  rows: z.number().int().nonnegative(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  sealedAt: z.iso.datetime(),
});

export interface DigestDeps {
  db: DbAccess;
  store: ObjectStore;
  metrics: MetricsSink;
  bucket: string;
  prefix: string;
  reverifyDays: number;
  /**
   * Caps a block so string_agg stays far below PostgreSQL's 1 GB text limit; a busy day is sealed as
   * several chained blocks instead of one.
   */
  maxBlockRows?: number;
  clock?: () => Date;
  logger?: Logger;
}

export interface DigestResult {
  sealed: DigestBlock[];
  verified: number;
  mismatches: { key: string; reason: string }[];
  rowIdGaps: number;
  digestAgeHours: number | null;
}

interface StoredBlock {
  key: string;
  from: bigint;
  to: bigint;
}

const KEY_PATTERN = /(\d{4})\/(\d{2})\/(\d{2})\/(\d+)-(\d+)\.json$/;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function blockKey(prefix: string, sealedAt: Date, from: bigint, to: bigint): string {
  const y = String(sealedAt.getUTCFullYear());
  const mo = String(sealedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sealedAt.getUTCDate()).padStart(2, '0');
  return `${prefix}${y}/${mo}/${d}/${from.toString()}-${to.toString()}.json`;
}

async function listBlocks(
  store: ObjectStore,
  bucket: string,
  prefix: string,
): Promise<StoredBlock[]> {
  const blocks: StoredBlock[] = [];
  for await (const key of store.listKeys(bucket, prefix)) {
    const m = KEY_PATTERN.exec(key);
    if (!m?.[4] || !m[5]) continue;
    blocks.push({ key, from: BigInt(m[4]), to: BigInt(m[5]) });
  }
  return blocks.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

async function readBlock(store: ObjectStore, bucket: string, key: string): Promise<DigestBlock> {
  return blockSchema.parse(JSON.parse(await store.getText(bucket, key)));
}

async function hashRange(client: DbClient, from: bigint, to: bigint, prevHash: string) {
  const { rows } = await client.query<{ rows: string; hash: string }>(HASH_RANGE_SQL, [
    from.toString(),
    to.toString(),
    prevHash,
  ]);
  const row = rows[0];
  if (!row) throw new Error('hash query returned no row');
  return { rows: Number(row.rows), hash: row.hash };
}

/** Read-only, UTC, one snapshot: every hash in a run sees the same rows. */
async function inDigestSession<T>(db: DbAccess, fn: (c: DbClient) => Promise<T>): Promise<T> {
  return db.withClient('reader', async (client) => {
    for (const statement of DIGEST_SESSION_SQL) await client.query(statement);
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

/**
 * Seals every closed, unsealed range of event_row_id (rows recorded before today 00:00 UTC) as chained
 * blocks, then re-verifies recent blocks. The job runs at 03:00 UTC; a writer transaction would have to
 * stay open for three hours across midnight to get an id inside an already-sealed range, and
 * idle_in_transaction_session_timeout makes that impossible for our roles.
 */
export async function runDigest(deps: DigestDeps): Promise<DigestResult> {
  const clock = deps.clock ?? (() => new Date());
  const logger = deps.logger ?? silentLogger;
  const maxBlockRows = BigInt(deps.maxBlockRows ?? 100_000);
  const now = clock();
  const cutoff = startOfUtcDay(now);

  const existing = await listBlocks(deps.store, deps.bucket, deps.prefix);
  const last = existing.at(-1);
  const lastBlock = last ? await readBlock(deps.store, deps.bucket, last.key) : undefined;

  const { sealed, rowIdGaps } = await inDigestSession(deps.db, async (client) => {
    const lastTo = last?.to ?? 0n;
    const { rows } = await client.query<{ to_row_id: string | null }>(SEALABLE_UPPER_BOUND_SQL, [
      lastTo.toString(),
      cutoff.toISOString(),
    ]);
    const upper = rows[0]?.to_row_id;
    const out: DigestBlock[] = [];
    let gaps = 0;
    if (upper === null || upper === undefined) return { sealed: out, rowIdGaps: gaps };

    let prevHash = lastBlock?.hash ?? GENESIS_HASH;
    for (let from = lastTo + 1n; from <= BigInt(upper); from += maxBlockRows) {
      const to =
        from + maxBlockRows - 1n < BigInt(upper) ? from + maxBlockRows - 1n : BigInt(upper);
      const { rows: count, hash } = await hashRange(client, from, to, prevHash);
      gaps += Number(to - from + 1n) - count;
      out.push({
        fromRowId: from.toString(),
        toRowId: to.toString(),
        rows: count,
        hash,
        prevHash,
        sealedAt: now.toISOString(),
      });
      prevHash = hash;
    }
    return { sealed: out, rowIdGaps: gaps };
  });

  for (const block of sealed) {
    const key = blockKey(deps.prefix, now, BigInt(block.fromRowId), BigInt(block.toRowId));
    await deps.store.putIfAbsent(
      deps.bucket,
      key,
      JSON.stringify(block) + '\n',
      'application/json',
    );
    logger.info('digest block sealed', { key, rows: block.rows });
  }

  const { verified, mismatches } = await verifyBlocks(deps, existing, now);

  const newest = sealed.at(-1) ?? lastBlock;
  const digestAgeHours = newest ? (now.getTime() - Date.parse(newest.sealedAt)) / 3_600_000 : null;

  const metrics: Metric[] = [
    { name: 'DigestMismatchCount', value: mismatches.length, unit: 'Count' },
    { name: 'RowIdGapCount', value: rowIdGaps, unit: 'Count' },
  ];
  if (digestAgeHours !== null) {
    metrics.push({ name: 'DigestAgeHours', value: digestAgeHours, unit: 'None' });
  }
  await deps.metrics.publish(metrics);

  if (mismatches.length > 0) logger.error('digest mismatch detected', { mismatches });
  logger.info('digest complete', { sealed: sealed.length, verified, rowIdGaps });
  return { sealed, verified, mismatches, rowIdGaps, digestAgeHours };
}

/**
 * Recomputes previously sealed blocks: the last `reverifyDays` days normally, all of them on the 1st
 * of the month. A block also fails if it does not link to its predecessor (chain or range broken).
 */
async function verifyBlocks(
  deps: DigestDeps,
  existing: readonly StoredBlock[],
  now: Date,
): Promise<{ verified: number; mismatches: { key: string; reason: string }[] }> {
  const full = now.getUTCDate() === 1;
  const since = startOfUtcDay(new Date(now.getTime() - deps.reverifyDays * 86_400_000));
  const inWindow = (key: string) => {
    const m = KEY_PATTERN.exec(key);
    if (!m) return false;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) >= since.getTime();
  };
  const firstIndex = full ? 0 : existing.findIndex((b) => inWindow(b.key));
  if (firstIndex < 0) return { verified: 0, mismatches: [] };

  const mismatches: { key: string; reason: string }[] = [];
  let previous: DigestBlock | undefined =
    firstIndex > 0
      ? await readBlock(deps.store, deps.bucket, (existing[firstIndex - 1] as StoredBlock).key)
      : undefined;
  const targets = existing.slice(firstIndex);

  await inDigestSession(deps.db, async (client) => {
    for (const stored of targets) {
      const block = await readBlock(deps.store, deps.bucket, stored.key);
      const expectedPrev = previous?.hash ?? GENESIS_HASH;
      const expectedFrom = previous ? BigInt(previous.toRowId) + 1n : 1n;
      if (block.prevHash !== expectedPrev) {
        mismatches.push({ key: stored.key, reason: 'prevHash does not match the previous block' });
      } else if (BigInt(block.fromRowId) !== expectedFrom) {
        mismatches.push({
          key: stored.key,
          reason: 'row range does not continue the previous block',
        });
      } else {
        const { rows, hash } = await hashRange(
          client,
          BigInt(block.fromRowId),
          BigInt(block.toRowId),
          block.prevHash,
        );
        if (rows !== block.rows || hash !== block.hash) {
          mismatches.push({
            key: stored.key,
            reason: `recomputed ${String(rows)} rows / ${hash.slice(0, 12)}`,
          });
        }
      }
      previous = block;
    }
  });
  return { verified: targets.length, mismatches };
}
