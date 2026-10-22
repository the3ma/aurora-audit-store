import {
  ConfigError,
  createLogger,
  databaseFromEnv,
  type Database,
  type Logger,
} from '@audit/core';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new ConfigError(`${name} is required`);
  return value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer`);
  }
  return value;
}

export function stringEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function functionLogger(fn: string): Logger {
  return createLogger({ base: { fn } });
}

const databases = new Map<string, Database>();

/**
 * One Database per execution environment, created on first use so a cold start that never touches the
 * database (e.g. a 404) never fetches a secret. Pools survive across invocations.
 */
export function sharedDatabase(fn: string, logger: Logger, statementTimeoutMs?: number): Database {
  let db = databases.get(fn);
  if (!db) {
    db = databaseFromEnv({
      logger,
      applicationName: `audit-${fn}`,
      poolMax: process.env['AWS_LAMBDA_FUNCTION_NAME'] ? 2 : 10,
      statementTimeoutMs,
    });
    databases.set(fn, db);
  }
  return db;
}

export async function closeDatabases(): Promise<void> {
  const all = [...databases.values()];
  databases.clear();
  await Promise.all(all.map((db) => db.end()));
}
