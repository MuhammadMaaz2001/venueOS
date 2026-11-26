import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { WorkerConfig } from '../config/config.module';
import { StorageError } from './object-storage';
import type { ObjectStorage } from './object-storage';

/**
 * S3 (production) or any S3-compatible store (local SeaweedFS: `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE`).
 *
 * Credentials come from the AWS default provider chain and are never read from our own variables: in
 * staging/production that is the ECS task role; locally `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in
 * `.env` are for the local store only (docs/08). Objects are written with server-side encryption (`S3_SSE`, `none` only
 * for the local store, which has no KMS).
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: Pick<
      WorkerConfig,
      'S3_BUCKET' | 'S3_ENDPOINT' | 'S3_FORCE_PATH_STYLE' | 'S3_SSE' | 'S3_REGION'
    >,
  ) {
    this.client = new S3Client({
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      // The SDK retries transient errors itself; the job retries the rest with its own backoff.
      maxAttempts: 2,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
          ...(this.config.S3_SSE === 'none' ? {} : { ServerSideEncryption: this.config.S3_SSE }),
        }),
      );
    } catch {
      // The SDK's message can carry the endpoint, bucket and request ids: say nothing of it.
      throw new StorageError();
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
      );
      if (!out.Body) throw new Error('empty');
      return Buffer.from(await out.Body.transformToByteArray());
    } catch {
      throw new StorageError();
    }
  }

  close(): void {
    this.client.destroy();
  }
}
