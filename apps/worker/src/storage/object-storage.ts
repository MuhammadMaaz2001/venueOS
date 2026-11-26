/** Injection token for the object store generated files go to. Tests override it. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** The store could not take the object (network, credentials, bucket missing). Retried. Code only, never S3 text. */
export class StorageError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor() {
    super('STORAGE_UNAVAILABLE');
    this.name = 'StorageError';
  }
}

/** The key is not a tenant file key (`tenants/{tenantId}/...`). A bug in the caller: permanent. */
export class InvalidObjectKeyError extends Error {
  constructor() {
    super('INVALID_OBJECT_KEY');
    this.name = 'InvalidObjectKeyError';
  }
}

const KEY_PATTERN = /^tenants\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._\-/]{1,400}$/;

/** Throws unless `key` is `tenants/{tenantId}/...` with no `..`, no empty segment and no leading slash. */
export function assertTenantObjectKey(key: string, tenantId: string): void {
  if (
    !KEY_PATTERN.test(key) ||
    !key.startsWith(`tenants/${tenantId}/`) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new InvalidObjectKeyError();
  }
}

/**
 * Private object storage (docs/02, docs/04 section 6). The database stores the KEY, never a URL; the browser
 * gets short-lived pre-signed URLs from the API, never from here.
 */
export interface ObjectStorage {
  /** Store (or overwrite) one object. Throws `StorageError` on any failure. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Read one object (an email attachment). Throws `StorageError` on any failure, a missing object included. */
  get(key: string): Promise<Buffer>;
}
