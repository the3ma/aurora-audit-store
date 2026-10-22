import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { logRetention as toRetention, type StageConfig } from './config';
import { AuditBackup, drVaultArnFor } from './constructs/backup';
import { AuditDatabase } from './constructs/database';
import { Monitoring } from './constructs/monitoring';
import { Network } from './constructs/network';
import { AuditStorage } from './constructs/storage';
import { Workloads } from './constructs/workloads';
import { applyNagSuppressions } from './nag';

export interface AuditStoreStackProps extends StackProps {
  readonly config: StageConfig;
  readonly migrationsChecksum: string;
}

export class AuditStoreStack extends Stack {
  readonly network: Network;
  readonly database: AuditDatabase;
  readonly storage: AuditStorage;
  readonly workloads: Workloads;
  readonly backup: AuditBackup;
  readonly monitoring: Monitoring;

  constructor(scope: Construct, id: string, props: AuditStoreStackProps) {
    super(scope, id, props);
    const { config } = props;
    const logRetention = toRetention(config.logRetentionDays);

    this.network = new Network(this, 'Network', { prefix: config.prefix, vpc: config.vpc, logRetention });
    this.database = new AuditDatabase(this, 'Database', {
      prefix: config.prefix,
      vpc: this.network.vpc,
      dbSubnets: this.network.dbSubnets,
      appSubnets: this.network.appSubnets,
      clusterSecurityGroup: this.network.clusterSecurityGroup,
      rotationSecurityGroup: this.network.clientSecurityGroups.rotation,
      minAcu: config.minAcu,
      maxAcu: config.maxAcu,
      enableReader: config.enableReader,
      retainData: config.retainData,
      backupRetentionDays: config.stage === 'prod' ? 35 : 7,
      logRetention,
    });
    // Rotation Lambdas also need the cluster SG rule and the Secrets Manager endpoint.
    for (const rotation of this.database.rotationSchedules) {
      for (const dep of this.network.readiness) rotation.node.addDependency(dep);
    }

    this.storage = new AuditStorage(this, 'Storage', {
      prefix: config.prefix,
      stage: config.stage,
      evidenceRetentionDays: config.evidenceRetentionDays,
      retainData: config.retainData,
      legacyTableName: config.legacyTableName,
      createLegacyTable: config.createLegacyTable,
    });

    this.workloads = new Workloads(this, 'Workloads', {
      config,
      network: this.network,
      database: this.database,
      storage: this.storage,
      migrationsChecksum: props.migrationsChecksum,
    });

    const drVaultArn = config.drVaultArn ?? (config.drRegion !== undefined ? drVaultArnFor(this, config.drRegion, config.drVaultName) : undefined);
    this.backup = new AuditBackup(this, 'Backup', {
      prefix: config.prefix,
      key: this.storage.key,
      cluster: this.database.cluster,
      retentionYears: config.backupRetentionYears,
      vaultLockMode: config.vaultLockMode,
      retainData: config.retainData,
      ...(drVaultArn !== undefined && { drVaultArn }),
    });

    this.monitoring = new Monitoring(this, 'Monitoring', { config, database: this.database, workloads: this.workloads });

    new CfnOutput(this, 'ApiUrl', { value: this.workloads.httpApi.apiEndpoint });
    new CfnOutput(this, 'ApiAuth', { value: config.jwtIssuer !== undefined ? `jwt (${config.jwtIssuer})` : 'NONE at the gateway - handler rejects requests without JWT claims' });
    new CfnOutput(this, 'ClusterEndpoint', { value: this.database.cluster.clusterEndpoint.hostname });
    new CfnOutput(this, 'OwnerSecretArn', { value: this.database.ownerSecret.secretArn });
    new CfnOutput(this, 'WriterSecretArn', { value: this.database.writerSecret.secretArn });
    new CfnOutput(this, 'ReaderSecretArn', { value: this.database.readerSecret.secretArn });
    new CfnOutput(this, 'EvidenceBucket', { value: this.storage.evidenceBucket.bucketName });
    new CfnOutput(this, 'LegacyExportBucket', { value: this.storage.legacyExportBucket.bucketName });
    new CfnOutput(this, 'LegacyTableName', { value: this.storage.legacyTable.tableName });
    new CfnOutput(this, 'BackfillFunctionName', { value: this.workloads.backfill.fn.functionName });
    new CfnOutput(this, 'AlarmTopicArn', { value: this.monitoring.topic.topicArn });

    applyNagSuppressions(this, config);
  }
}
