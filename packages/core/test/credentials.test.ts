import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  envCredentialProvider,
  parseDatabaseUrl,
  parseRdsSecret,
  parseSslMode,
  scramSha256Verifier,
  tlsOptions,
} from '../src/index.js';

const secret = JSON.stringify({
  engine: 'postgres',
  host: 'audit.cluster-abc.us-east-1.rds.example.test',
  port: 5432,
  dbname: 'audit',
  username: 'audit_reader',
  password: 'Zx9-unit-test-only',
});

describe('credentials', () => {
  it('parses an RDS rotation secret', () => {
    expect(parseRdsSecret(secret)).toEqual({
      host: 'audit.cluster-abc.us-east-1.rds.example.test',
      port: 5432,
      database: 'audit',
      user: 'audit_reader',
      password: 'Zx9-unit-test-only',
    });
  });

  it('rejects a secret with a string port without echoing the secret', () => {
    const bad = JSON.stringify({ ...JSON.parse(secret), port: '5432' });
    expect(() => parseRdsSecret(bad)).toThrow(ConfigError);
    expect(() => parseRdsSecret(bad)).toThrow(/port/);
    expect(() => parseRdsSecret(bad)).not.toThrow(/Zx9/);
  });

  it('parses a postgres URL with an encoded password', () => {
    expect(parseDatabaseUrl('postgresql://audit_writer:p%40ss@db:5433/audit')).toEqual({
      host: 'db',
      port: 5433,
      database: 'audit',
      user: 'audit_writer',
      password: 'p@ss',
    });
    expect(() => parseDatabaseUrl('mysql://u:p@h/d')).toThrow(ConfigError);
  });

  it('prefers DATABASE_URL_<ROLE> over the secret ARN', async () => {
    const fetch = vi.fn<(id: string) => Promise<string>>();
    const provider = envCredentialProvider(
      {
        DATABASE_URL_READER: 'postgresql://audit_reader:reader@db:5432/audit',
        DB_READER_SECRET_ARN: 'arn',
      },
      fetch,
    );
    const resolved = await provider.resolve('reader');
    expect(resolved.rotating).toBe(false);
    expect(resolved.credentials.user).toBe('audit_reader');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('caches the secret until invalidated, and does not cache a failed fetch', async () => {
    const fetch = vi
      .fn<(id: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValue(secret);
    const provider = envCredentialProvider({ DB_READER_SECRET_ARN: 'arn:reader' }, fetch);

    await expect(provider.resolve('reader')).rejects.toThrow('throttled');
    await provider.resolve('reader');
    await provider.resolve('reader');
    expect(fetch).toHaveBeenCalledTimes(2);

    provider.invalidate('reader');
    expect((await provider.resolve('reader')).rotating).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledWith('arn:reader');
  });

  it('fails clearly when nothing is configured', async () => {
    const provider = envCredentialProvider({}, vi.fn());
    expect(provider.has('owner')).toBe(false);
    await expect(provider.resolve('owner')).rejects.toThrow(
      /DATABASE_URL_OWNER or DB_OWNER_SECRET_ARN/,
    );
  });
});

describe('tls', () => {
  it('defaults to verify-full against the committed RDS CA bundle', () => {
    expect(parseSslMode(undefined)).toBe('verify-full');
    const options = tlsOptions('verify-full', 'db.example.test');
    expect(options).toMatchObject({ rejectUnauthorized: true, servername: 'db.example.test' });
    expect(options && String(options.ca)).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('allows disable only explicitly and rejects anything else', () => {
    expect(tlsOptions(parseSslMode('disable'), 'db')).toBe(false);
    expect(() => parseSslMode('require')).toThrow(ConfigError);
  });
});

describe('scramSha256Verifier', () => {
  it('produces the pg_authid format and never contains the password', () => {
    const verifier = scramSha256Verifier('pencil', Buffer.alloc(16, 1));
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
    );
    expect(verifier).not.toContain('pencil');
    expect(scramSha256Verifier('pencil', Buffer.alloc(16, 1))).toBe(verifier);
    expect(scramSha256Verifier('pencil')).not.toBe(verifier);
  });
});
