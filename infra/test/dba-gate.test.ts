import { readMigrations } from '../lib/migrations';
import { destructiveStatements } from './support/dba-gate';

describe('DBA gate: db/migrations/*.sql', () => {
  const migrations = readMigrations();

  test('migrations exist', () => {
    expect(migrations.length).toBeGreaterThan(0);
    for (const m of migrations) expect(m.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  test.each(migrations.map((m) => [m.name, m.sql] as const))('%s has no destructive statement', (_name, sql) => {
    expect(destructiveStatements(sql)).toEqual([]);
  });
});

describe('DBA gate rules', () => {
  test.each([
    ['DROP TABLE audit_event', 'DROP TABLE'],
    ['drop table if exists foo', 'DROP TABLE'],
    ['ALTER TABLE audit_event DROP COLUMN comment', 'DROP COLUMN'],
    ['ALTER TABLE audit_event DROP comment', 'ALTER TABLE ... DROP <column>'],
    ['DROP TYPE audit_scope', 'DROP TYPE'],
    ['ALTER TYPE audit_scope RENAME VALUE \'orders\' TO \'sales\'', 'ALTER TYPE ... RENAME'],
    ['ALTER TYPE audit_scope RENAME TO scope_v2', 'ALTER TYPE ... RENAME'],
    ['TRUNCATE audit_event', 'TRUNCATE'],
    ['DELETE FROM audit_event WHERE true', 'DELETE FROM audit_event'],
    ['delete from public.audit_event', 'DELETE FROM audit_event'],
    ['ALTER TABLE audit_event DISABLE TRIGGER audit_event_no_update', 'DISABLE TRIGGER'],
    ['CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN TRUNCATE audit_event; END $$', 'TRUNCATE'],
  ])('flags: %s', (sql, rule) => {
    expect(destructiveStatements(sql).map((v) => v.rule)).toContain(rule);
  });

  test.each([
    '-- never DROP TABLE audit_event here',
    '/* TRUNCATE audit_event; /* nested */ DELETE FROM audit_event */ SELECT 1',
    "DO $$ BEGIN RAISE EXCEPTION 'TRUNCATE is not allowed: DROP TABLE'; END $$",
    'CREATE TRIGGER t BEFORE TRUNCATE ON audit_event FOR EACH STATEMENT EXECUTE FUNCTION audit_event_deny_mutation()',
    'CREATE TRIGGER t BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION audit_event_deny_mutation()',
    'REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM PUBLIC',
    'ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS old_check',
    'ALTER TABLE audit_event ALTER COLUMN comment DROP NOT NULL',
    'DROP TRIGGER IF EXISTS t ON audit_event',
    'DROP MATERIALIZED VIEW IF EXISTS mv_audit_facets',
    'DELETE FROM audit_schema_migrations_tmp',
  ])('allows: %s', (sql) => {
    expect(destructiveStatements(sql)).toEqual([]);
  });
});
