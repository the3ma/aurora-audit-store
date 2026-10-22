import { cloudWatchMetrics } from '../adapters/cloudwatch.js';
import { rdsSnapshotExportApi, runArchiveExport, type ArchiveResult } from '../archive/run.js';
import { functionLogger, intEnv, requireEnv, stringEnv } from '../runtime.js';

const logger = functionLogger('archive-export');

export class ArchiveStaleError extends Error {
  override readonly name = 'ArchiveStaleError';
}

/** Metrics are already published when this throws; the failure is what the Errors alarm sees. */
export function assertFresh(result: ArchiveResult, staleDays: number): ArchiveResult {
  if (result.stale) {
    const age =
      result.archiveAgeDays === null
        ? 'no completed archive'
        : `${result.archiveAgeDays.toFixed(1)} days old`;
    throw new ArchiveStaleError(
      `newest archive export is stale (${age}; limit ${String(staleDays)} days)`,
    );
  }
  return result;
}

export async function handler(): Promise<ArchiveResult> {
  const staleDays = intEnv('ARCHIVE_STALE_DAYS', 40);
  const result = await runArchiveExport(
    {
      clusterArn: requireEnv('CLUSTER_ARN'),
      bucket: requireEnv('EVIDENCE_BUCKET'),
      prefix: stringEnv('ARCHIVE_PREFIX', 'archive/'),
      roleArn: requireEnv('EXPORT_ROLE_ARN'),
      kmsKeyArn: requireEnv('EXPORT_KMS_KEY_ARN'),
      staleDays,
    },
    { rds: rdsSnapshotExportApi(), metrics: cloudWatchMetrics(), logger },
  );
  return assertFresh(result, staleDays);
}
