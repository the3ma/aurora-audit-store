import { Aspects, Tags, type App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AuditStoreStack } from './audit-store-stack';
import { loadDrVaultConfig, loadStageConfig } from './config';
import { AuditDrVaultStack } from './dr-vault-stack';
import { migrationsChecksum } from './migrations';

export interface BuiltApp {
  readonly stack: AuditStoreStack;
  readonly drStack?: AuditDrVaultStack;
}

export function buildApp(app: App, env: { account?: string; region?: string } = {}): BuiltApp {
  const config = loadStageConfig(app.node);

  const stack = new AuditStoreStack(app, `AuditStore-${config.stage}`, {
    config,
    migrationsChecksum: migrationsChecksum(),
    // An imported VPC needs a concrete account/region for Vpc.fromLookup; created VPCs stay env-agnostic.
    ...(config.vpc.mode === 'import' && { env }),
    description: `Append-only audit store on Aurora PostgreSQL (${config.stage})`,
    terminationProtection: config.stage === 'prod',
  });

  const drStack =
    config.drRegion !== undefined
      ? new AuditDrVaultStack(app, 'AuditDrVault', loadDrVaultConfig(app.node), {
          env: { ...(env.account !== undefined && { account: env.account }), region: config.drRegion },
          description: 'Cross-region backup vault for the audit store (one per account)',
          terminationProtection: true,
        })
      : undefined;

  Tags.of(app).add('app', 'aurora-audit-store');
  Tags.of(app).add('stage', config.stage);
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  return { stack, ...(drStack && { drStack }) };
}
