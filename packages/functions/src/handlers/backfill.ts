import { s3ObjectStore } from '../adapters/s3.js';
import { runBackfill, type BackfillInput, type BackfillManifest } from '../backfill/run.js';
import { functionLogger, requireEnv, sharedDatabase, stringEnv } from '../runtime.js';

const logger = functionLogger('backfill');

export async function handler(event: BackfillInput): Promise<BackfillManifest> {
  return runBackfill(event, {
    db: sharedDatabase('backfill', logger),
    store: s3ObjectStore(),
    legacyExportBucket: requireEnv('LEGACY_EXPORT_BUCKET'),
    evidenceBucket: requireEnv('EVIDENCE_BUCKET'),
    manifestPrefix: stringEnv('MANIFEST_PREFIX', 'backfill/'),
    logger,
  });
}
