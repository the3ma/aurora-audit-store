import {
  DescribeDBClusterSnapshotsCommand,
  DescribeExportTasksCommand,
  RDSClient,
  StartExportTaskCommand,
  type DBClusterSnapshot,
  type ExportTask,
} from '@aws-sdk/client-rds';
import { silentLogger, type Logger } from '@audit/core';
import type { Metric, MetricsSink } from '../ports.js';

/** The RDS calls the archive job makes; a fake implements this in tests. */
export interface SnapshotExportApi {
  listAutomatedSnapshots(clusterIdentifier: string): Promise<DBClusterSnapshot[]>;
  listExportTasks(): Promise<ExportTask[]>;
  startExportTask(input: {
    exportTaskIdentifier: string;
    sourceArn: string;
    bucket: string;
    prefix: string;
    roleArn: string;
    kmsKeyArn: string;
  }): Promise<void>;
}

export function rdsSnapshotExportApi(client = new RDSClient({})): SnapshotExportApi {
  return {
    listAutomatedSnapshots: async (clusterIdentifier) => {
      const snapshots: DBClusterSnapshot[] = [];
      let marker: string | undefined;
      do {
        const out = await client.send(
          new DescribeDBClusterSnapshotsCommand({
            DBClusterIdentifier: clusterIdentifier,
            SnapshotType: 'automated',
            Marker: marker,
          }),
        );
        snapshots.push(...(out.DBClusterSnapshots ?? []));
        marker = out.Marker;
      } while (marker);
      return snapshots;
    },
    listExportTasks: async () => {
      const tasks: ExportTask[] = [];
      let marker: string | undefined;
      do {
        const out = await client.send(new DescribeExportTasksCommand({ Marker: marker }));
        tasks.push(...(out.ExportTasks ?? []));
        marker = out.Marker;
      } while (marker);
      return tasks.filter((t) => t.ExportTaskIdentifier?.startsWith(TASK_PREFIX));
    },
    startExportTask: async (input) => {
      await client.send(
        new StartExportTaskCommand({
          ExportTaskIdentifier: input.exportTaskIdentifier,
          SourceArn: input.sourceArn,
          S3BucketName: input.bucket,
          S3Prefix: input.prefix,
          IamRoleArn: input.roleArn,
          KmsKeyId: input.kmsKeyArn,
          ExportOnly: ['audit.public.audit_event'],
        }),
      );
    },
  };
}

const TASK_PREFIX = 'audit-archive-';
const TERMINAL_FAILURE = new Set(['FAILED', 'CANCELED', 'CANCELING']);

export interface ArchiveConfig {
  clusterArn: string;
  bucket: string;
  prefix: string;
  roleArn: string;
  kmsKeyArn: string;
  staleDays: number;
}

export interface ArchiveDeps {
  rds: SnapshotExportApi;
  metrics: MetricsSink;
  clock?: () => Date;
  logger?: Logger;
}

export type ArchiveOutcome =
  | { action: 'started'; taskId: string; snapshotArn: string }
  | { action: 'exists'; taskId: string; status: string }
  | { action: 'no_snapshot'; taskId: string };

export interface ArchiveResult {
  outcome: ArchiveOutcome;
  archiveAgeDays: number | null;
  stale: boolean;
}

export function monthlyTaskId(now: Date): string {
  return `${TASK_PREFIX}${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function clusterIdentifierFromArn(arn: string): string {
  const m = /^arn:aws[a-z-]*:rds:[a-z0-9-]+:\d{12}:cluster:([A-Za-z][A-Za-z0-9-]{0,62})$/.exec(arn);
  if (!m?.[1]) throw new Error('CLUSTER_ARN is not an RDS cluster ARN');
  return m[1];
}

/**
 * Once a month, export the latest available automated snapshot of the month to S3 (Parquet), which is
 * the 7-year archive. The task id is derived from the month, so the daily schedule is idempotent: after
 * the first successful start every later run that month finds the task and does nothing.
 */
export async function runArchiveExport(
  config: ArchiveConfig,
  deps: ArchiveDeps,
): Promise<ArchiveResult> {
  const clock = deps.clock ?? (() => new Date());
  const logger = deps.logger ?? silentLogger;
  const now = clock();
  const taskId = monthlyTaskId(now);

  const tasks = await deps.rds.listExportTasks();
  const current = tasks.find((t) => t.ExportTaskIdentifier === taskId);

  let outcome: ArchiveOutcome;
  if (current) {
    const status = current.Status ?? 'UNKNOWN';
    outcome = { action: 'exists', taskId, status };
    // A failed task keeps its identifier, so it cannot be retried under the same id automatically;
    // the stale-archive alarm and the runbook take it from here.
    if (TERMINAL_FAILURE.has(status)) {
      logger.error('archive export task did not complete', {
        taskId,
        status,
        reason: current.FailureCause,
      });
    }
  } else {
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const candidate = (
      await deps.rds.listAutomatedSnapshots(clusterIdentifierFromArn(config.clusterArn))
    )
      .filter(
        (s) =>
          s.Status === 'available' &&
          s.DBClusterSnapshotArn !== undefined &&
          s.SnapshotCreateTime !== undefined &&
          s.SnapshotCreateTime.getTime() >= monthStart,
      )
      .sort(
        (a, b) => (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0),
      )[0];

    if (candidate?.DBClusterSnapshotArn) {
      await deps.rds.startExportTask({
        exportTaskIdentifier: taskId,
        sourceArn: candidate.DBClusterSnapshotArn,
        bucket: config.bucket,
        prefix: config.prefix.replace(/\/+$/, ''),
        roleArn: config.roleArn,
        kmsKeyArn: config.kmsKeyArn,
      });
      outcome = { action: 'started', taskId, snapshotArn: candidate.DBClusterSnapshotArn };
      logger.info('archive export started', {
        taskId,
        snapshot: candidate.DBClusterSnapshotIdentifier,
      });
    } else {
      outcome = { action: 'no_snapshot', taskId };
      logger.warn('no available automated snapshot this month yet', { taskId });
    }
  }

  const newestComplete = tasks
    .filter((t) => t.Status === 'COMPLETE' && t.SnapshotTime !== undefined)
    .map((t) => (t.SnapshotTime as Date).getTime())
    .sort((a, b) => b - a)[0];
  const archiveAgeDays =
    newestComplete === undefined ? null : (now.getTime() - newestComplete) / 86_400_000;
  const stale = archiveAgeDays === null || archiveAgeDays > config.staleDays;

  const metrics: Metric[] = [{ name: 'ArchiveStale', value: stale ? 1 : 0, unit: 'Count' }];
  if (archiveAgeDays !== null) {
    metrics.push({ name: 'ArchiveAgeDays', value: archiveAgeDays, unit: 'None' });
  }
  await deps.metrics.publish(metrics);

  return { outcome, archiveAgeDays, stale };
}
