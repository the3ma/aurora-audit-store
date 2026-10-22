import { afterEach, describe, expect, it, vi } from 'vitest';
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
