import { handle } from '@hono/aws-lambda';
import { createApp } from '../api/app.js';
import { parseAuthMode } from '../api/auth.js';
import { functionLogger, sharedDatabase, stringEnv } from '../runtime.js';

const logger = functionLogger('api');

const app = createApp({
  db: sharedDatabase('api', logger),
  authMode: parseAuthMode(stringEnv('AUTH_MODE', 'jwt')),
  corsOrigins: stringEnv('CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
  logger,
});

export const handler = handle(app);
