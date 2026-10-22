import { ArnFormat, type CfnResource, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { logRetention as toRetention, type StageConfig } from '../config';
import { AuditFunction } from './audit-function';
import type { AuditDatabase } from './database';
import type { Network } from './network';
import { ARCHIVE_PREFIX, DIGEST_PREFIX, MANIFEST_PREFIX, type AuditStorage } from './storage';

export const METRICS_NAMESPACE = 'AuditStore';

export interface WorkloadsProps {
  readonly config: StageConfig;
  readonly network: Network;
  readonly database: AuditDatabase;
  readonly storage: AuditStorage;
  readonly migrationsChecksum: string;
}

export class Workloads extends Construct {
  readonly migrate: AuditFunction;
  readonly api: AuditFunction;
  readonly mvRefresh: AuditFunction;
  readonly digest: AuditFunction;
  readonly archiveExport: AuditFunction;
  readonly backfill: AuditFunction;
  readonly migration: CustomResource;
  readonly migrationProvider: cr.Provider;
  readonly httpApi: apigwv2.HttpApi;
  readonly httpStage: apigwv2.HttpStage;
  readonly exportRole: iam.Role;

  constructor(scope: Construct, id: string, props: WorkloadsProps) {
    super(scope, id);
    const { config, network, database, storage } = props;
    const logRetention = toRetention(config.logRetentionDays);
    const base = {
      prefix: config.prefix,
      vpc: network.vpc,
      vpcSubnets: network.appSubnets,
      logRetention,
      skipBundling: config.skipBundling,
    };
    const dbSsl = { DB_SSL: 'verify-full' };
    const sg = network.clientSecurityGroups;

    // --- migrate: the only principal that ever uses the owner (DDL) credentials.
    this.migrate = new AuditFunction(this, 'Migrate', {
      ...base,
      handlerName: 'migrate',
      description: 'Applies db/migrations, sets role passwords, runs immutability proofs (custom resource)',
      securityGroup: sg.migrate,
      timeout: Duration.minutes(5),
      memorySize: 512,
      // Two concurrent migration runs would race on audit_schema_migrations.
      reservedConcurrentExecutions: 1,
      environment: {
        ...dbSsl,
        DB_OWNER_SECRET_ARN: database.ownerSecret.secretArn,
        DB_WRITER_SECRET_ARN: database.writerSecret.secretArn,
        DB_READER_SECRET_ARN: database.readerSecret.secretArn,
      },
    });
    database.ownerSecret.grantRead(this.migrate.fn);
    database.writerSecret.grantRead(this.migrate.fn);
    database.readerSecret.grantRead(this.migrate.fn);

    this.migrationProvider = new cr.Provider(this, 'MigrationProvider', {
      onEventHandler: this.migrate.fn,
      logGroup: new logs.LogGroup(this, 'MigrationProviderLogs', { retention: logRetention }),
    });
    this.migration = new CustomResource(this, 'Migration', {
      serviceToken: this.migrationProvider.serviceToken,
      resourceType: 'Custom::AuditSchemaMigration',
      properties: { MigrationsChecksum: props.migrationsChecksum },
    });
    // The writer instance (not just the cluster resource), the SG rules and the endpoints must exist
    // before the first connection, otherwise the first deploy fails with a connect timeout.
    // Depend on the L1 cluster + instances only: the whole cluster construct also contains the owner
    // rotation schedule, which itself waits for the migration (cycle).
    for (const child of database.cluster.node.findAll()) {
      if (child instanceof rds.CfnDBCluster || child instanceof rds.CfnDBInstance) this.migration.node.addDependency(child);
    }
    for (const dep of network.readiness) this.migration.node.addDependency(dep);
    // Rotating a role that migrate has not yet given a password would fail.
    for (const rotation of database.rotationSchedules) rotation.node.addDependency(this.migration);

    // --- api
    this.api = new AuditFunction(this, 'Api', {
      ...base,
      handlerName: 'api',
      description: 'Audit read/write HTTP API (/v1)',
      securityGroup: sg.api,
      timeout: Duration.seconds(15),
      memorySize: 512,
      // Caps DB connections: concurrency x pool size must stay below max_connections.
      ...(config.apiReservedConcurrency !== undefined && { reservedConcurrentExecutions: config.apiReservedConcurrency }),
      environment: {
        ...dbSsl,
        DB_READER_SECRET_ARN: database.readerSecret.secretArn,
        DB_WRITER_SECRET_ARN: database.writerSecret.secretArn,
        AUTH_MODE: 'jwt',
        CORS_ORIGINS: config.corsOrigins.join(','),
      },
    });
    database.readerSecret.grantRead(this.api.fn);
    database.writerSecret.grantRead(this.api.fn);

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention: logRetention });
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${config.prefix}-audit-api`,
      description: 'Audit store read/write API',
      createDefaultStage: false,
      disableExecuteApiEndpoint: false,
      ...(config.corsOrigins.length > 0 && {
        corsPreflight: {
          allowOrigins: [...config.corsOrigins],
          allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
          allowHeaders: ['authorization', 'content-type'],
          maxAge: Duration.hours(1),
        },
      }),
    });
    this.httpStage = this.httpApi.addStage('Stage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: config.apiThrottleRate, burstLimit: config.apiThrottleBurst },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            requestTime: '$context.requestTime',
            routeKey: '$context.routeKey',
            status: '$context.status',
            latency: '$context.responseLatency',
            integrationError: '$context.integrationErrorMessage',
            sub: '$context.authorizer.claims.sub',
            tenant: '$context.authorizer.claims.tenant_id',
          }),
        ),
      },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', this.api.fn, { payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0 });
    // Without jwtIssuer there is no gateway authorizer; the handler still runs with AUTH_MODE=jwt and
    // rejects requests that carry no verified tenant claim.
    const authorizer =
      config.jwtIssuer !== undefined && config.jwtAudience !== undefined
        ? new HttpJwtAuthorizer('Jwt', config.jwtIssuer, { jwtAudience: [config.jwtAudience], identitySource: ['$request.header.Authorization'] })
        : undefined;
    this.httpApi.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      ...(authorizer && { authorizer }),
    });
    // Health is unauthenticated so load balancers / synthetics can probe it; it returns no tenant data.
    this.httpApi.addRoutes({ path: '/v1/health', methods: [apigwv2.HttpMethod.GET], integration });

    // --- mv-refresh
    this.mvRefresh = new AuditFunction(this, 'MvRefresh', {
      ...base,
      handlerName: 'mv-refresh',
      description: 'Refreshes mv_audit_facets / mv_audit_daily_counts',
      securityGroup: sg['mv-refresh'],
      timeout: Duration.minutes(5),
      // Overlapping refreshes of the same MV just queue on its lock.
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      environment: { ...dbSsl, DB_READER_SECRET_ARN: database.readerSecret.secretArn },
    });
    database.readerSecret.grantRead(this.mvRefresh.fn);
    this.schedule('MvRefreshSchedule', 'rate(10 minutes)', events.Schedule.rate(Duration.minutes(10)), this.mvRefresh.fn);

    // --- digest
    this.digest = new AuditFunction(this, 'Digest', {
      ...base,
      handlerName: 'digest',
      description: 'Seals closed event_row_id ranges into a hash chain in the evidence bucket',
      securityGroup: sg.digest,
      timeout: Duration.minutes(10),
      memorySize: 512,
      // The hash chain is strictly sequential: two writers would fork it.
      reservedConcurrentExecutions: 1,
      retryAttempts: 1,
      environment: {
        ...dbSsl,
        DB_READER_SECRET_ARN: database.readerSecret.secretArn,
        EVIDENCE_BUCKET: storage.evidenceBucket.bucketName,
        DIGEST_PREFIX,
        DIGEST_REVERIFY_DAYS: '7',
      },
    });
    database.readerSecret.grantRead(this.digest.fn);
    this.grantPrefixWrite(this.digest.fn, storage.evidenceBucket, storage.key, DIGEST_PREFIX);
    // Re-verification reads back previously sealed blocks.
    this.grantPrefixRead(this.digest.fn, storage.evidenceBucket, storage.key, DIGEST_PREFIX);
    this.grantPutMetrics(this.digest.fn);
    this.schedule('DigestSchedule', 'cron 03:00 UTC', events.Schedule.cron({ minute: '0', hour: '3' }), this.digest.fn);

    // --- archive-export: RDS snapshot export (Parquet) into the evidence bucket; no DB connection.
    this.exportRole = new iam.Role(this, 'SnapshotExportRole', {
      assumedBy: new iam.ServicePrincipal('export.rds.amazonaws.com'),
      description: 'Assumed by RDS to write snapshot exports under archive/',
    });
    this.exportRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteArchivePrefix',
        // RDS export reads back its own part files while assembling the export; Delete is denied by
        // the bucket policy regardless.
        actions: ['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        resources: [storage.evidenceBucket.arnForObjects(`${ARCHIVE_PREFIX}*`)],
      }),
    );
    this.exportRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LocateBucket',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [storage.evidenceBucket.bucketArn],
      }),
    );
    this.exportRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EncryptArchive',
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        resources: [storage.key.keyArn],
      }),
    );

    this.archiveExport = new AuditFunction(this, 'ArchiveExport', {
      ...base,
      handlerName: 'archive-export',
      description: 'Starts a Parquet export of the latest automated snapshot into archive/',
      securityGroup: network.archiveExportSecurityGroup,
      timeout: Duration.minutes(1),
      reservedConcurrentExecutions: 1,
      // The handler throws when the archive is stale; an immediate retry cannot fix that.
      retryAttempts: 0,
      environment: {
        CLUSTER_ARN: database.cluster.clusterArn,
        EVIDENCE_BUCKET: storage.evidenceBucket.bucketName,
        ARCHIVE_PREFIX,
        EXPORT_ROLE_ARN: this.exportRole.roleArn,
        EXPORT_KMS_KEY_ARN: storage.key.keyArn,
        ARCHIVE_STALE_DAYS: '40',
      },
    });
    const stack = Stack.of(this);
    const snapshotArn = stack.formatArn({
      service: 'rds',
      resource: 'cluster-snapshot',
      resourceName: `rds:${database.cluster.clusterIdentifier}-*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    this.archiveExport.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ExportAutomatedSnapshots',
        actions: ['rds:StartExportTask', 'rds:DescribeDBClusterSnapshots'],
        resources: [database.cluster.clusterArn, snapshotArn],
      }),
    );
    this.archiveExport.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TrackExportTasks',
        // DescribeExportTasks has no resource-level permissions.
        actions: ['rds:DescribeExportTasks'],
        resources: ['*'],
      }),
    );
    this.archiveExport.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PassExportRole',
        actions: ['iam:PassRole'],
        resources: [this.exportRole.roleArn],
      }),
    );
    this.archiveExport.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'UseExportKey',
        // StartExportTask requires the caller to be able to create a grant on the export key.
        actions: ['kms:CreateGrant', 'kms:DescribeKey'],
        resources: [storage.key.keyArn],
      }),
    );
    this.grantPutMetrics(this.archiveExport.fn);
    this.schedule('ArchiveExportSchedule', 'cron 04:00 UTC', events.Schedule.cron({ minute: '0', hour: '4' }), this.archiveExport.fn);

    // --- backfill: manual invoke only (no trigger).
    this.backfill = new AuditFunction(this, 'Backfill', {
      ...base,
      handlerName: 'backfill',
      description: 'Loads a DynamoDB ExportTableToPointInTime export into audit_event (manual invoke)',
      securityGroup: sg.backfill,
      timeout: Duration.minutes(15),
      memorySize: 1024,
      // One run per export; parallel runs would only contend on the event_id unique index.
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      environment: {
        ...dbSsl,
        DB_WRITER_SECRET_ARN: database.writerSecret.secretArn,
        LEGACY_EXPORT_BUCKET: storage.legacyExportBucket.bucketName,
        EVIDENCE_BUCKET: storage.evidenceBucket.bucketName,
        MANIFEST_PREFIX,
      },
    });
    database.writerSecret.grantRead(this.backfill.fn);
    this.grantPrefixRead(this.backfill.fn, storage.legacyExportBucket, storage.key, '');
    this.grantPrefixWrite(this.backfill.fn, storage.evidenceBucket, storage.key, MANIFEST_PREFIX);

    // Everything that connects as writer/reader needs the roles, grants and passwords migrate creates.
    for (const f of [this.api, this.mvRefresh, this.digest, this.backfill]) {
      // Only the function resource, not its role: the KMS key policy references the role and the
      // cluster depends on the key, so a role -> migration edge would close a cycle.
      (f.fn.node.defaultChild as CfnResource).addResourceDependency(this.migration.node.defaultChild as CfnResource);
    }
  }

  private schedule(id: string, description: string, schedule: events.Schedule, fn: lambda.IFunction): events.Rule {
    return new events.Rule(this, id, {
      description,
      schedule,
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 2, maxEventAge: Duration.hours(1) })],
    });
  }

  /** PutObject only - no overwrite protection is needed beyond Object Lock + versioning. */
  private grantPrefixWrite(fn: lambda.IFunction, bucket: s3.IBucket, key: kms.IKey, prefix: string): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects(`${prefix}*`)],
      }),
    );
    key.grant(fn, 'kms:GenerateDataKey', 'kms:Encrypt');
  }

  private grantPrefixRead(fn: lambda.IFunction, bucket: s3.IBucket, key: kms.IKey, prefix: string): void {
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [bucket.arnForObjects(`${prefix}*`)] }));
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        ...(prefix !== '' && { conditions: { StringLike: { 's3:prefix': [`${prefix}*`] } } }),
      }),
    );
    key.grantDecrypt(fn);
  }

  private grantPutMetrics(fn: lambda.IFunction): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        // PutMetricData has no resource-level permissions; the namespace condition scopes it.
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': METRICS_NAMESPACE } },
      }),
    );
  }
}
