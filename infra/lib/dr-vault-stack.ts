import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import type { DrVaultConfig } from './config';
import { denyRecoveryPointDeletion, vaultLockConfiguration } from './constructs/backup';

/** Cross-region copy target. One per account, shared by every stage; deploy it before the stage stacks. */
export class AuditDrVaultStack extends Stack {
  readonly vault: backup.BackupVault;

  constructor(scope: Construct, id: string, config: DrVaultConfig, props: StackProps) {
    super(scope, id, props);

    const key = new kms.Key(this, 'Key', {
      alias: `alias/${config.drVaultName}`,
      description: 'Cross-region audit store backup copies',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const lockConfiguration = vaultLockConfiguration({ mode: config.vaultLockMode, minRetention: Duration.days(30) });
    this.vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: config.drVaultName,
      encryptionKey: key,
      accessPolicy: denyRecoveryPointDeletion(),
      removalPolicy: RemovalPolicy.RETAIN,
      ...(lockConfiguration && { lockConfiguration }),
    });

    new CfnOutput(this, 'DrVaultArn', { value: this.vault.backupVaultArn });
  }
}
