import { describeError, type LegacyItem } from '@audit/core';
import { DynamoDBClient, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, HeadBucketCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { s3Client, s3ObjectStore } from '../adapters/s3.js';
import { writeDynamoDbExport } from '../legacy/export-layout.js';
import { functionLogger, requireEnv, stringEnv } from '../runtime.js';

const logger = functionLogger('simulate-export');

const { values } = parseArgs({
  options: {
    table: { type: 'string', default: stringEnv('LEGACY_TABLE', 'audit-legacy') },
    bucket: { type: 'string' },
    'export-prefix': { type: 'string' },
    segments: { type: 'string', default: '4' },
  },
  strict: true,
});

const table = values.table;
const bucket = values.bucket ?? requireEnv('LEGACY_EXPORT_BUCKET');
const exportId = `${String(Date.now())}-${randomBytes(4).toString('hex')}`;
const exportPrefix = values['export-prefix'] ?? `exports/AWSDynamoDB/${exportId}`;
const segments = Number(values.segments);
const dynamo = new DynamoDBClient({});
const s3 = s3Client();

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404) {
      throw error;
    }
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

/** Parallel scan. (The managed export reads PITR backups instead and costs no table capacity.) */
async function* scanTable(): AsyncGenerator<LegacyItem> {
  const queues = Array.from({ length: segments }, (_, segment) => scanSegment(segment));
  for (const queue of queues) yield* await queue;
}

async function scanSegment(segment: number): Promise<LegacyItem[]> {
  const items: LegacyItem[] = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const out = await dynamo.send(
      new ScanCommand({
        TableName: table,
        Segment: segment,
        TotalSegments: segments,
        ExclusiveStartKey: start,
      }),
    );
    for (const raw of out.Items ?? []) items.push(unmarshall(raw) as LegacyItem);
    start = out.LastEvaluatedKey;
  } while (start);
  return items;
}

try {
  if (!Number.isInteger(segments) || segments < 1 || segments > 64) {
    throw new Error('--segments must be 1-64');
  }
  await ensureBucket();
  const result = await writeDynamoDbExport(s3ObjectStore(s3), scanTable(), {
    bucket,
    exportPrefix,
  });
  logger.info('export written', { bucket, exportPrefix, ...result });
  // The one line a script needs: what to pass to `npm run backfill -- --export-prefix`.
  process.stdout.write(`${exportPrefix}\n`);
} catch (error) {
  logger.error('simulate export failed', { error: describeError(error) });
  process.exitCode = 1;
}
