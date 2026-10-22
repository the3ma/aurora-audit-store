import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { functionLogger, requireEnv } from '../runtime.js';

const logger = functionLogger('master-secret-alert');
const sns = new SNSClient({});

export interface EventBridgeEvent {
  'detail-type'?: string;
  source?: string;
  time?: string;
  region?: string;
  account?: string;
  detail?: {
    eventName?: string;
    eventTime?: string;
    sourceIPAddress?: string;
    userIdentity?: { arn?: string; type?: string };
    requestParameters?: { secretId?: string } | null;
  };
}

/** Human-readable summary of an owner-secret access/rotation event, safe to send to a chat channel. */
export function formatAlert(event: EventBridgeEvent): { subject: string; message: string } {
  const d = event.detail ?? {};
  const action = d.eventName ?? event['detail-type'] ?? 'unknown event';
  const lines = [
    `Owner database secret: ${action}`,
    `When:   ${d.eventTime ?? event.time ?? 'unknown'}`,
    `Who:    ${d.userIdentity?.arn ?? d.userIdentity?.type ?? 'unknown'}`,
    `From:   ${d.sourceIPAddress ?? 'unknown'}`,
    `Secret: ${d.requestParameters?.secretId ?? 'unknown'}`,
    `Region: ${event.region ?? 'unknown'}`,
    '',
    'The owner credential is break-glass only. If this access was not expected, follow the',
    'credential-compromise runbook and rotate the secret.',
  ];
  return {
    subject: `[audit-store] owner secret ${action}`.slice(0, 100),
    message: lines.join('\n'),
  };
}

export async function handler(event: EventBridgeEvent): Promise<void> {
  const { subject, message } = formatAlert(event);
  logger.warn('owner secret alert', { subject });
  await sns.send(
    new PublishCommand({
      TopicArn: requireEnv('ALERT_TOPIC_ARN'),
      Subject: subject,
      Message: message,
    }),
  );
}
