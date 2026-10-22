import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Migrations in apply order (filename order), line endings normalised to LF. */
export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n') }));
}

/**
 * sha256 of all migrations concatenated in order. CRLF is normalised so a Windows checkout with
 * autocrlf does not trigger a spurious custom-resource Update.
 */
export function migrationsChecksum(dir: string = MIGRATIONS_DIR): string {
  const files = readMigrations(dir);
  if (files.length === 0) throw new Error(`no *.sql migrations found in ${dir}`);
  const hash = createHash('sha256');
  for (const f of files) hash.update(f.sql, 'utf8');
  return hash.digest('hex');
}
