import { describeError } from '@audit/core';
import { refreshViews } from '../handlers/mv-refresh.js';
import { closeDatabases, functionLogger, sharedDatabase } from '../runtime.js';

const logger = functionLogger('mv-refresh');

try {
  await refreshViews(sharedDatabase('mv-refresh', logger, 300_000), logger);
} catch (error) {
  logger.error('mv-refresh failed', { error: describeError(error) });
  process.exitCode = 1;
} finally {
  await closeDatabases();
}
