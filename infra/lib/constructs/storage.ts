import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { Stage } from '../config';

export const DIGEST_PREFIX = 'audit-digest/';
export const ARCHIVE_PREFIX = 'archive/';
export const MANIFEST_PREFIX = 'backfill/';

export interface StorageProps {
  readonly prefix: string;
  readonly stage: Stage;
  readonly evidenceRetentionDays: number;
  readonly retainData: boolean;
  readonly legacyTableName: string;
  readonly createLegacyTable: boolean;
}

export class AuditStorage extends Construct {
  /** Evidence bucket, legacy export bucket, archive export and the legacy table. */
  readonly key: kms.Key;
  readonly accessLogs: s3.Bucket;
  readonly evidenceBucket: s3.Bucket;
  readonly legacyExportBucket: s3.Bucket;
  readonly legacyTable: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    const removalPolicy = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.key = new kms.Key(this, 'Key', {
      alias: `alias/${props.prefix}/data`,
      description: `${props.prefix} evidence, archive and legacy export data`,
      enableKeyRotation: true,
      removalPolicy,
    });

    // Server access log delivery does not support SSE-KMS targets, hence S3-managed keys here.
    this.accessLogs = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(400), noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy,
      autoDeleteObjects: false,
    });

    const retention = Duration.days(props.evidenceRetentionDays);
    this.evidenceBucket = new s3.Bucket(this, 'Evidence', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      objectLockEnabled: true,
      objectLockDefaultRetention: props.stage === 'prod' ? s3.ObjectLockRetention.compliance(retention) : s3.ObjectLockRetention.governance(retention),
      serverAccessLogsBucket: this.accessLogs,
      serverAccessLogsPrefix: 'evidence/',
      // Locked objects cannot be deleted by CloudFormation anyway; never try.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Defence in depth on top of Object Lock: nobody - including admins - deletes evidence, shortens
    // retention or bypasses governance mode. Lifting this requires editing the bucket policy, which
    // is a CloudTrail-visible management event.
    this.evidenceBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyEvidenceDeletionAndRetentionChanges',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention', 's3:BypassGovernanceRetention'],
        resources: [this.evidenceBucket.bucketArn, this.evidenceBucket.arnForObjects('*')],
      }),
    );

    this.legacyExportBucket = new s3.Bucket(this, 'LegacyExport', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: this.accessLogs,
      serverAccessLogsPrefix: 'legacy-export/',
      removalPolicy,
    });

    if (props.createLegacyTable) {
      // The "before" table. No TTL: the TTL was what deleted regulated records in the old design.
      const table = new dynamodb.Table(this, 'LegacyTable', {
        tableName: props.legacyTableName,
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: this.key,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      table.addGlobalSecondaryIndex({
        indexName: 'GSI1',
        partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      });
      for (const n of [2, 3, 4]) {
        table.addGlobalSecondaryIndex({
          indexName: `GSI${n}`,
          partitionKey: { name: `GSI${n}PK`, type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        });
      }
      this.legacyTable = table;
    } else {
      this.legacyTable = dynamodb.Table.fromTableName(this, 'LegacyTable', props.legacyTableName);
    }
  }
}
