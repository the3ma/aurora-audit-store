import {
  INSERT_EVENTS_SQL,
  mapLegacyItem,
  parseExportLine,
  REJECT_REASONS,
  silentLogger,
  type DbAccess,
  type LegacyItem,
  type Logger,
  type NewAuditEvent,
  type RejectReason,
} from '@audit/core';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import type { ObjectStore } from '../ports.js';

export const BATCH_SIZE = 500;

export const backfillInputSchema = z.strictObject({
  exportPrefix: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9!_.*'()/-]+$/, 'exportPrefix has unsupported characters')
    .refine(
      (p) => !p.startsWith('/') && !p.split('/').includes('..'),
      'exportPrefix must be relative',
    ),
  runId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'runId must be 1-64 of [A-Za-z0-9._-]')
    .optional(),
  dryRun: z.boolean().default(false),
});
export type BackfillInput = z.input<typeof backfillInputSchema>;

export interface BackfillManifest {
  runId: string;
  exportPrefix: string;
  startedAt: string;
  finishedAt: string;
  read: number;
  inserted: number;
  alreadyPresent: number;
  rejected: number;
  rejectReasons: Record<RejectReason, number>;
  byScope: Record<string, number>;
  byMonth: Record<string, number>;
  minOccurredAt: string | null;
  maxOccurredAt: string | null;
  dryRun: boolean;
}

export interface BackfillDeps {
  db: DbAccess;
  store: ObjectStore;
  legacyExportBucket: string;
  evidenceBucket: string;
  manifestPrefix: string;
  logger?: Logger;
  clock?: () => Date;
  batchSize?: number;
}

export class BackfillInvariantError extends Error {
  override readonly name = 'BackfillInvariantError';
}

const exportSummarySchema = z.looseObject({
  outputFormat: z.string().optional(),
  itemCount: z.number().int().nonnegative().optional(),
  manifestFilesS3Key: z.string().min(1).optional(),
});

const exportFileSchema = z.looseObject({
  dataFileS3Key: z.string().min(1),
  itemCount: z.number().int().nonnegative(),
});

interface RejectedLine {
  reason: RejectReason;
  detail: string;
  file: string;
  line: number;
  pk: string | null;
  sk: string | null;
  item: LegacyItem;
}

export function defaultRunId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

/** The single invariant every run must satisfy before it is allowed to write evidence. */
export function assertInvariant(
  m: Pick<BackfillManifest, 'read' | 'inserted' | 'alreadyPresent' | 'rejected'>,
  expectedItems?: number,
): void {
  if (m.read !== m.inserted + m.alreadyPresent + m.rejected) {
    throw new BackfillInvariantError(
      `read (${String(m.read)}) != inserted (${String(m.inserted)}) + alreadyPresent (${String(m.alreadyPresent)}) + rejected (${String(m.rejected)})`,
    );
  }
  if (expectedItems !== undefined && expectedItems !== m.read) {
    throw new BackfillInvariantError(
      `export manifest declares ${String(expectedItems)} items but ${String(m.read)} were read`,
    );
  }
}

function toRecord(event: NewAuditEvent) {
  return {
    event_id: event.eventId,
    tenant_id: event.tenantId,
    project_id: event.projectId,
    scope: event.scope,
    entity_type: event.entityType,
    entity_id: event.entityId,
    entity_label: event.entityLabel,
    action: event.action,
    actor_id: event.actorId,
    actor_email: event.actorEmail,
    occurred_at: event.occurredAt,
    changes: event.changes,
    comment: event.comment,
    source: 'backfill',
  };
}

async function* readLines(store: ObjectStore, bucket: string, key: string): AsyncIterable<string> {
  const body = await store.getStream(bucket, key);
  const gunzip = createGunzip();
  // pipeline (not pipe) so a failing download or a corrupt gzip destroys the chain and surfaces here.
  const decompressed = pipeline(body, gunzip, () => undefined);
  const lines = createInterface({ input: decompressed, crlfDelay: Infinity });
  let failure: Error | undefined;
  decompressed.once('error', (error) => {
    failure = error;
    lines.close();
  });
  for await (const line of lines) yield line;
  if (failure) throw failure;
}

/**
 * Reads a DynamoDB point-in-time export, maps each item, and inserts in batches with
 * ON CONFLICT (event_id) DO NOTHING. Re-running over the same export is safe and inserts nothing.
 * Evidence (rejected.jsonl, then manifest.json) is written only after the counts reconcile, and is
 * write-once: a runId cannot be reused.
 */
export async function runBackfill(
  rawInput: BackfillInput,
  deps: BackfillDeps,
): Promise<BackfillManifest> {
  const input = backfillInputSchema.parse(rawInput);
  const clock = deps.clock ?? (() => new Date());
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const startedAt = clock();
  const runId = input.runId ?? defaultRunId(startedAt);
  const exportPrefix = input.exportPrefix.replace(/\/+$/, '');
  const evidencePrefix = `${deps.manifestPrefix}${runId}/`;
  const logger = (deps.logger ?? silentLogger).child({ runId, exportPrefix, dryRun: input.dryRun });

  for await (const key of deps.store.listKeys(deps.evidenceBucket, evidencePrefix)) {
    throw new BackfillInvariantError(
      `runId ${runId} already has evidence (${key}); use a new runId`,
    );
  }

  const summary = exportSummarySchema.parse(
    JSON.parse(
      await deps.store.getText(deps.legacyExportBucket, `${exportPrefix}/manifest-summary.json`),
    ),
  );
  if (summary.outputFormat !== undefined && summary.outputFormat !== 'DYNAMODB_JSON') {
    throw new Error(`unsupported export format ${summary.outputFormat}; expected DYNAMODB_JSON`);
  }
  const filesKey = summary.manifestFilesS3Key ?? `${exportPrefix}/manifest-files.json`;
  const files = (await deps.store.getText(deps.legacyExportBucket, filesKey))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => exportFileSchema.parse(JSON.parse(l)));

  const m: BackfillManifest = {
    runId,
    exportPrefix,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    read: 0,
    inserted: 0,
    alreadyPresent: 0,
    rejected: 0,
    rejectReasons: Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as Record<
      RejectReason,
      number
    >,
    byScope: {},
    byMonth: {},
    minOccurredAt: null,
    maxOccurredAt: null,
    dryRun: input.dryRun,
  };
  const rejected: RejectedLine[] = [];
  let batch: NewAuditEvent[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const records = batch.map(toRecord);
    batch = [];
    let inserted: number;
    if (input.dryRun) {
      // Read-only estimate: duplicates across batches inside the export are not detected here.
      const ids = [...new Set(records.map((r) => r.event_id))];
      const { rows } = await deps.db.withClient('writer', (c) =>
        c.query<{ n: string }>(
          'SELECT count(*)::bigint AS n FROM audit_event WHERE event_id = ANY($1::uuid[])',
          [ids],
        ),
      );
      inserted = ids.length - Number(rows[0]?.n ?? 0);
    } else {
      const result = await deps.db.withClient('writer', (c) =>
        c.query(INSERT_EVENTS_SQL, [JSON.stringify(records)]),
      );
      inserted = result.rowCount ?? 0;
    }
    m.inserted += inserted;
    m.alreadyPresent += records.length - inserted;
  };

  for (const file of files) {
    let lineNo = 0;
    let itemsInFile = 0;
    for await (const line of readLines(deps.store, deps.legacyExportBucket, file.dataFileS3Key)) {
      lineNo += 1;
      const item = parseExportLine(line);
      if (!item) continue;
      itemsInFile += 1;
      m.read += 1;
      const result = mapLegacyItem(item);
      if (!result.ok) {
        m.rejected += 1;
        m.rejectReasons[result.reason] += 1;
        rejected.push({
          reason: result.reason,
          detail: result.detail,
          file: file.dataFileS3Key,
          line: lineNo,
          pk: typeof item.PK === 'string' ? item.PK : null,
          sk: typeof item.SK === 'string' ? item.SK : null,
          item,
        });
        continue;
      }
      const { event } = result;
      m.byScope[event.scope] = (m.byScope[event.scope] ?? 0) + 1;
      const month = event.occurredAt.slice(0, 7);
      m.byMonth[month] = (m.byMonth[month] ?? 0) + 1;
      if (m.minOccurredAt === null || event.occurredAt < m.minOccurredAt) {
        m.minOccurredAt = event.occurredAt;
      }
      if (m.maxOccurredAt === null || event.occurredAt > m.maxOccurredAt) {
        m.maxOccurredAt = event.occurredAt;
      }
      batch.push(event);
      if (batch.length >= batchSize) await flush();
    }
    if (itemsInFile !== file.itemCount) {
      throw new BackfillInvariantError(
        `${file.dataFileS3Key}: manifest declares ${String(file.itemCount)} items, read ${String(itemsInFile)}`,
      );
    }
    logger.info('export file processed', {
      file: file.dataFileS3Key,
      items: itemsInFile,
      read: m.read,
    });
  }
  await flush();

  assertInvariant(m, summary.itemCount);
  m.finishedAt = clock().toISOString();

  await deps.store.putIfAbsent(
    deps.evidenceBucket,
    `${evidencePrefix}rejected.jsonl`,
    rejected.map((r) => JSON.stringify(r)).join('\n') + (rejected.length > 0 ? '\n' : ''),
    'application/x-ndjson',
  );
  // The manifest goes last: its presence is what marks the run as complete.
  await deps.store.putIfAbsent(
    deps.evidenceBucket,
    `${evidencePrefix}manifest.json`,
    JSON.stringify(m, null, 2) + '\n',
    'application/json',
  );
  logger.info('backfill complete', {
    read: m.read,
    inserted: m.inserted,
    alreadyPresent: m.alreadyPresent,
    rejected: m.rejected,
  });
  return m;
}
