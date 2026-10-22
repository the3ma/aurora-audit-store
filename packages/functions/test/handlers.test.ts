import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAlert } from '../src/handlers/master-secret-alert.js';
import { handler as migrate, PHYSICAL_RESOURCE_ID } from '../src/handlers/migrate.js';

describe('migrate custom resource', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Delete is a no-op that keeps the physical id (data is never dropped)', async () => {
    await expect(
      migrate({ RequestType: 'Delete', PhysicalResourceId: PHYSICAL_RESOURCE_ID }),
    ).resolves.toEqual({
      PhysicalResourceId: 'audit-schema',
    });
  });

  it('fails Create with a scrubbed, actionable message when no owner credentials exist', async () => {
    vi.stubEnv('DATABASE_URL_OWNER', '');
    vi.stubEnv('DB_OWNER_SECRET_ARN', '');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      migrate({ RequestType: 'Create', ResourceProperties: { MigrationsChecksum: 'abc' } }),
    ).rejects.toThrow(/no credentials for role owner/);
    vi.restoreAllMocks();
  });
});

describe('master secret alert', () => {
  it('formats a CloudTrail-sourced event for humans', () => {
    const { subject, message } = formatAlert({
      'detail-type': 'AWS API Call via CloudTrail',
      region: 'us-east-1',
      detail: {
        eventName: 'GetSecretValue',
        eventTime: '2026-10-01T12:00:00Z',
        sourceIPAddress: '198.51.100.7',
        userIdentity: { arn: 'arn:aws:sts::000000000000:assumed-role/operator/someone' },
        requestParameters: { secretId: 'audit/db/owner' },
      },
    });
    expect(subject).toBe('[audit-store] owner secret GetSecretValue');
    expect(message).toContain('198.51.100.7');
    expect(message).toContain('audit/db/owner');
  });

  it('degrades gracefully on a sparse event', () => {
    expect(formatAlert({}).message).toContain('unknown');
  });
});
