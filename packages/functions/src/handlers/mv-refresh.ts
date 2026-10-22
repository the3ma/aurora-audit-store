import type { DbAccess, Logger } from '@audit/core';
import { functionLogger, sharedDatabase } from '../runtime.js';

const logger = functionLogger('mv-refresh');

export async function refreshViews(db: DbAccess, log: Logger = logger): Promise<{ ms: number }> {
  const started = performance.now();
  // refresh_audit_views() is SECURITY DEFINER: the reader role may run it without owning the views.
  await db.withClient('reader', (client) => client.query('SELECT refresh_audit_views()'));
  const ms = Math.round(performance.now() - started);
  log.info('materialized views refreshed', { ms });
  return { ms };
}

export async function handler(): Promise<{ ms: number }> {
  return refreshViews(sharedDatabase('mv-refresh', logger, 300_000));
}
