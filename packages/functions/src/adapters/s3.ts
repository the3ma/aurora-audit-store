import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { ObjectExistsError, ObjectNotFoundError, type ObjectStore } from '../ports.js';

function isStatus(error: unknown, ...statuses: number[]): boolean {
  return (
    error instanceof S3ServiceException && statuses.includes(error.$metadata.httpStatusCode ?? 0)
  );
}

export function s3Client(): S3Client {
  // LocalStack serves every bucket on one host, so virtual-hosted addressing would not resolve.
  return new S3Client({ forcePathStyle: Boolean(process.env['AWS_ENDPOINT_URL']) });
}

export function s3ObjectStore(client: S3Client = s3Client()): ObjectStore {
  const get = async (bucket: string, key: string) => {
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!(out.Body instanceof Readable)) throw new Error(`unexpected body type for ${key}`);
      return out.Body;
    } catch (error) {
      if (isStatus(error, 404)) throw new ObjectNotFoundError(key);
      throw error;
    }
  };

  return {
    getStream: get,
    getText: async (bucket, key) => {
      const chunks: Buffer[] = [];
      for await (const chunk of await get(bucket, key)) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    putIfAbsent: async (bucket, key, body, contentType) => {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            // S3 conditional write: the evidence object can be created once and never replaced.
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (isStatus(error, 409, 412)) throw new ObjectExistsError(key);
        throw error;
      }
    },
    listKeys: async function* (bucket, prefix) {
      let token: string | undefined;
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of out.Contents ?? []) if (object.Key) yield object.Key;
        token = out.NextContinuationToken;
      } while (token);
    },
  };
}
