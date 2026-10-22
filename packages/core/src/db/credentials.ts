import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { ConfigError } from '../errors.js';

export const DB_ROLES = ['owner', 'writer', 'reader'] as const;
export type DbRole = (typeof DB_ROLES)[number];

export const ROLE_NAMES = {
  owner: 'audit_owner',
  writer: 'audit_writer',
  reader: 'audit_reader',
} as const satisfies Record<DbRole, string>;

export interface DbCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface ResolvedCredentials {
  credentials: DbCredentials;
  /** Secrets rotate; a URL from the environment does not, so only secrets are worth refetching. */
  rotating: boolean;
}

export interface CredentialProvider {
  resolve(role: DbRole): Promise<ResolvedCredentials>;
  invalidate(role: DbRole): void;
  /** Whether anything is configured for the role, without fetching it. */
  has(role: DbRole): boolean;
}

/** RDS-managed rotation format. */
const rdsSecretSchema = z.object({
  engine: z.literal('postgres').optional(),
  host: z.string().min(1),
  port: z.number().int().positive(),
  dbname: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

export function parseRdsSecret(secretString: string): DbCredentials {
  let json: unknown;
  try {
    json = JSON.parse(secretString);
  } catch {
    throw new ConfigError('database secret is not JSON');
  }
  const result = rdsSecretSchema.safeParse(json);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`database secret is missing or has invalid fields: ${fields}`);
  }
  const s = result.data;
  return { host: s.host, port: s.port, database: s.dbname, user: s.username, password: s.password };
}

export function parseDatabaseUrl(value: string): DbCredentials {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('database URL is not a valid URL');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new ConfigError('database URL must use the postgresql:// scheme');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !url.username || !database) {
    throw new ConfigError('database URL must include user, host and database');
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export type SecretFetcher = (secretId: string) => Promise<string>;

export function secretsManagerFetcher(client = new SecretsManagerClient({})): SecretFetcher {
  return async (secretId) => {
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (out.SecretString === undefined) throw new ConfigError(`secret has no SecretString`);
    return out.SecretString;
  };
}

type Env = Readonly<Record<string, string | undefined>>;

const urlVar = (role: DbRole) => `DATABASE_URL_${role.toUpperCase()}`;
const secretVar = (role: DbRole) => `DB_${role.toUpperCase()}_SECRET_ARN`;

/**
 * `DATABASE_URL_<ROLE>` wins (local), else `DB_<ROLE>_SECRET_ARN` (AWS). Secrets are fetched on first
 * use and cached for the life of the execution environment; `invalidate` drops the cache after an
 * authentication failure so a rotated password is picked up without a cold start.
 */
export function envCredentialProvider(
  env: Env = process.env,
  fetchSecret: SecretFetcher = secretsManagerFetcher(),
): CredentialProvider {
  const cache = new Map<DbRole, Promise<ResolvedCredentials>>();

  const load = async (role: DbRole): Promise<ResolvedCredentials> => {
    const url = env[urlVar(role)];
    if (url) return { credentials: parseDatabaseUrl(url), rotating: false };
    const arn = env[secretVar(role)];
    if (arn) return { credentials: parseRdsSecret(await fetchSecret(arn)), rotating: true };
    throw new ConfigError(
      `no credentials for role ${role}: set ${urlVar(role)} or ${secretVar(role)}`,
    );
  };

  return {
    has: (role) => Boolean(env[urlVar(role)] ?? env[secretVar(role)]),
    resolve: (role) => {
      let pending = cache.get(role);
      if (!pending) {
        pending = load(role);
        // A failed fetch must not be cached, or one throttled call poisons the container.
        pending.catch(() => cache.delete(role));
        cache.set(role, pending);
      }
      return pending;
    },
    invalidate: (role) => {
      cache.delete(role);
    },
  };
}
