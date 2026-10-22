import type { LegacyItem } from '@audit/core';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { ObjectStore } from '../ports.js';

export interface ExportLayoutOptions {
  bucket: string;
  /** Directory that will hold manifest-summary.json, manifest-files.json and data/. */
  exportPrefix: string;
  itemsPerFile?: number;
  tableArn?: string;
  clock?: () => Date;
}

/**
 * Writes the same layout as DynamoDB ExportTableToPointInTime (DYNAMODB_JSON), so the backfill is
 * exercised against the real format locally, where no export API exists.
 */
export async function writeDynamoDbExport(
  store: ObjectStore,
  items: Iterable<LegacyItem> | AsyncIterable<LegacyItem>,
  options: ExportLayoutOptions,
): Promise<{ itemCount: number; files: number }> {
  const clock = options.clock ?? (() => new Date());
  const prefix = options.exportPrefix.replace(/\/+$/, '');
  const perFile = options.itemsPerFile ?? 10_000;
  const startTime = clock().toISOString();
  const manifestLines: string[] = [];
  let lines: string[] = [];
  let itemCount = 0;
  let billedSizeBytes = 0;

  const flush = async () => {
    if (lines.length === 0) return;
    const body = gzipSync(lines.join('\n') + '\n');
    const key = `${prefix}/data/${String(manifestLines.length).padStart(5, '0')}.json.gz`;
    await store.putIfAbsent(options.bucket, key, body, 'application/gzip');
    manifestLines.push(
      JSON.stringify({
        itemCount: lines.length,
        md5Checksum: createHash('md5').update(body).digest('base64'),
        etag: createHash('md5').update(body).digest('hex'),
        dataFileS3Key: key,
      }),
    );
    billedSizeBytes += body.length;
    lines = [];
  };

  for await (const item of items) {
    lines.push(JSON.stringify({ Item: marshall(item, { removeUndefinedValues: true }) }));
    itemCount += 1;
    if (lines.length >= perFile) await flush();
  }
  await flush();

  const manifestFilesKey = `${prefix}/manifest-files.json`;
  await store.putIfAbsent(
    options.bucket,
    manifestFilesKey,
    manifestLines.join('\n') + '\n',
    'application/json',
  );
  const tableArn = options.tableArn ?? 'arn:aws:dynamodb:us-east-1:000000000000:table/audit-legacy';
  const summary = {
    version: '2020-06-30',
    exportArn: `${tableArn}/export/${randomUUID()}`,
    startTime,
    endTime: clock().toISOString(),
    tableArn,
    tableId: randomUUID(),
    exportTime: startTime,
    s3Bucket: options.bucket,
    s3Prefix: prefix,
    s3SseAlgorithm: 'AES256',
    s3SseKmsKeyId: null,
    manifestFilesS3Key: manifestFilesKey,
    billedSizeBytes,
    itemCount,
    outputFormat: 'DYNAMODB_JSON',
  };
  await store.putIfAbsent(
    options.bucket,
    `${prefix}/manifest-summary.json`,
    JSON.stringify(summary, null, 2) + '\n',
    'application/json',
  );
  return { itemCount, files: manifestLines.length };
}
