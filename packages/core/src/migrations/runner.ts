import { createHash } from 'node:crypto';
import pg from 'pg';
import { describeError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import { runProofs, summarizeProofs, type ProofResult } from '../proofs.js';
import { MIGRATION_SOURCES } from './bundle.js';
import { scramSha256Verifier } from './scram.js';

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

/** CRLF is normalised so a Windows checkout without .gitattributes does not read as drift. */
function normalize(sql: string): string {
  return sql.replace(/\r\n/g, '\n');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function toMigrations(sources: readonly { file: string; sql: string }[]): Migration[] {
  const migrations = sources.map(({ file, sql }) => {
    const m = /^(\d{4}_[a-z0-9_]+)\.sql$/.exec(file);
    if (!m?.[1]) throw new Error(`migration file name ${file} must look like 0001_name.sql`);
    const text = normalize(sql);
    return { version: m[1], sql: text, checksum: sha256Hex(text) };
  });
  const versions = migrations.map((m) => m.version);
  const sorted = [...versions].sort();
  if (versions.some((v, i) => v !== sorted[i]) || new Set(versions).size !== versions.length) {
    throw new Error('migrations must be unique and listed in filename order');
  }
  return migrations;
}

export const MIGRATIONS: readonly Migration[] = toMigrations(MIGRATION_SOURCES);

/** The custom resource property: any SQL change produces a new value and therefore an Update. */
export function migrationsChecksum(migrations: readonly Migration[] = MIGRATIONS): string {
  return sha256Hex(migrations.map((m) => m.sql).join(''));
}

export class MigrationDriftError extends Error {
  override readonly name = 'MigrationDriftError';
}

export class ProofFailedError extends Error {
  override readonly name = 'ProofFailedError';
  constructor(readonly results: readonly ProofResult[]) {
    const failed = results.filter((r) => r.outcome !== 'pass');
    super(`immutability proofs failed: ${failed.map((r) => `${r.name}=${r.outcome}`).join(', ')}`);
  }
}

export interface AppliedRecord {
  version: string;
  checksum: string;
}

/**
 * Applied migrations are immutable history. A changed checksum means someone edited a migration that
 * already ran somewhere; re-running it would make environments diverge silently, so it is an error -
 * the fix is a new migration.
 */
export function planMigrations(
  all: readonly Migration[],
  applied: readonly AppliedRecord[],
): Migration[] {
  const known = new Map(all.map((m) => [m.version, m]));
  for (const record of applied) {
    const migration = known.get(record.version);
    if (!migration) {
      throw new MigrationDriftError(
        `database has migration ${record.version} which this build does not know (older build?)`,
      );
    }
    if (migration.checksum !== record.checksum) {
      throw new MigrationDriftError(
        `migration ${record.version} changed after it was applied (checksum ${record.checksum.slice(0, 12)} -> ${migration.checksum.slice(0, 12)})`,
      );
    }
  }
  const done = new Set(applied.map((r) => r.version));
  return all.filter((m) => !done.has(m.version));
}

export interface RolePassword {
  role: 'audit_writer' | 'audit_reader';
  password: string;
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  rolePasswords?: readonly RolePassword[];
  /** Skip only in tests that need to inspect a schema the proofs would reject. */
  runProofs?: boolean;
  logger?: Logger;
}

export interface MigrateResult {
  applied: string[];
  proofs: ProofResult[];
}

/**
 * One transaction: pending migrations, role passwords and the immutability proofs either all land or
 * none do. A failed proof therefore rolls the schema change back instead of leaving a half-proven
 * deployment behind.
 */
export async function migrate(
  client: pg.ClientBase,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const logger = options.logger ?? silentLogger;
  const migrations = options.migrations ?? MIGRATIONS;
  const onNotice = (notice: { severity?: string; message?: string }) => {
    logger.warn('migration notice', {
      severity: notice.severity,
      message:
        notice.message === undefined ? undefined : describeError(new Error(notice.message)).message,
    });
  };
  client.on('notice', onNotice);

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    // Two deploys racing (or a manual run during a deploy) must serialise, not interleave.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_schema_migrations'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows: applied } = await client.query<AppliedRecord>(
      'SELECT version, checksum FROM audit_schema_migrations ORDER BY version',
    );
    const pending = planMigrations(migrations, applied);

    for (const migration of pending) {
      logger.info('applying migration', { version: migration.version });
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO audit_schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
    }

    for (const { role, password } of options.rolePasswords ?? []) {
      // DDL takes no bind parameters, hence a quoted literal. It carries a SCRAM verifier, never the
      // password, and the statement text is never logged.
      await client.query(
        `ALTER ROLE ${pg.escapeIdentifier(role)} WITH LOGIN PASSWORD ${pg.escapeLiteral(scramSha256Verifier(password))}`,
      );
      logger.info('role password set', { role });
    }

    const proofs = options.runProofs === false ? [] : await runProofs(client);
    const { passed, total } = summarizeProofs(proofs);
    if (passed !== total) throw new ProofFailedError(proofs);

    await client.query('COMMIT');
    logger.info('migrations complete', {
      applied: pending.length,
      proofs: `${String(passed)}/${String(total)}`,
    });
    return { applied: pending.map((m) => m.version), proofs };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.off('notice', onNotice);
  }
}
