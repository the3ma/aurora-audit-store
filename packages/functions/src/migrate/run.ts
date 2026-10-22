import {
  ConfigError,
  migrate,
  ROLE_NAMES,
  summarizeProofs,
  type Database,
  type Logger,
  type MigrateResult,
  type RolePassword,
} from '@audit/core';

/**
 * Passwords for the login roles come from the same place the functions read them (their secret, or
 * DATABASE_URL_* locally), so the database and the consumers can never disagree. A role with nothing
 * configured keeps no password and therefore cannot log in.
 */
export async function rolePasswords(db: Database, logger: Logger): Promise<RolePassword[]> {
  const out: RolePassword[] = [];
  for (const role of ['writer', 'reader'] as const) {
    const name = ROLE_NAMES[role];
    if (!db.hasRole(role)) {
      logger.warn('no credentials configured; role keeps no password', { role: name });
      continue;
    }
    const { credentials } = await db.credentials(role);
    if (credentials.user !== name) {
      throw new ConfigError(
        `credentials for ${role} are for user ${credentials.user}, expected ${name}`,
      );
    }
    out.push({ role: name, password: credentials.password });
  }
  return out;
}

export interface MigrateSummary extends MigrateResult {
  Applied: string;
  Proofs: string;
}

export async function runMigrate(db: Database, logger: Logger): Promise<MigrateSummary> {
  const passwords = await rolePasswords(db, logger);
  const result = await db.withClient('owner', (client) =>
    migrate(client, { rolePasswords: passwords, logger }),
  );
  const { passed, total } = summarizeProofs(result.proofs);
  return {
    ...result,
    Applied: String(result.applied.length),
    Proofs: `${String(passed)}/${String(total)}`,
  };
}
