import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  MigrationDriftError,
  migrationsChecksum,
  planMigrations,
  sha256Hex,
  toMigrations,
} from '../src/index.js';

const dir = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations');

describe('migration bundle', () => {
  it('contains exactly the files in db/migrations, in filename order', async () => {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    expect(MIGRATIONS.map((m) => `${m.version}.sql`)).toEqual(files);
    for (const m of MIGRATIONS) {
      const onDisk = (await readFile(join(dir, `${m.version}.sql`), 'utf8')).replace(/\r\n/g, '\n');
      expect(m.sql).toBe(onDisk);
    }
  });

  it('checksums each file and the whole set (the custom resource property)', () => {
    for (const m of MIGRATIONS) expect(m.checksum).toBe(sha256Hex(m.sql));
    expect(migrationsChecksum()).toBe(sha256Hex(MIGRATIONS.map((m) => m.sql).join('')));
  });

  it('does not treat a CRLF checkout as a different migration', () => {
    const [lf] = toMigrations([{ file: '0001_x.sql', sql: 'SELECT 1;\nSELECT 2;\n' }]);
    const [crlf] = toMigrations([{ file: '0001_x.sql', sql: 'SELECT 1;\r\nSELECT 2;\r\n' }]);
    expect(crlf?.checksum).toBe(lf?.checksum);
  });

  it('rejects badly named or out-of-order files', () => {
    expect(() => toMigrations([{ file: 'schema.sql', sql: '' }])).toThrow(/0001_name/);
    expect(() =>
      toMigrations([
        { file: '0002_b.sql', sql: '' },
        { file: '0001_a.sql', sql: '' },
      ]),
    ).toThrow(/order/);
  });
});

describe('planMigrations', () => {
  const all = toMigrations([
    { file: '0001_a.sql', sql: 'SELECT 1;' },
    { file: '0002_b.sql', sql: 'SELECT 2;' },
    { file: '0003_c.sql', sql: 'SELECT 3;' },
  ]);
  const record = (i: number) => ({
    version: all[i]?.version ?? '',
    checksum: all[i]?.checksum ?? '',
  });

  it('returns everything on an empty database', () => {
    expect(planMigrations(all, []).map((m) => m.version)).toEqual(['0001_a', '0002_b', '0003_c']);
  });

  it('returns only what is pending', () => {
    expect(planMigrations(all, [record(0), record(1)]).map((m) => m.version)).toEqual(['0003_c']);
  });

  it('is a no-op when everything is applied', () => {
    expect(planMigrations(all, [record(0), record(1), record(2)])).toEqual([]);
  });

  it('detects an applied migration whose file changed (drift)', () => {
    const edited = [{ version: '0002_b', checksum: sha256Hex('SELECT 2; -- edited later') }];
    expect(() => planMigrations(all, [record(0), ...edited])).toThrow(MigrationDriftError);
    expect(() => planMigrations(all, [record(0), ...edited])).toThrow(
      /0002_b changed after it was applied/,
    );
  });

  it('refuses to run against a database that is ahead of the build', () => {
    expect(() => planMigrations(all, [{ version: '0009_future', checksum: 'x' }])).toThrow(
      /does not know/,
    );
  });
});
