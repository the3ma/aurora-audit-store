import m0001 from '../../../../db/migrations/0001_schema.sql';
import m0002 from '../../../../db/migrations/0002_roles_grants.sql';
import m0003 from '../../../../db/migrations/0003_append_only.sql';
import m0004 from '../../../../db/migrations/0004_views.sql';

/**
 * Explicit list rather than a directory scan: the Lambda bundle has no filesystem to scan. A unit test
 * fails if a file in db/migrations is missing here.
 */
export const MIGRATION_SOURCES: readonly { file: string; sql: string }[] = [
  { file: '0001_schema.sql', sql: m0001 },
  { file: '0002_roles_grants.sql', sql: m0002 },
  { file: '0003_append_only.sql', sql: m0003 },
  { file: '0004_views.sql', sql: m0004 },
];
