import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { DB_PORT } from './network';

export const DB_NAME = 'audit';
export const OWNER_ROLE = 'audit_owner';
export const WRITER_ROLE = 'audit_writer';
export const READER_ROLE = 'audit_reader';
/** Contract section 3: `"'\;:@/` and space. */
export const PASSWORD_EXCLUDE_CHARACTERS = ` "'\\;:@/`;
export const ROTATION_DAYS = 30;
export const ENGINE_VERSION = rds.AuroraPostgresEngineVersion.VER_16_13;

export interface DatabaseProps {
  readonly prefix: string;
  readonly vpc: ec2.IVpc;
  readonly dbSubnets: ec2.SubnetSelection;
  readonly appSubnets: ec2.SubnetSelection;
  readonly clusterSecurityGroup: ec2.ISecurityGroup;
  readonly rotationSecurityGroup: ec2.ISecurityGroup;
  readonly minAcu: number;
  readonly maxAcu: number;
  readonly enableReader: boolean;
  readonly retainData: boolean;
  readonly backupRetentionDays: number;
  readonly logRetention: logs.RetentionDays;
}

export class AuditDatabase extends Construct {
  readonly key: kms.Key;
  readonly cluster: rds.DatabaseCluster;
  readonly ownerSecret: secretsmanager.ISecret;
  readonly writerSecret: secretsmanager.Secret;
  readonly readerSecret: secretsmanager.Secret;
  readonly rotationSchedules: secretsmanager.RotationSchedule[] = [];
  readonly ownerRotationFunctionName: string;
  readonly postgresLogs: logs.LogGroup;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);
    const removalPolicy = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.key = new kms.Key(this, 'Key', {
      alias: `alias/${props.prefix}/db`,
      description: `${props.prefix} Aurora storage, Performance Insights and DB secrets`,
      enableKeyRotation: true,
      removalPolicy,
    });

    const engine = rds.DatabaseClusterEngine.auroraPostgres({ version: ENGINE_VERSION });
    const parameterGroup = new rds.ParameterGroup(this, 'ClusterParams', {
      engine,
      description: `${props.prefix} audit cluster`,
      parameters: {
        'rds.force_ssl': '1',
        log_min_duration_statement: '1000',
        log_lock_waits: '1',
        // pgaudit is deliberately not preloaded: the application already records every business
        // action in audit_event, and pgaudit's statement logging would duplicate that volume into
        // CloudWatch (cost) and risk logging literals. Enable it per-role when a regulator asks
        // for database-level session auditing.
      },
    });

    const clusterIdentifier = `${props.prefix}-audit`;
    // Pre-created instead of cloudwatchLogsRetention, which would add a LogRetention custom-resource Lambda.
    this.postgresLogs = new logs.LogGroup(this, 'PostgresqlLogs', {
      logGroupName: `/aws/rds/cluster/${clusterIdentifier}/postgresql`,
      retention: props.logRetention,
      removalPolicy,
    });

    const instanceProps = { publiclyAccessible: false, autoMinorVersionUpgrade: true, enablePerformanceInsights: true, performanceInsightEncryptionKey: this.key };
    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine,
      clusterIdentifier,
      defaultDatabaseName: DB_NAME,
      port: DB_PORT,
      credentials: rds.Credentials.fromGeneratedSecret(OWNER_ROLE, {
        secretName: `${props.prefix}/db/owner`,
        encryptionKey: this.key,
        excludeCharacters: PASSWORD_EXCLUDE_CHARACTERS,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer', instanceProps),
      readers: props.enableReader
        ? [rds.ClusterInstance.serverlessV2('reader', { ...instanceProps, scaleWithWriter: true })]
        : [],
      serverlessV2MinCapacity: props.minAcu,
      serverlessV2MaxCapacity: props.maxAcu,
      vpc: props.vpc,
      vpcSubnets: props.dbSubnets,
      securityGroups: [props.clusterSecurityGroup],
      parameterGroup,
      storageEncrypted: true,
      storageEncryptionKey: this.key,
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: this.key,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      cloudwatchLogsExports: ['postgresql'],
      // Password roles + Secrets Manager rotation instead of IAM auth: IAM auth caps new connections
      // at ~200/s per instance and needs a token per connect, which fights pooled Lambda clients.
      iamAuthentication: false,
      // Snapshot early so the 04:00 archive export finds a same-day automated snapshot.
      backup: { retention: Duration.days(props.backupRetentionDays), preferredWindow: '02:00-02:30' },
      preferredMaintenanceWindow: 'sun:05:30-sun:06:30',
      copyTagsToSnapshot: true,
      deletionProtection: props.retainData,
      removalPolicy,
    });
    this.cluster.node.addDependency(this.postgresLogs);
    if (!this.cluster.secret) throw new Error('cluster secret was not generated');
    this.ownerSecret = this.cluster.secret;

    // Role secrets carry the full RDS rotation shape so the hosted rotation Lambda can connect.
    this.writerSecret = this.roleSecret('WriterSecret', `${props.prefix}/db/writer`, WRITER_ROLE, removalPolicy);
    this.readerSecret = this.roleSecret('ReaderSecret', `${props.prefix}/db/reader`, READER_ROLE, removalPolicy);

    this.ownerRotationFunctionName = `${props.prefix}-db-owner-rotation`;
    const rotations: Array<[string, secretsmanager.ISecret, string]> = [
      ['OwnerRotation', this.ownerSecret, this.ownerRotationFunctionName],
      ['WriterRotation', this.writerSecret, `${props.prefix}-db-writer-rotation`],
      ['ReaderRotation', this.readerSecret, `${props.prefix}-db-reader-rotation`],
    ];
    for (const [rid, secret, functionName] of rotations) {
      this.rotationSchedules.push(
        secret.addRotationSchedule(rid, {
          hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
            functionName,
            vpc: props.vpc,
            vpcSubnets: props.appSubnets,
            securityGroups: [props.rotationSecurityGroup],
            excludeCharacters: PASSWORD_EXCLUDE_CHARACTERS,
          }),
          automaticallyAfter: Duration.days(ROTATION_DAYS),
          // writer/reader have no password until migrate sets it; an immediate rotation would fail.
          rotateImmediatelyOnUpdate: false,
        }),
      );
    }
  }

  private roleSecret(id: string, secretName: string, username: string, removalPolicy: RemovalPolicy): secretsmanager.Secret {
    const secret = new secretsmanager.Secret(this, id, {
      secretName,
      description: `${username} credentials (password applied by the migrate custom resource)`,
      encryptionKey: this.key,
      removalPolicy,
      generateSecretString: {
        secretStringTemplate: Stack.of(this).toJsonString({
          engine: 'postgres',
          host: this.cluster.clusterEndpoint.hostname,
          port: DB_PORT,
          dbname: DB_NAME,
          username,
        }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludeCharacters: PASSWORD_EXCLUDE_CHARACTERS,
      },
    });
    return secret;
  }
}
