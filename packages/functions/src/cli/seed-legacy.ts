import { describeError } from '@audit/core';
import {
  BatchWriteItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateLegacyItems } from '../legacy/generate.js';
import { functionLogger, intEnv, stringEnv } from '../runtime.js';

const logger = functionLogger('seed-legacy');
const table = stringEnv('LEGACY_TABLE', 'audit-legacy');
const count = intEnv('SEED_ITEMS', 20_000);
const seed = intEnv('SEED_RANDOM', 42);
const client = new DynamoDBClient({});

/** The legacy table exactly as it was designed, overloaded GSIs included. */
async function ensureTable(): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  const gsi = (name: string, pk: string, sk: string) => ({
    IndexName: name,
    KeySchema: [
      { AttributeName: pk, KeyType: 'HASH' as const },
      { AttributeName: sk, KeyType: 'RANGE' as const },
    ],
    Projection: { ProjectionType: 'ALL' as const },
  });
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI3PK', 'GSI4PK'].map(
        (name) => ({
          AttributeName: name,
          AttributeType: 'S' as const,
        }),
      ),
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        gsi('GSI1', 'GSI1PK', 'GSI1SK'),
        gsi('GSI2', 'GSI2PK', 'SK'),
        gsi('GSI3', 'GSI3PK', 'SK'),
        gsi('GSI4', 'GSI4PK', 'SK'),
      ],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: table });
  // TTL is deliberately NOT enabled here: on the old table ExpiresAt was live and deleted regulated
  // records after two years. Locally we keep them so the backfill sees the full history.
  logger.info('legacy table created', { table });
}

async function writeBatch(requests: WriteRequest[]): Promise<void> {
  let pending = requests;
  for (let attempt = 0; pending.length > 0; attempt += 1) {
    if (attempt > 8) throw new Error('BatchWriteItem kept returning unprocessed items');
    if (attempt > 0) await sleep(50 * 2 ** attempt);
    const out = await client.send(
      new BatchWriteItemCommand({ RequestItems: { [table]: pending } }),
    );
    pending = out.UnprocessedItems?.[table] ?? [];
  }
}

try {
  await ensureTable();
  const defects: Record<string, number> = {};
  let batch: WriteRequest[] = [];
  const inflight = new Set<Promise<void>>();
  let written = 0;

  const submit = async (requests: WriteRequest[]) => {
    const p = writeBatch(requests).then(() => {
      written += requests.length;
      inflight.delete(p);
    });
    inflight.add(p);
    if (inflight.size >= 8) await Promise.race(inflight);
  };

  for (const { item, defect } of generateLegacyItems({ count, seed })) {
    if (defect) defects[defect] = (defects[defect] ?? 0) + 1;
    batch.push({ PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) } });
    if (batch.length === 25) {
      await submit(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await submit(batch);
  await Promise.all(inflight);
  // Items whose PK+SK collide overwrite each other, as they did in production, so the table can end up
  // with fewer items than were written.
  logger.info('legacy items written', { table, written, defects });
} catch (error) {
  logger.error('seed failed', { error: describeError(error) });
  process.exitCode = 1;
}
