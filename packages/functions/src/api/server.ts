import { serve } from '@hono/node-server';
import { closeDatabases, functionLogger, intEnv, sharedDatabase, stringEnv } from '../runtime.js';
import { createApp } from './app.js';
import { parseAuthMode } from './auth.js';

const logger = functionLogger('api');
const port = intEnv('PORT', 3000);

const app = createApp({
  db: sharedDatabase('api', logger),
  authMode: parseAuthMode(stringEnv('AUTH_MODE', 'header')),
  corsOrigins: stringEnv('CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
  logger,
});

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  logger.info('api listening', { port: info.port });
});

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  server.close(() => {
    void closeDatabases().finally(() => process.exit(0));
  });
};
process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  shutdown('SIGINT');
});
