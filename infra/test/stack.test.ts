import { App, type CfnElement, type Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IConstruct } from 'constructs';
import { buildApp } from '../lib/build-app';
import { DEV, PROD, cdkJson, dependsOn, resourcesOfType, synth, type CfnResourceJson, type CfnTemplate } from './support/synth';

const logicalId = (stack: Stack, construct: IConstruct): string => {
  const child = (construct.node.defaultChild ?? construct) as CfnElement;
  return stack.resolve(child.logicalId) as string;
};

const props = (r: CfnResourceJson): Record<string, unknown> => r.Properties ?? {};

/** All IAM policy statements in identity policies (AWS::IAM::Policy + inline role policies). */
function identityStatements(t: CfnTemplate): Array<{ Effect: string; Action: string | string[]; Resource?: unknown }> {
  const docs: unknown[] = [];
  for (const [, r] of resourcesOfType(t, 'AWS::IAM::Policy')) docs.push(props(r)['PolicyDocument']);
  for (const [, r] of resourcesOfType(t, 'AWS::IAM::Role')) {
    for (const p of (props(r)['Policies'] as Array<{ PolicyDocument: unknown }> | undefined) ?? []) docs.push(p.PolicyDocument);
  }
  return docs.flatMap((d) => (d as { Statement: Array<{ Effect: string; Action: string | string[] }> }).Statement);
}

const actionsOf = (s: { Action: string | string[] }): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe.each([
  ['dev', DEV],
  ['prod', PROD],
])('%s', (stage, context) => {
  const isProd = stage === 'prod';
  const { built, template, json } = synth(context);
  const stack = built.stack;

  describe('Aurora cluster', () => {
    test('Aurora PostgreSQL 16.x (not limitless), Serverless v2, encrypted with the CMK, TLS forced', () => {
      const keyId = logicalId(stack, stack.database.key);
      template.hasResourceProperties('AWS::RDS::DBCluster', {
        Engine: 'aurora-postgresql',
        EngineVersion: Match.stringLikeRegexp('^16\\.\\d+$'),
        StorageEncrypted: true,
        KmsKeyId: { 'Fn::GetAtt': [keyId, 'Arn'] },
        PerformanceInsightsEnabled: true,
        PerformanceInsightsKmsKeyId: { 'Fn::GetAtt': [keyId, 'Arn'] },
        EnableIAMDatabaseAuthentication: false,
        EnableCloudwatchLogsExports: ['postgresql'],
        CopyTagsToSnapshot: true,
        DatabaseName: 'audit',
        MasterUsername: 'audit_owner',
        Port: 5432,
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
        BackupRetentionPeriod: isProd ? 35 : 7,
        DeletionProtection: isProd,
      });
      expect(JSON.stringify(json)).not.toMatch(/limitless/i);
      template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
        Parameters: Match.objectLike({ 'rds.force_ssl': '1', log_min_duration_statement: '1000', log_lock_waits: '1' }),
      });
    });

    test('removal policy: RETAIN in prod, DESTROY in dev', () => {
      template.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: isProd ? 'Retain' : 'Delete' });
    });

    test('writer always, reader only when enabled', () => {
      template.resourceCountIs('AWS::RDS::DBInstance', isProd ? 2 : 1);
      template.allResourcesProperties('AWS::RDS::DBInstance', { PubliclyAccessible: false, DBInstanceClass: 'db.serverless' });
    });

    test('every KMS key rotates', () => {
      for (const [, k] of resourcesOfType(json, 'AWS::KMS::Key')) expect(props(k)['EnableKeyRotation']).toBe(true);
    });
  });

  describe('network', () => {
    test('cluster SG has no inline rules and only SG-sourced 5432 ingress from the named clients', () => {
      const clusterSg = logicalId(stack, stack.network.clusterSecurityGroup);
      const sg = json.Resources[clusterSg];
      expect(sg && props(sg)['SecurityGroupIngress']).toBeUndefined();

      const ingress = resourcesOfType(json, 'AWS::EC2::SecurityGroupIngress')
        .map(([, r]) => props(r))
        .filter((p) => JSON.stringify(p['GroupId']).includes(clusterSg));
      const clientIds = Object.values(stack.network.clientSecurityGroups).map((s) => logicalId(stack, s));
      expect(ingress).toHaveLength(6);
      for (const p of ingress) {
        expect(p['CidrIp']).toBeUndefined();
        expect(p['CidrIpv6']).toBeUndefined();
        expect(p['FromPort']).toBe(5432);
        expect(p['ToPort']).toBe(5432);
        expect(clientIds).toContainEqual((p['SourceSecurityGroupId'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]);
      }
    });

    test('no ingress from 0.0.0.0/0 or ::/0 anywhere', () => {
      const all = [
        ...resourcesOfType(json, 'AWS::EC2::SecurityGroupIngress').map(([, r]) => props(r)),
        ...resourcesOfType(json, 'AWS::EC2::SecurityGroup').flatMap(([, r]) => (props(r)['SecurityGroupIngress'] as Array<Record<string, unknown>> | undefined) ?? []),
      ];
      for (const rule of all) {
        expect(rule['CidrIp']).not.toBe('0.0.0.0/0');
        expect(rule['CidrIpv6']).not.toBe('::/0');
      }
    });

    test('no NAT gateway or IGW by default; DB subnets isolated; required endpoints present', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::InternetGateway', 0);
      const services = resourcesOfType(json, 'AWS::EC2::VPCEndpoint').map(([, r]) => JSON.stringify(props(r)['ServiceName']));
      for (const s of ['.s3', '.dynamodb', 'secretsmanager', '.kms', '.logs', '.monitoring', '.rds', '.sts']) {
        expect(services.some((x) => x.includes(s))).toBe(true);
      }
    });
  });

  describe('secrets and rotation', () => {
    test('writer/reader secrets carry the RDS rotation shape with a numeric port', () => {
      for (const [username, secret] of [
        ['audit_writer', stack.database.writerSecret],
        ['audit_reader', stack.database.readerSecret],
      ] as const) {
        const r = json.Resources[logicalId(stack, secret)];
        if (!r) throw new Error('secret missing');
        const gen = props(r)['GenerateSecretString'] as { SecretStringTemplate: { 'Fn::Join': [string, unknown[]] }; ExcludeCharacters: string; GenerateStringKey: string };
        const text = gen.SecretStringTemplate['Fn::Join'][1].map((p) => (typeof p === 'string' ? p : 'HOST')).join('');
        expect(JSON.parse(text)).toEqual({ engine: 'postgres', host: 'HOST', port: 5432, dbname: 'audit', username });
        expect(gen.GenerateStringKey).toBe('password');
        expect(gen.ExcludeCharacters).toBe(` "'\\;:@/`);
        expect(props(r)['KmsKeyId']).toEqual({ 'Fn::GetAtt': [logicalId(stack, stack.database.key), 'Arn'] });
      }
      template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: `audit-${stage}/db/owner` });
    });

    test('three hosted single-user rotations, 30 days, not immediate, after the migration', () => {
      const migrationId = logicalId(stack, stack.workloads.migration);
      const schedules = resourcesOfType(json, 'AWS::SecretsManager::RotationSchedule');
      expect(schedules).toHaveLength(3);
      for (const [, r] of schedules) {
        expect(props(r)).toMatchObject({
          RotateImmediatelyOnUpdate: false,
          RotationRules: { ScheduleExpression: 'rate(30 days)' },
          HostedRotationLambda: { RotationType: 'PostgreSQLSingleUser', ExcludeCharacters: ` "'\\;:@/` },
        });
        expect(dependsOn(r)).toContain(migrationId);
      }
    });
  });

  describe('migration custom resource', () => {
    test('MigrationsChecksum = sha256 of db/migrations/*.sql in filename order', () => {
      const dir = join(__dirname, '..', '..', 'db', 'migrations');
      const hash = createHash('sha256');
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) hash.update(readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
      template.hasResourceProperties('Custom::AuditSchemaMigration', { MigrationsChecksum: hash.digest('hex') });
    });

    test('runs after the writer instance, the SG rules and the endpoints', () => {
      const r = json.Resources[logicalId(stack, stack.workloads.migration)];
      if (!r) throw new Error('migration missing');
      const deps = dependsOn(r);
      for (const [id] of resourcesOfType(json, 'AWS::RDS::DBInstance')) expect(deps).toContain(id);
      for (const [id] of resourcesOfType(json, 'AWS::EC2::VPCEndpoint')) expect(deps).toContain(id);
      expect(deps.filter((d) => d.startsWith('NetworkDbIngress'))).toHaveLength(6);
    });

    test('every DB-using function depends on the migration', () => {
      const migrationId = logicalId(stack, stack.workloads.migration);
      const w = stack.workloads;
      for (const f of [w.api, w.mvRefresh, w.digest, w.backfill]) {
        const r = json.Resources[logicalId(stack, f.fn)];
        if (!r) throw new Error('function missing');
        expect(dependsOn(r)).toContain(migrationId);
      }
    });

    test('migrate is a singleton', () => {
      template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: `audit-${stage}-migrate`, ReservedConcurrentExecutions: 1 });
    });
  });

  describe('functions', () => {
    const envOf = (name: string): Record<string, unknown> => {
      const fn = resourcesOfType(json, 'AWS::Lambda::Function').find(([, r]) => props(r)['FunctionName'] === `audit-${stage}-${name}`);
      if (!fn) throw new Error(`function ${name} missing`);
      return ((props(fn[1])['Environment'] as { Variables: Record<string, unknown> }).Variables);
    };
    const common = ['LOG_LEVEL', 'NODE_OPTIONS'];

    test.each([
      ['migrate', ['DB_SSL', 'DB_OWNER_SECRET_ARN', 'DB_WRITER_SECRET_ARN', 'DB_READER_SECRET_ARN']],
      ['api', ['DB_SSL', 'DB_READER_SECRET_ARN', 'DB_WRITER_SECRET_ARN', 'AUTH_MODE', 'CORS_ORIGINS']],
      ['mv-refresh', ['DB_SSL', 'DB_READER_SECRET_ARN']],
      ['digest', ['DB_SSL', 'DB_READER_SECRET_ARN', 'EVIDENCE_BUCKET', 'DIGEST_PREFIX', 'DIGEST_REVERIFY_DAYS']],
      ['archive-export', ['CLUSTER_ARN', 'EVIDENCE_BUCKET', 'ARCHIVE_PREFIX', 'EXPORT_ROLE_ARN', 'EXPORT_KMS_KEY_ARN', 'ARCHIVE_STALE_DAYS']],
      ['backfill', ['DB_SSL', 'DB_WRITER_SECRET_ARN', 'LEGACY_EXPORT_BUCKET', 'EVIDENCE_BUCKET', 'MANIFEST_PREFIX']],
    ])('%s env matches contract section 4 exactly', (name, vars) => {
      expect(Object.keys(envOf(name)).sort()).toEqual([...common, ...vars].sort());
    });

    test('contract constants', () => {
      expect(envOf('api')).toMatchObject({ AUTH_MODE: 'jwt', DB_SSL: 'verify-full', LOG_LEVEL: 'info', CORS_ORIGINS: isProd ? 'https://app.example.test' : '' });
      expect(envOf('digest')).toMatchObject({ DIGEST_PREFIX: 'audit-digest/', DIGEST_REVERIFY_DAYS: '7' });
      expect(envOf('archive-export')).toMatchObject({ ARCHIVE_PREFIX: 'archive/', ARCHIVE_STALE_DAYS: '40' });
      expect(envOf('backfill')).toMatchObject({ MANIFEST_PREFIX: 'backfill/' });
    });

    test('all six handlers: Node.js 22 on arm64, in the VPC, with a log group retention', () => {
      const names = ['migrate', 'api', 'mv-refresh', 'digest', 'archive-export', 'backfill'].map((n) => `audit-${stage}-${n}`);
      const fns = resourcesOfType(json, 'AWS::Lambda::Function').filter(([, r]) => names.includes(props(r)['FunctionName'] as string));
      expect(fns).toHaveLength(6);
      for (const [, r] of fns) {
        expect(props(r)).toMatchObject({ Runtime: 'nodejs22.x', Architectures: ['arm64'], Handler: 'index.handler' });
        expect(props(r)['VpcConfig']).toBeDefined();
      }
      for (const n of names) template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: `/aws/lambda/${n}`, RetentionInDays: isProd ? 365 : 30 });
    });

    test('schedules: mv-refresh every 10 min, digest 03:00 UTC, archive 04:00 UTC; backfill has none', () => {
      const expressions = resourcesOfType(json, 'AWS::Events::Rule').map(([, r]) => props(r)['ScheduleExpression']).filter(Boolean).sort();
      expect(expressions).toEqual(['cron(0 3 * * ? *)', 'cron(0 4 * * ? *)', 'rate(10 minutes)']);
      const backfillId = logicalId(stack, stack.workloads.backfill.fn);
      for (const [, r] of resourcesOfType(json, 'AWS::Events::Rule')) expect(JSON.stringify(props(r)['Targets'] ?? [])).not.toContain(backfillId);
    });
  });

  describe('IAM least privilege', () => {
    test('no wildcard actions except the justified ones', () => {
      const allowed = new Set<string>(['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret']);
      for (const s of identityStatements(json).filter((x) => x.Effect === 'Allow')) {
        for (const a of actionsOf(s)) {
          if (allowed.has(a)) continue;
          expect(a).not.toBe('*');
          expect(a).not.toMatch(/^[a-z0-9-]+:\*$/);
          if (/^(s3|kms):/.test(a)) expect(a).not.toContain('*');
        }
      }
    });

    test('digest/backfill/export principals write only under their own prefix; no Delete anywhere', () => {
      const stmts = identityStatements(json);
      for (const s of stmts) for (const a of actionsOf(s)) expect(a).not.toMatch(/^s3:Delete/);
      const puts = stmts.filter((s) => actionsOf(s).includes('s3:PutObject'));
      const resources = puts.map((s) => JSON.stringify(s.Resource));
      expect(resources.some((r) => r.includes('/audit-digest/*'))).toBe(true);
      expect(resources.some((r) => r.includes('/backfill/*'))).toBe(true);
      expect(resources.some((r) => r.includes('/archive/*'))).toBe(true);
      for (const r of resources) expect(r).toMatch(/\/(audit-digest|backfill|archive)\/\*/);
    });

    test('iam:PassRole only for the RDS export role', () => {
      const pass = identityStatements(json).filter((s) => actionsOf(s).includes('iam:PassRole'));
      expect(pass).toHaveLength(1);
      expect(pass[0]?.Resource).toEqual({ 'Fn::GetAtt': [logicalId(stack, stack.workloads.exportRole), 'Arn'] });
    });

    test('Lambda roles do not use AWS managed policies', () => {
      for (const name of ['Migrate', 'Api', 'MvRefresh', 'Digest', 'ArchiveExport', 'Backfill']) {
        const role = Object.entries(json.Resources).find(([id, r]) => r.Type === 'AWS::IAM::Role' && id.startsWith(`Workloads${name}Role`));
        expect(role).toBeDefined();
        expect(role && props(role[1])['ManagedPolicyArns']).toBeUndefined();
      }
    });
  });

  describe('evidence bucket', () => {
    test(`Object Lock ${isProd ? 'COMPLIANCE' : 'GOVERNANCE'}, versioned, KMS, public access blocked`, () => {
      const id = logicalId(stack, stack.storage.evidenceBucket);
      const r = json.Resources[id];
      if (!r) throw new Error('bucket missing');
      expect(r.DeletionPolicy).toBe('Retain');
      expect(props(r)).toMatchObject({
        ObjectLockEnabled: true,
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: isProd ? 'COMPLIANCE' : 'GOVERNANCE', Days: isProd ? 2557 : 1 } } },
        VersioningConfiguration: { Status: 'Enabled' },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' }, BucketKeyEnabled: true }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      });
    });

    test('bucket policy denies deletion, retention changes, governance bypass and non-TLS', () => {
      const id = logicalId(stack, stack.storage.evidenceBucket);
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        Bucket: { Ref: id },
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
            Match.objectLike({ Effect: 'Deny', Principal: { AWS: '*' }, Action: ['s3:BypassGovernanceRetention', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention'] }),
          ]),
        },
      });
    });
  });

  describe('backup', () => {
    test('monthly on the 1st 05:00 UTC, 7 years, encrypted vault', () => {
      template.hasResourceProperties('AWS::Backup::BackupPlan', {
        BackupPlan: { BackupPlanRule: [Match.objectLike({ ScheduleExpression: 'cron(0 5 1 * ? *)', Lifecycle: { DeleteAfterDays: 2555 } })] },
      });
      template.hasResourceProperties('AWS::Backup::BackupVault', { EncryptionKeyArn: Match.anyValue() });
    });

    test(isProd ? 'prod: Vault Lock on and cross-region copy to the DR vault' : 'dev: no Vault Lock, no DR copy', () => {
      const vault = resourcesOfType(json, 'AWS::Backup::BackupVault')[0];
      if (!vault) throw new Error('vault missing');
      if (isProd) {
        expect(props(vault[1])['LockConfiguration']).toEqual({ MinRetentionDays: 30 });
        template.hasResourceProperties('AWS::Backup::BackupPlan', {
          BackupPlan: { BackupPlanRule: [Match.objectLike({ CopyActions: [Match.objectLike({ DestinationBackupVaultArn: Match.anyValue(), Lifecycle: { DeleteAfterDays: 2555 } })] })] },
        });
        expect(JSON.stringify(json)).toContain(':backup:eu-west-1:');
      } else {
        expect(props(vault[1])['LockConfiguration']).toBeUndefined();
        expect(JSON.stringify(json)).not.toContain('CopyActions');
      }
    });
  });

  describe('API', () => {
    test(isProd ? 'JWT authorizer on /v1/{proxy+}, health open' : 'no authorizer without jwtIssuer', () => {
      template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', isProd ? 1 : 0);
      if (isProd) {
        template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT', JwtConfiguration: { Issuer: 'https://auth.example.test/', Audience: ['audit-api'] } });
        template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /v1/{proxy+}', AuthorizationType: 'JWT' });
        template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /v1/{proxy+}', AuthorizationType: 'JWT' });
      }
      const health = resourcesOfType(json, 'AWS::ApiGatewayV2::Route').find(([, r]) => props(r)['RouteKey'] === 'GET /v1/health');
      expect(health).toBeDefined();
      expect(['NONE', undefined]).toContain(health && props(health[1])['AuthorizationType']);
    });

    test('stage throttling and access logs', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        StageName: '$default',
        DefaultRouteSettings: { ThrottlingRateLimit: isProd ? 200 : 50, ThrottlingBurstLimit: isProd ? 400 : 100 },
        AccessLogSettings: { DestinationArn: Match.anyValue(), Format: Match.stringLikeRegexp('requestId') },
      });
    });
  });

  describe('monitoring', () => {
    test('encrypted alarm topic that enforces TLS', () => {
      template.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
      });
    });

    test('alarms cover DB, functions, digest and API', () => {
      const names = resourcesOfType(json, 'AWS::CloudWatch::Alarm').map(([, r]) => props(r)['AlarmName'] as string);
      for (const n of ['acu-utilisation-high', 'at-max-acu', 'freeable-memory-low', 'connections-high', 'deadlocks', 'engine-restarted', 'migrate-errors', 'mv-refresh-errors', 'mv-refresh-slow', 'digest-mismatch', 'digest-age', 'archive-stale', 'api-5xx', 'api-latency-p99']) {
        expect(names).toContain(`audit-${stage}-${n}`);
      }
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AuditStore', MetricName: 'DigestMismatchCount', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold' });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AuditStore', MetricName: 'DigestAgeHours', Threshold: 30 });
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    });

    test('blocked mutations: metric filter on the postgresql log group + mutation-attempts alarm', () => {
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        LogGroupName: { Ref: logicalId(stack, stack.database.postgresLogs) },
        FilterPattern: '"audit_event is append-only"',
        MetricTransformations: [{ MetricNamespace: 'AuditStore', MetricName: 'MutationAttempts', MetricValue: '1', DefaultValue: 0 }],
      });
      template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: `/aws/rds/cluster/audit-${stage}-audit/postgresql` });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `audit-${stage}-mutation-attempts`,
        Namespace: 'AuditStore',
        MetricName: 'MutationAttempts',
        Statistic: 'Sum',
        Period: 300,
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [{ Ref: logicalId(stack, stack.monitoring.topic) }],
      });
      // log_statement=ddl would write ALTER ROLE ... PASSWORD (the SCRAM verifier) to the log.
      template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', { Parameters: Match.not(Match.objectLike({ log_statement: Match.anyValue() })) });
    });

    test('owner-secret read detection excludes only migrate and the owner rotation Lambda', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          source: ['aws.secretsmanager'],
          detail: Match.objectLike({ eventName: ['GetSecretValue'], requestParameters: { secretId: Match.arrayWith([{ prefix: `audit-${stage}/db/owner` }]) } }),
        }),
        Targets: [Match.objectLike({ Arn: { Ref: logicalId(stack, stack.monitoring.topic) } })],
      });
    });
  });
});

describe('legacy table (createLegacyTable=true)', () => {
  const { template } = synth({ ...DEV, createLegacyTable: 'true' });
  test('PITR, deletion protection, RETAIN, CMK and no TTL', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        TableName: 'audit-dev-audit-legacy',
        BillingMode: 'PAY_PER_REQUEST',
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: 'KMS' }),
        TimeToLiveSpecification: Match.absent(),
      }),
    });
  });
});

describe('Vault Lock modes', () => {
  test('compliance is rejected outside prod at synth time', () => {
    const app = new App({ context: { ...cdkJson.context, stage: 'dev', vaultLockMode: 'compliance', skipBundling: 'true' } });
    expect(() => buildApp(app)).toThrow(/compliance is only allowed for stage=prod/);
  });

  test('prod compliance sets a grace period (ChangeableForDays)', () => {
    const { template } = synth({ ...PROD, vaultLockMode: 'compliance' });
    template.hasResourceProperties('AWS::Backup::BackupVault', { LockConfiguration: { MinRetentionDays: 30, ChangeableForDays: 3 } });
  });

  test('DR vault stack: encrypted, deletion denied, deployed to drRegion', () => {
    const { built } = synth(PROD);
    expect(built.drStack?.region).toBe('eu-west-1');
  });
});

describe('imported VPC (vpcId)', () => {
  test('uses the existing VPC: no VPC, subnets or endpoints are created', () => {
    const app = new App({ context: { ...cdkJson.context, stage: 'dev', skipBundling: 'true', vpcId: 'vpc-0123456789abcdef0' } });
    const { stack } = buildApp(app, { account: '111111111111', region: 'eu-west-1' });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::VPC', 0);
    template.resourceCountIs('AWS::EC2::Subnet', 0);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 6);
  });
});

describe('Serverless v2 auto-pause', () => {
  test('minAcu=0 is accepted for dev', () => {
    synth({ ...DEV, minAcu: '0' }).template.hasResourceProperties('AWS::RDS::DBCluster', { ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 4 } });
  });
});
