import { App } from 'aws-cdk-lib';
import { ConfigError, loadDrVaultConfig, loadStageConfig } from '../lib/config';

const load = (context: Record<string, unknown>) => loadStageConfig(new App({ context }).node);

describe('stage config', () => {
  test('dev defaults', () => {
    expect(load({})).toMatchObject({
      stage: 'dev',
      prefix: 'audit-dev',
      vpc: { mode: 'create', natGateways: 0 },
      minAcu: 0.5,
      maxAcu: 4,
      enableReader: false,
      backupRetentionYears: 7,
      vaultLockMode: 'none',
      retainData: false,
      skipBundling: false,
      legacyTableName: 'audit-dev-audit-legacy',
    });
  });

  test('prod defaults retain data and lock the vault', () => {
    expect(load({ stage: 'prod' })).toMatchObject({ retainData: true, vaultLockMode: 'governance', enableReader: true, evidenceRetentionDays: 2557 });
  });

  test('string context from -c is parsed and typed', () => {
    const c = load({ stage: 'prod', minAcu: '1', maxAcu: '8', enableReader: 'false', corsOrigins: 'https://a.example.test, https://b.example.test', vaultLockMode: 'compliance' });
    expect(c).toMatchObject({ minAcu: 1, maxAcu: 8, enableReader: false, corsOrigins: ['https://a.example.test', 'https://b.example.test'], vaultLockMode: 'compliance' });
  });

  test('imported VPC', () => {
    expect(load({ vpcId: 'vpc-0123456789abcdef0', appSubnetGroupName: 'app' }).vpc).toEqual({ mode: 'import', vpcId: 'vpc-0123456789abcdef0', appSubnetGroupName: 'app', createEndpoints: false });
  });

  test.each([
    [{ stage: 'staging' }, /stage must be dev\|prod/],
    [{ vaultLockMode: 'compliance' }, /only allowed for stage=prod/],
    [{ vaultLockMode: 'strict' }, /vaultLockMode must be one of/],
    [{ minAcu: '8', maxAcu: '4' }, /must be <= maxAcu/],
    [{ maxAcu: '1.3' }, /multiples of 0.5/],
    [{ backupRetentionYears: '0' }, /backupRetentionYears/],
    [{ jwtIssuer: 'https://auth.example.test/' }, /jwtAudience is required/],
    [{ jwtIssuer: 'http://auth.example.test/', jwtAudience: 'a' }, /https/],
    [{ corsOrigins: '*' }, /corsOrigins entry/],
    [{ alarmEmail: 'nope' }, /alarmEmail/],
    [{ drRegion: 'mars' }, /drRegion/],
    [{ vpcId: 'my-vpc' }, /vpcId/],
    [{ prefix: 'Bad_Prefix' }, /prefix/],
    [{ logRetentionDays: '42' }, /logRetentionDays/],
    [{ enableReader: 'yes' }, /true\|false/],
  ])('rejects %j', (context, message) => {
    expect(() => load(context)).toThrow(ConfigError);
    expect(() => load(context)).toThrow(message);
  });

  test('DR vault config', () => {
    expect(loadDrVaultConfig(new App().node)).toEqual({ drVaultName: 'audit-store-dr', vaultLockMode: 'governance' });
  });
});
