import { describeError } from '@audit/core';
import { handler } from '../handlers/digest.js';
import { closeDatabases, functionLogger } from '../runtime.js';

const logger = functionLogger('digest');

try {
  const result = await handler();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  logger.error('digest failed', { error: describeError(error) });
  process.exitCode = 1;
} finally {
  await closeDatabases();
}
