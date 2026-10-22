import { cloudWatchMetrics } from '../adapters/cloudwatch.js';
import { s3ObjectStore } from '../adapters/s3.js';
import { runDigest, type DigestResult } from '../digest/run.js';
import { functionLogger, intEnv, requireEnv, sharedDatabase, stringEnv } from '../runtime.js';

const logger = functionLogger('digest');

export async function handler(): Promise<Omit<DigestResult, 'sealed'> & { sealed: number }> {
  const result = await runDigest({
    db: sharedDatabase('digest', logger, 600_000),
    store: s3ObjectStore(),
    metrics: cloudWatchMetrics(),
    bucket: requireEnv('EVIDENCE_BUCKET'),
    prefix: stringEnv('DIGEST_PREFIX', 'audit-digest/'),
    reverifyDays: intEnv('DIGEST_REVERIFY_DAYS', 7),
    logger,
  });
  // A mismatch is alarmed on via the metric; failing the invocation as well makes it visible in the
  // function's error rate and in the scheduler's failed-invocation count.
  if (result.mismatches.length > 0) {
    throw new Error(`digest mismatch in ${String(result.mismatches.length)} block(s)`);
  }
  return { ...result, sealed: result.sealed.length };
}
