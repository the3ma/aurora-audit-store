import type { DBClusterSnapshot, ExportTask } from '@aws-sdk/client-rds';
import { describe, expect, it } from 'vitest';
import { MemoryMetrics } from '../src/adapters/memory.js';
import { ArchiveStaleError, assertFresh } from '../src/handlers/archive-export.js';
import {
  clusterIdentifierFromArn,
  monthlyTaskId,
  runArchiveExport,
  type ArchiveConfig,
  type SnapshotExportApi,
} from '../src/archive/run.js';

const config: ArchiveConfig = {
  clusterArn: 'arn:aws:rds:us-east-1:000000000000:cluster:audit-cluster',
  bucket: 'evidence',
  prefix: 'archive/',
  roleArn: 'arn:aws:iam::000000000000:role/export',
  kmsKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/example',
  staleDays: 40,
};

const snapshot = (id: string, created: string, status = 'available'): DBClusterSnapshot => ({
  DBClusterSnapshotIdentifier: id,
  DBClusterSnapshotArn: `arn:aws:rds:us-east-1:000000000000:cluster-snapshot:${id}`,
  SnapshotCreateTime: new Date(created),
  Status: status,
});

function fakeRds(snapshots: DBClusterSnapshot[], tasks: ExportTask[] = []) {
  const started: Parameters<SnapshotExportApi['startExportTask']>[0][] = [];
  const api: SnapshotExportApi = {
    listAutomatedSnapshots: (id) => {
      expect(id).toBe('audit-cluster');
      return Promise.resolve(snapshots);
    },
    listExportTasks: () => Promise.resolve(tasks),
    startExportTask: (input) => {
      started.push(input);
      return Promise.resolve();
    },
  };
  return { api, started };
}

const now = new Date('2026-10-05T04:00:00Z');

describe('archive export', () => {
  it('derives a month-stable task id and the cluster identifier', () => {
    expect(monthlyTaskId(now)).toBe('audit-archive-2026-10');
    expect(clusterIdentifierFromArn(config.clusterArn)).toBe('audit-cluster');
    expect(() => clusterIdentifierFromArn('audit-cluster')).toThrow();
  });

  it('starts an export of the latest available automated snapshot of the month', async () => {
    const { api, started } = fakeRds([
      snapshot('rds:audit-2026-09-30', '2026-09-30T03:00:00Z'),
      snapshot('rds:audit-2026-10-03', '2026-10-03T03:00:00Z'),
      snapshot('rds:audit-2026-10-04', '2026-10-04T03:00:00Z'),
      snapshot('rds:audit-2026-10-05', '2026-10-05T03:00:00Z', 'creating'),
    ]);
    const metrics = new MemoryMetrics();
    const result = await runArchiveExport(config, { rds: api, metrics, clock: () => now });
    expect(result.outcome).toEqual({
      action: 'started',
      taskId: 'audit-archive-2026-10',
      snapshotArn: 'arn:aws:rds:us-east-1:000000000000:cluster-snapshot:rds:audit-2026-10-04',
    });
    expect(started).toEqual([
      expect.objectContaining({
        exportTaskIdentifier: 'audit-archive-2026-10',
        prefix: 'archive',
        bucket: 'evidence',
      }),
    ]);
    expect(result.stale).toBe(true);
    expect(metrics.last('ArchiveStale')).toBe(1);
  });

  it('is idempotent: an existing task for the month means nothing is started', async () => {
    const { api, started } = fakeRds(
      [snapshot('rds:audit-2026-10-04', '2026-10-04T03:00:00Z')],
      [
        { ExportTaskIdentifier: 'audit-archive-2026-10', Status: 'IN_PROGRESS' },
        {
          ExportTaskIdentifier: 'audit-archive-2026-09',
          Status: 'COMPLETE',
          SnapshotTime: new Date('2026-09-01T03:00:00Z'),
        },
      ],
    );
    const metrics = new MemoryMetrics();
    const result = await runArchiveExport(config, { rds: api, metrics, clock: () => now });
    expect(result.outcome).toEqual({
      action: 'exists',
      taskId: 'audit-archive-2026-10',
      status: 'IN_PROGRESS',
    });
    expect(started).toEqual([]);
    expect(result.archiveAgeDays).toBeCloseTo(34.04, 1);
    expect(result.stale).toBe(false);
    expect(metrics.last('ArchiveAgeDays')).toBeCloseTo(34.04, 1);
  });

  it('waits when the month has no available snapshot yet', async () => {
    const { api, started } = fakeRds([snapshot('rds:audit-2026-09-30', '2026-09-30T03:00:00Z')]);
    const result = await runArchiveExport(config, {
      rds: api,
      metrics: new MemoryMetrics(),
      clock: () => now,
    });
    expect(result.outcome).toEqual({ action: 'no_snapshot', taskId: 'audit-archive-2026-10' });
    expect(started).toEqual([]);
  });

  it('reports stale when the newest complete export is older than the threshold', async () => {
    const { api } = fakeRds(
      [],
      [
        {
          ExportTaskIdentifier: 'audit-archive-2026-08',
          Status: 'COMPLETE',
          SnapshotTime: new Date('2026-08-01T03:00:00Z'),
        },
        { ExportTaskIdentifier: 'audit-archive-2026-10', Status: 'FAILED' },
      ],
    );
    const result = await runArchiveExport(config, {
      rds: api,
      metrics: new MemoryMetrics(),
      clock: () => now,
    });
    expect(result.outcome).toMatchObject({ action: 'exists', status: 'FAILED' });
    expect(result.stale).toBe(true);
  });
});

describe('archive-export handler freshness', () => {
  const base = { outcome: { action: 'no_snapshot', taskId: 'audit-archive-2026-10' } } as const;

  it('passes a fresh result through', () => {
    const fresh = { ...base, archiveAgeDays: 3, stale: false };
    expect(assertFresh(fresh, 40)).toBe(fresh);
  });

  it('throws when the newest archive is older than the limit, or there is none', () => {
    expect(() => assertFresh({ ...base, archiveAgeDays: 41.2, stale: true }, 40)).toThrow(
      /41\.2 days old; limit 40 days/,
    );
    expect(() => assertFresh({ ...base, archiveAgeDays: null, stale: true }, 40)).toThrow(
      ArchiveStaleError,
    );
  });
});
