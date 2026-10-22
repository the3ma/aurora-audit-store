import { Readable } from 'node:stream';
import {
  ObjectExistsError,
  ObjectNotFoundError,
  type Metric,
  type MetricsSink,
  type ObjectStore,
} from '../ports.js';

/** In-memory ObjectStore with the same write-once semantics as the S3 adapter. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  private static id(bucket: string, key: string) {
    return `${bucket}/${key}`;
  }

  put(bucket: string, key: string, body: string | Uint8Array): void {
    this.objects.set(MemoryObjectStore.id(bucket, key), Buffer.from(body));
  }

  read(bucket: string, key: string): Buffer {
    const body = this.objects.get(MemoryObjectStore.id(bucket, key));
    if (!body) throw new ObjectNotFoundError(key);
    return body;
  }

  getStream(bucket: string, key: string): Promise<Readable> {
    return Promise.resolve().then(() => Readable.from([this.read(bucket, key)]));
  }

  getText(bucket: string, key: string): Promise<string> {
    return Promise.resolve().then(() => this.read(bucket, key).toString('utf8'));
  }

  putIfAbsent(bucket: string, key: string, body: string | Uint8Array): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.objects.has(MemoryObjectStore.id(bucket, key))) throw new ObjectExistsError(key);
      this.put(bucket, key, body);
    });
  }

  async *listKeys(bucket: string, prefix: string): AsyncIterable<string> {
    const start = `${bucket}/${prefix}`;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(start)).sort();
    for (const k of keys) {
      await Promise.resolve();
      yield k.slice(bucket.length + 1);
    }
  }
}

export class MemoryMetrics implements MetricsSink {
  readonly published: Metric[] = [];

  publish(metrics: readonly Metric[]): Promise<void> {
    this.published.push(...metrics);
    return Promise.resolve();
  }

  last(name: string): number | undefined {
    return this.published.findLast((m) => m.name === name)?.value;
  }
}
