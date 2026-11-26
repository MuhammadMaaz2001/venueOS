import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';

/** How long a download link works (docs/04 section 6: pre-signed GET valid 5 minutes). */
export const DOWNLOAD_URL_SECONDS = 300;

const KEY_PATTERN = /^tenants\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._\-/]{1,400}$/;

export class StorageNotConfiguredError extends Error {
  constructor() {
    super('STORAGE_NOT_CONFIGURED');
    this.name = 'StorageNotConfiguredError';
  }
}

const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac('sha256', key).update(value).digest();

/**
 * Pre-signed download links for private objects (docs/04 section 6): a SigV4 query-string signature over a GET of one object
 * key, valid for 5 minutes. The key must be `tenants/{tenantId}/...` AND belong to the caller's tenant: the API checks the
 * tenant before signing. Credentials come from the AWS default provider chain (the ECS task role in AWS; the local store's
 * keys in development), never from our own variables.
 *
 * Built on the SDK's own client (for its credential chain and endpoint settings) with the signing done here, so no extra
 * dependency is needed for one GET.
 */
@Injectable()
export class PresignService {
  private client: S3Client | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private s3(): S3Client {
    this.client ??= new S3Client({
      region: this.config.S3_REGION,
      ...(this.config.S3_ENDPOINT ? { endpoint: this.config.S3_ENDPOINT } : {}),
      forcePathStyle: this.config.S3_FORCE_PATH_STYLE,
    });
    return this.client;
  }

  /** The signed URL for `key`, which must belong to `tenantId`. `filename` becomes the download name. */
  async downloadUrl(
    tenantId: string,
    key: string,
    filename: string,
    now: Date = new Date(),
  ): Promise<string> {
    const bucket = this.config.S3_BUCKET;
    if (!bucket) throw new StorageNotConfiguredError();
    if (
      !KEY_PATTERN.test(key) ||
      !key.startsWith(`tenants/${tenantId}/`) ||
      key.split('/').some((p) => p === '' || p === '.' || p === '..')
    ) {
      throw new Error('INVALID_OBJECT_KEY');
    }
    const credentials = await this.s3().config.credentials();
    const region = this.config.S3_REGION;

    const endpoint = new URL(this.config.S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`);
    const pathStyle = this.config.S3_FORCE_PATH_STYLE;
    const host = pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
    const basePath = pathStyle ? `/${rfc3986(bucket)}` : '';
    const canonicalUri = `${basePath}/${key.split('/').map(rfc3986).join('/')}`;

    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${region}/s3/aws4_request`;
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(DOWNLOAD_URL_SECONDS),
      'X-Amz-SignedHeaders': 'host',
      'response-content-disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._ -]/g, '_')}"`,
      'response-content-type': 'application/pdf',
      ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(query[k] as string)}`)
      .join('&');
    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQuery,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
      '\n',
    );
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return `${endpoint.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  close(): void {
    this.client?.destroy();
  }
}
