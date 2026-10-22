import type { Readable } from 'node:stream';

/** The slice of S3 the jobs use. Tests swap in an in-memory implementation. */
export interface ObjectStore {
  getStream(bucket: string, key: string): Promise<Readable>;
  getText(bucket: string, key: string): Promise<string>;
  /** Evidence is write-once: throws ObjectExistsError instead of overwriting. */
  putIfAbsent(
    bucket: string,
    key: string,
    body: string | Uint8Array,
    contentType: string,
  ): Promise<void>;
  listKeys(bucket: string, prefix: string): AsyncIterable<string>;
}

export class ObjectExistsError extends Error {
  override readonly name = 'ObjectExistsError';
  constructor(readonly key: string) {
    super(`object already exists: ${key}`);
  }
}

export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
  constructor(readonly key: string) {
    super(`object not found: ${key}`);
  }
}

export type MetricUnit = 'Count' | 'None' | 'Seconds';

export interface Metric {
  name: string;
  value: number;
  unit: MetricUnit;
}

export interface MetricsSink {
  publish(metrics: readonly Metric[]): Promise<void>;
}

export const METRIC_NAMESPACE = 'AuditStore';
