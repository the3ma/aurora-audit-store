import { NagSuppressions, type NagPackSuppression } from 'cdk-nag';
import type { AuditStoreStack } from './audit-store-stack';
import type { StageConfig } from './config';

/** cdk-nag v2 regex form for `appliesTo`. */
const re = (pattern: string): { regex: string } => ({ regex: `/${pattern}/g` });

/**
 * Every suppression is scoped to a construct and, for granular rules, to the exact finding via
 * `appliesTo`. Anything not listed here fails the nag test.
 */
export function applyNagSuppressions(stack: AuditStoreStack, config: StageConfig): void {
  const w = stack.workloads;
  const add = (construct: Parameters<typeof NagSuppressions.addResourceSuppressions>[0], suppressions: NagPackSuppression[]): void => {
    NagSuppressions.addResourceSuppressions(construct, suppressions, true);
  };

  for (const f of [w.migrate, w.api, w.mvRefresh, w.digest, w.archiveExport, w.backfill]) {
    add(f.role, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Resource "*" only for actions without resource-level permissions: Lambda VPC ENI management (ec2:*NetworkInterface*, DescribeSubnets), ' +
          'cloudwatch:PutMetricData (digest, archive-export; restricted by a cloudwatch:namespace=AuditStore condition) and rds:DescribeExportTasks (archive-export).',
        appliesTo: ['Resource::*'],
      },
    ]);
    add(f.fn, [
      {
        id: 'AwsSolutions-L1',
        reason: 'Runtime is pinned to Node.js 22 by the integration contract (matches the workspace engines and esbuild target); 24.x is a deliberate, tested upgrade.',
      },
    ]);
  }

  add(w.digest.role, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'digest writes and re-reads sealed blocks only under the audit-digest/ prefix of the evidence bucket; object keys are date/row-range derived.',
      appliesTo: [re('^Resource::<StorageEvidence[0-9A-F]+\\.Arn>\\/audit-digest\\/\\*$')],
    },
  ]);
  add(w.backfill.role, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'backfill writes its manifest/rejects only under backfill/ of the evidence bucket, and reads any object of the dedicated legacy export bucket (export prefix is a runtime input).',
      appliesTo: [re('^Resource::<StorageEvidence[0-9A-F]+\\.Arn>\\/backfill\\/\\*$'), re('^Resource::<StorageLegacyExport[0-9A-F]+\\.Arn>\\/\\*$')],
    },
  ]);
  add(w.archiveExport.role, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Automated snapshot names are rds:<cluster-id>-<timestamp>; the wildcard is limited to this cluster\'s automated snapshots.',
      appliesTo: [re('^Resource::arn:<AWS::Partition>:rds:<AWS::Region>:<AWS::AccountId>:cluster-snapshot:rds:<DatabaseCluster[0-9A-F]+>-\\*$')],
    },
  ]);
  add(w.exportRole, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'The RDS export service role writes Parquet part files with generated names, only under archive/ of the evidence bucket.',
      appliesTo: [re('^Resource::<StorageEvidence[0-9A-F]+\\.Arn>\\/archive\\/\\*$')],
    },
  ]);
  add(w.migrationProvider, [
    {
      id: 'AwsSolutions-IAM4',
      reason: 'CDK custom-resource provider framework Lambda (not in the data path); it only invokes the migrate function and writes its own logs.',
      appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Provider framework invokes any version/alias of the single migrate function.',
      appliesTo: [re('^Resource::<WorkloadsMigrateFn[0-9A-F]+\\.Arn>:\\*$')],
    },
  ]);

  add(stack.backup.plan, [
    {
      id: 'AwsSolutions-IAM4',
      reason: 'AWS Backup service role uses the AWS-maintained AWSBackupServiceRolePolicyForBackup, which tracks new resource types and the RDS/KMS calls Backup needs.',
      appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup'],
    },
  ]);

  add(stack.database.cluster, [
    {
      id: 'AwsSolutions-RDS6',
      reason: 'Password roles with 30-day Secrets Manager rotation instead of IAM auth: IAM auth limits new connections (~200/s) and needs a token per connect, a poor fit for pooled Lambda clients. TLS is forced (rds.force_ssl=1).',
    },
  ]);
  if (!config.retainData) {
    add(stack.database.cluster, [
      {
        id: 'AwsSolutions-RDS10',
        reason: 'dev is a disposable sandbox (RemovalPolicy.DESTROY); prod enables deletion protection and RETAIN.',
      },
    ]);
  }

  // Health returns no tenant data and must be probeable without a token.
  NagSuppressions.addResourceSuppressionsByPath(stack, `${stack.node.path}/Workloads/HttpApi/GET--v1--health/Resource`, [
    { id: 'AwsSolutions-APIG4', reason: 'Unauthenticated health probe; returns only {status, checks:{db}} and no tenant data.' },
  ]);
  if (config.jwtIssuer === undefined) {
    for (const method of ['GET', 'POST']) {
      NagSuppressions.addResourceSuppressionsByPath(stack, `${stack.node.path}/Workloads/HttpApi/${method}--v1--{proxy+}/Resource`, [
        {
          id: 'AwsSolutions-APIG4',
          reason:
            'No jwtIssuer configured, so no gateway authorizer (sandbox only). The handler runs with AUTH_MODE=jwt and rejects requests without verified JWT claims (fail closed). Set -c jwtIssuer/-c jwtAudience for any shared environment.',
        },
      ]);
    }
  }
}
