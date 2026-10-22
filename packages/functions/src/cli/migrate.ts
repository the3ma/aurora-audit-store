import { describeError, ProofFailedError } from '@audit/core';
import { runMigrate } from '../migrate/run.js';
import { closeDatabases, functionLogger, sharedDatabase } from '../runtime.js';

const logger = functionLogger('migrate');

try {
  const result = await runMigrate(sharedDatabase('migrate', logger, 120_000), logger);
  for (const proof of result.proofs) logger.info('proof', { ...proof });
  logger.info('migrate finished', { applied: result.applied, proofs: result.Proofs });
} catch (error) {
  if (error instanceof ProofFailedError) {
    for (const proof of error.results) logger.error('proof', { ...proof });
  }
  logger.error('migrate failed', { error: describeError(error) });
  process.exitCode = 1;
} finally {
  await closeDatabases();
}
