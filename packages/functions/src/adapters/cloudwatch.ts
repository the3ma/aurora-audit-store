import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { METRIC_NAMESPACE, type MetricsSink } from '../ports.js';

export function cloudWatchMetrics(client = new CloudWatchClient({})): MetricsSink {
  return {
    publish: async (metrics) => {
      if (metrics.length === 0) return;
      const timestamp = new Date();
      await client.send(
        new PutMetricDataCommand({
          Namespace: METRIC_NAMESPACE,
          MetricData: metrics.map((m) => ({
            MetricName: m.name,
            Value: m.value,
            Unit: m.unit,
            Timestamp: timestamp,
          })),
        }),
      );
    },
  };
}
