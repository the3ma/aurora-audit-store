import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import type { StageConfig } from '../config';
import type { AuditFunction } from './audit-function';
import type { AuditDatabase } from './database';
import { METRICS_NAMESPACE, type Workloads } from './workloads';

export interface MonitoringProps {
  readonly config: StageConfig;
  readonly database: AuditDatabase;
  readonly workloads: Workloads;
}

/** Message of the append-only trigger (contract section 2). */
export const MUTATION_ERROR_TEXT = 'audit_event is append-only';

/** Bytes per connection in the Aurora PostgreSQL max_connections formula. */
const BYTES_PER_CONNECTION = 9_531_392;

export class Monitoring extends Construct {
  readonly topic: sns.Topic;
  readonly dashboard: cloudwatch.Dashboard;
  readonly alarms: cloudwatch.Alarm[] = [];
  readonly masterSecretReadRule: events.Rule;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    const { config, database, workloads } = props;
    const cluster = database.cluster;

    const key = new kms.Key(this, 'Key', {
      alias: `alias/${config.prefix}/alarms`,
      description: `${config.prefix} alarm topic`,
      enableKeyRotation: true,
    });
    // Alarms and EventBridge publish to the encrypted topic as services, so they need the key.
    for (const service of ['cloudwatch.amazonaws.com', 'events.amazonaws.com']) {
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal(service)],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
        }),
      );
    }
    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: `${config.prefix}-audit-alarms`,
      masterKey: key,
      enforceSSL: true,
    });
    if (config.alarmEmail !== undefined) this.topic.addSubscription(new subs.EmailSubscription(config.alarmEmail));
    const action = new cwActions.SnsAction(this.topic);

    const add = (alarmId: string, alarm: cloudwatch.AlarmProps): cloudwatch.Alarm => {
      const a = new cloudwatch.Alarm(this, alarmId, { ...alarm, alarmName: `${config.prefix}-${alarm.alarmName ?? alarmId}` });
      a.addAlarmAction(action);
      a.addOkAction(action);
      this.alarms.push(a);
      return a;
    };
    const fiveMin = Duration.minutes(5);

    // --- Aurora
    const acu = cluster.metricACUUtilization({ period: fiveMin, statistic: 'Maximum' });
    add('AcuUtilisationHigh', { alarmName: 'acu-utilisation-high', metric: acu, threshold: 80, evaluationPeriods: 3, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, alarmDescription: 'Serverless v2 above 80% of max ACU for 15 min: raise maxAcu or find the query.' });
    const capacity = cluster.metricServerlessDatabaseCapacity({ period: fiveMin, statistic: 'Maximum' });
    add('AtMaxCapacity', { alarmName: 'at-max-acu', metric: capacity, threshold: config.maxAcu, evaluationPeriods: 3, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, alarmDescription: 'Writer pinned at maxAcu: it cannot scale further.' });
    const freeable = cluster.metric('FreeableMemory', { period: fiveMin, statistic: 'Minimum' });
    add('FreeableMemoryLow', { alarmName: 'freeable-memory-low', metric: freeable, threshold: 256 * 1024 * 1024, evaluationPeriods: 3, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, alarmDescription: 'Less than 256 MiB freeable memory.' });
    // max_connections for Serverless v2 is derived from the memory at maxAcu (2 GiB per ACU).
    const maxConnections = Math.min(5000, Math.floor((config.maxAcu * 2 * 1024 ** 3) / BYTES_PER_CONNECTION));
    const connections = cluster.metric('DatabaseConnections', { period: fiveMin, statistic: 'Maximum' });
    add('ConnectionsHigh', { alarmName: 'connections-high', metric: connections, threshold: Math.floor(maxConnections * 0.8), evaluationPeriods: 3, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, alarmDescription: `Above 80% of ~${maxConnections} max_connections at maxAcu.` });
    const deadlocks = cluster.metric('Deadlocks', { period: fiveMin, statistic: 'Sum' });
    add('Deadlocks', { alarmName: 'deadlocks', metric: deadlocks, threshold: 0, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'An append-only workload should never deadlock.' });
    const uptime = cluster.metric('EngineUptime', { period: fiveMin, statistic: 'Minimum' });
    add('EngineRestarted', { alarmName: 'engine-restarted', metric: uptime, threshold: 600, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.BREACHING, alarmDescription: 'Engine uptime under 10 min: restart, failover or missing metric.' });

    // --- Functions: none of them has a DLQ, so an error alarm is the only signal a run failed.
    const fnErrors = (fid: string, name: string, f: AuditFunction, description: string): void => {
      add(fid, { alarmName: name, metric: f.fn.metricErrors({ period: fiveMin, statistic: 'Sum' }), threshold: 0, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: description });
    };
    fnErrors('MigrateErrors', 'migrate-errors', workloads.migrate, 'Migration custom resource failed: the deployment rolled back or a proof failed.');
    fnErrors('MvRefreshErrors', 'mv-refresh-errors', workloads.mvRefresh, 'Materialized view refresh failed; facets and daily stats are going stale.');
    fnErrors('DigestErrors', 'digest-errors', workloads.digest, 'Digest run failed (it also throws on DigestMismatchCount > 0): tamper evidence is not being sealed, or a sealed block no longer verifies.');
    fnErrors('ArchiveExportErrors', 'archive-errors', workloads.archiveExport, 'archive-export failed: RDS API/permission error, or ArchiveStaleError (newest export older than ARCHIVE_STALE_DAYS, or none yet - expected daily after a first deploy until the first monthly export completes).');
    fnErrors('BackfillErrors', 'backfill-errors', workloads.backfill, 'Backfill run failed (manifest invariant or DB error).');
    fnErrors('ApiErrors', 'api-function-errors', workloads.api, 'API Lambda errors (unhandled exceptions or timeouts).');

    const mvDuration = workloads.mvRefresh.fn.metricDuration({ period: Duration.minutes(30), statistic: 'Maximum' });
    add('MvRefreshSlow', { alarmName: 'mv-refresh-slow', metric: mvDuration, threshold: 120_000, evaluationPeriods: 2, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'Refresh above 2 min for an hour: move to REFRESH CONCURRENTLY / incremental rollups.' });

    // --- Custom metrics published by digest and archive-export (namespace AuditStore, no dimensions)
    const customMetric = (metricName: string, statistic: string, period: Duration): cloudwatch.Metric => new cloudwatch.Metric({ namespace: METRICS_NAMESPACE, metricName, statistic, period });

    // ArchiveStale=1 when the newest COMPLETE export is older than ARCHIVE_STALE_DAYS (or none exists yet,
    // so this fires after a first deploy until the first monthly export completes).
    add('ArchiveStale', { alarmName: 'archive-stale', metric: customMetric('ArchiveStale', 'Maximum', Duration.days(1)), threshold: 0, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'Newest snapshot export is older than ARCHIVE_STALE_DAYS (40). Follow the archive runbook.' });
    // Archive runs daily; no invocation for 2 days means the schedule itself is broken.
    const archiveRuns = workloads.archiveExport.fn.metricInvocations({ period: Duration.days(1), statistic: 'Sum' });
    add('ArchiveNotRunning', { alarmName: 'archive-not-running', metric: archiveRuns, threshold: 1, evaluationPeriods: 2, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.BREACHING, alarmDescription: 'archive-export has not run for 2 days.' });

    add('DigestMismatch', { alarmName: 'digest-mismatch', metric: customMetric('DigestMismatchCount', 'Maximum', Duration.hours(1)), threshold: 0, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'A sealed block no longer matches the database: possible tampering. Follow the tamper runbook.' });
    // Missing data is breaching: if digest stops publishing, the chain is not being extended.
    add('DigestAge', { alarmName: 'digest-age', metric: customMetric('DigestAgeHours', 'Maximum', Duration.hours(1)), threshold: 30, evaluationPeriods: 1, datapointsToAlarm: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.MISSING, alarmDescription: 'Newest sealed block is older than 30 h.' });
    add('DigestMissing', { alarmName: 'digest-not-reporting', metric: customMetric('DigestAgeHours', 'SampleCount', Duration.hours(6)), threshold: 1, evaluationPeriods: 5, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.BREACHING, alarmDescription: 'digest has not published DigestAgeHours for 30 h.' });

    // --- Blocked mutations of audit_event. The append-only trigger raises SQLSTATE 23001 with this
    // text, and ERROR lines reach the log by default (log_min_error_statement). Deliberately not
    // log_statement=ddl: that would log ALTER ROLE ... PASSWORD with the SCRAM verifier.
    const mutationFilter = new logs.MetricFilter(this, 'MutationAttemptsFilter', {
      logGroup: database.postgresLogs,
      filterPattern: logs.FilterPattern.allTerms(MUTATION_ERROR_TEXT),
      metricNamespace: METRICS_NAMESPACE,
      metricName: 'MutationAttempts',
      metricValue: '1',
      defaultValue: 0,
    });
    const mutationAttempts = mutationFilter.metric({ statistic: 'Sum', period: fiveMin });
    add('MutationAttempts', { alarmName: 'mutation-attempts', metric: mutationAttempts, threshold: 0, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'Someone tried to UPDATE/DELETE/TRUNCATE audit_event and the append-only trigger blocked it. Find the session in the PostgreSQL log.' });

    // --- API
    const apiId = workloads.httpApi.apiId;
    const apiMetric = (metricName: string, statistic: string): cloudwatch.Metric => new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName, statistic, period: fiveMin, dimensionsMap: { ApiId: apiId, Stage: '$default' } });
    add('Api5xx', { alarmName: 'api-5xx', metric: apiMetric('5xx', 'Sum'), threshold: 5, evaluationPeriods: 2, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'API returning 5xx.' });
    add('ApiLatencyP99', { alarmName: 'api-latency-p99', metric: apiMetric('Latency', 'p99'), threshold: 2000, evaluationPeriods: 3, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'API p99 latency above 2 s.' });

    // --- Master (owner) secret read by anyone other than migrate or its rotation Lambda.
    // Requires a CloudTrail trail recording read management events in this region: GetSecretValue is
    // a read-only event and only reaches EventBridge through such a trail. CloudFormation resolving the
    // secret during a cluster update also matches - expected, and correlated with a deployment.
    const stack = Stack.of(this);
    const migrateRole = workloads.migrate.fn.role;
    if (!migrateRole) throw new Error('migrate function has no role');
    const ownerSecretName = `${config.prefix}/db/owner`;
    this.masterSecretReadRule = new events.Rule(this, 'MasterSecretRead', {
      description: 'GetSecretValue on the owner secret by an unexpected principal',
      eventPattern: {
        source: ['aws.secretsmanager'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['secretsmanager.amazonaws.com'],
          eventName: ['GetSecretValue'],
          requestParameters: {
            secretId: [
              { prefix: ownerSecretName },
              { prefix: `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:${ownerSecretName}` },
            ],
          },
          userIdentity: {
            // Lambda sessions are named after the function; the role is pinned for migrate, while the
            // hosted rotation role is generated by the Secrets Manager transform and not addressable.
            arn: events.Match.anythingButWildcard(
              `arn:${stack.partition}:sts::${stack.account}:assumed-role/${migrateRole.roleName}/${workloads.migrate.fn.functionName}`,
              `arn:${stack.partition}:sts::${stack.account}:assumed-role/*/${database.ownerRotationFunctionName}`,
            ),
          },
        },
      },
      targets: [
        new targets.SnsTopic(this.topic, {
          message: events.RuleTargetInput.fromText(
            `Owner secret ${ownerSecretName} read by ${events.EventField.fromPath('$.detail.userIdentity.arn')} from ${events.EventField.fromPath('$.detail.sourceIPAddress')} at ${events.EventField.time}`,
          ),
        }),
      ],
    });

    // --- Dashboard
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: `${config.prefix}-audit-store` });
    const fns = [workloads.api, workloads.migrate, workloads.mvRefresh, workloads.digest, workloads.archiveExport, workloads.backfill];
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Aurora capacity (ACU) / utilisation %', left: [capacity], right: [acu], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'Connections / deadlocks', left: [connections], right: [deadlocks], width: 12 }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'API requests / 5xx', left: [apiMetric('Count', 'Sum')], right: [apiMetric('5xx', 'Sum'), apiMetric('4xx', 'Sum')], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'API latency p50 / p99', left: [apiMetric('Latency', 'p50'), apiMetric('Latency', 'p99')], width: 12 }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Function errors', left: fns.map((f) => f.fn.metricErrors({ period: fiveMin, label: f.fn.node.scope?.node.id ?? 'fn' })), width: 12 }),
      new cloudwatch.GraphWidget({
        title: 'Digest: mismatches / age (h) / row-id gaps',
        left: [customMetric('DigestMismatchCount', 'Maximum', Duration.hours(1)), customMetric('RowIdGapCount', 'Maximum', Duration.hours(1))],
        right: [customMetric('DigestAgeHours', 'Maximum', Duration.hours(1))],
        width: 12,
      }),
    );
    this.dashboard.addWidgets(new cloudwatch.GraphWidget({ title: 'Blocked audit_event mutations', left: [mutationAttempts], width: 24 }));
    this.dashboard.addWidgets(new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms: this.alarms, width: 24 }));
  }
}
