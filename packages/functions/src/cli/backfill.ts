import { describeError } from '@audit/core';
import { parseArgs } from 'node:util';
import { handler } from '../handlers/backfill.js';
import { closeDatabases, functionLogger } from '../runtime.js';

const logger = functionLogger('backfill');

const { values } = parseArgs({
  options: {
    'export-prefix': { type: 'string' },
    'run-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});

const exportPrefix = values['export-prefix'];
if (exportPrefix === undefined) {
  process.stderr.write(
    'usage: npm run backfill -- --export-prefix <prefix> [--run-id <id>] [--dry-run]\n',
  );
  process.exit(2);
}

try {
  const manifest = await handler({
    exportPrefix,
    runId: values['run-id'],
    dryRun: values['dry-run'],
  });
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
} catch (error) {
  logger.error('backfill failed', { error: describeError(error) });
  process.exitCode = 1;
} finally {
  await closeDatabases();
}
