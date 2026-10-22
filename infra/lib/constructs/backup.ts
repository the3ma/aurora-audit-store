import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import type { VaultLockMode } from '../config';

export interface VaultLockProps {
  readonly mode: VaultLockMode;
  readonly minRetention: Duration;
}

/**
 * governance: lock can still be removed by a principal allowed to call DeleteBackupVaultLockConfiguration.
 * compliance: `changeableFor` is the grace period; after it the lock is immutable, even for root.
 */
export function vaultLockConfiguration(lock: VaultLockProps): backup.LockConfiguration | undefined {
  switch (lock.mode) {
    case 'none':
      return undefined;
    case 'governance':
      return { minRetention: lock.minRetention };
    case 'compliance':
      return { minRetention: lock.minRetention, changeableFor: Duration.days(3) };
  }
}

/** Recovery points may not be deleted or their lifecycle shortened by anyone in the account. */
export function denyRecoveryPointDeletion(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: 'DenyRecoveryPointDeletion',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['backup:DeleteRecoveryPoint', 'backup:UpdateRecoveryPointLifecycle'],
        resources: ['*'],
      }),
    ],
  });
}

export interface AuditBackupProps {
  readonly prefix: string;
  readonly key: kms.IKey;
  readonly cluster: rds.DatabaseCluster;
  readonly retentionYears: number;
  readonly vaultLockMode: VaultLockMode;
  readonly retainData: boolean;
  /** ARN of the cross-region DR vault; no copy when undefined. */
  readonly drVaultArn?: string;
}

export class AuditBackup extends Construct {
  readonly vault: backup.BackupVault;
  readonly plan: backup.BackupPlan;

  constructor(scope: Construct, id: string, props: AuditBackupProps) {
    super(scope, id);
    const deleteAfter = Duration.days(365 * props.retentionYears);
    const lockConfiguration = vaultLockConfiguration({ mode: props.vaultLockMode, minRetention: Duration.days(30) });

    this.vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: `${props.prefix}-audit`,
      encryptionKey: props.key,
      accessPolicy: denyRecoveryPointDeletion(),
      removalPolicy: props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      ...(lockConfiguration && { lockConfiguration }),
    });

    // Monthly, not daily: Aurora already keeps 7-35 days of continuous PITR, so the vault is for
    // long-term retention. With Vault Lock and 7-year retention a daily rule would accumulate
    // ~2,555 immutable recovery points per cluster (cost that can never be cleaned up); monthly is 84.
    this.plan = new backup.BackupPlan(this, 'Plan', { backupPlanName: `${props.prefix}-audit-monthly` });
    this.plan.addRule(
      new backup.BackupPlanRule({
        ruleName: 'monthly-7y',
        backupVault: this.vault,
        scheduleExpression: events.Schedule.cron({ minute: '0', hour: '5', day: '1', month: '*', year: '*' }),
        startWindow: Duration.hours(1),
        completionWindow: Duration.hours(8),
        deleteAfter,
        ...(props.drVaultArn !== undefined && {
          copyActions: [
            {
              destinationBackupVault: backup.BackupVault.fromBackupVaultArn(this, 'DrVault', props.drVaultArn),
              deleteAfter,
            },
          ],
        }),
      }),
    );
    this.plan.addSelection('Cluster', {
      resources: [backup.BackupResource.fromArn(props.cluster.clusterArn)],
      allowRestores: false,
    });
  }
}

/** The DR vault has a fixed name, so its ARN is derivable without a cross-region reference. */
export function drVaultArnFor(scope: Construct, drRegion: string, drVaultName: string): string {
  const stack = Stack.of(scope);
  return `arn:${stack.partition}:backup:${drRegion}:${stack.account}:backup-vault:${drVaultName}`;
}
