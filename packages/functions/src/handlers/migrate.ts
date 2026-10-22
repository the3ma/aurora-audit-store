import { describeError, ProofFailedError } from '@audit/core';
import { runMigrate } from '../migrate/run.js';
import { functionLogger, sharedDatabase } from '../runtime.js';

/** Shape of the custom-resources Provider `onEvent` request (subset we use). */
export interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties?: { MigrationsChecksum?: string };
}

export interface CustomResourceResponse {
  PhysicalResourceId: string;
  Data?: { Applied: string; Proofs: string };
}

export const PHYSICAL_RESOURCE_ID = 'audit-schema';

const logger = functionLogger('migrate');

export async function handler(event: CustomResourceEvent): Promise<CustomResourceResponse> {
  logger.info('custom resource event', {
    requestType: event.RequestType,
    migrationsChecksum: event.ResourceProperties?.MigrationsChecksum,
  });

  // Deleting the stack (or replacing the resource) must never drop audit data.
  if (event.RequestType === 'Delete') return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };

  try {
    const result = await runMigrate(sharedDatabase('migrate', logger, 120_000), logger);
    for (const proof of result.proofs) logger.info('proof', { ...proof });
    return {
      PhysicalResourceId: PHYSICAL_RESOURCE_ID,
      Data: { Applied: result.Applied, Proofs: result.Proofs },
    };
  } catch (error) {
    if (error instanceof ProofFailedError) {
      for (const proof of error.results) logger.error('proof', { ...proof });
    }
    // This message is what CloudFormation shows in the stack events, so it must be scrubbed.
    const { message, code } = describeError(error);
    logger.error('migration failed', { code, message });
    throw new Error(code === undefined ? message : `${message} (SQLSTATE ${code})`);
  }
}
