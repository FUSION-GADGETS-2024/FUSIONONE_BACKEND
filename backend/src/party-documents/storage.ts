/**
 * Party document storage — the ONLY R2 access point in the application.
 *
 * The bucket (fusionone-documents) is PRIVATE: objects are never exposed
 * via public URLs or presigned URLs; the browser never holds R2
 * credentials and never talks to R2. Every byte flows through this module:
 *
 *   upload  : putObject (application/octet-stream — the payload is
 *             application-level encrypted before it ever leaves the server)
 *   read    : getObject → buffered bytes (decryption + integrity check
 *             happen in the service layer before anything is returned)
 *   delete  : deleteObject — compensation ONLY (a failed database write
 *             after a successful upload must not leave an orphaned object)
 *
 * Configuration is fail-closed: when R2 credentials are not configured the
 * document endpoints reject with DOCUMENTS_NOT_CONFIGURED instead of
 * silently falling back to anything.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/logger.js';
import { AppError, ErrorCode } from '../errors/registry.js';

let client: S3Client | null = null;

/** The R2 S3 endpoint (https://<account-id>.r2.cloudflarestorage.com). */
function endpointUrl(): string {
  const cfg = getConfig();
  return `https://${cfg.r2AccountId}.r2.cloudflarestorage.com`;
}

/** The single S3 client (created lazily; region 'auto' per R2 convention). */
function getClient(): S3Client {
  if (!client) {
    const cfg = getConfig();
    client = new S3Client({
      region: 'auto',
      endpoint: endpointUrl(),
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.r2AccessKeyId,
        secretAccessKey: cfg.r2SecretAccessKey,
      },
    });
  }
  return client;
}

/** Whether document storage is fully configured (fail-closed gate). */
export function isDocumentStorageConfigured(): boolean {
  const cfg = getConfig();
  return (
    cfg.r2AccountId.length > 0 &&
    cfg.r2AccessKeyId.length > 0 &&
    cfg.r2SecretAccessKey.length > 0 &&
    cfg.r2Bucket.length > 0
  );
}

/** Require a fully configured document storage (fail closed with a clear
 *  error — the message-scheduler unconfigured convention). */
export function requireDocumentStorage(): void {
  if (!isDocumentStorageConfigured()) {
    throw new AppError(ErrorCode.DOCUMENTS_NOT_CONFIGURED, {
      internalDetails: { reason: 'R2 credentials not configured' },
    });
  }
}

/** Map a storage-layer failure to the canonical storage-unavailable error
 *  (internal details logged, never exposed). */
function storageFailure(op: string, err: unknown): AppError {
  return new AppError(ErrorCode.DOCUMENT_STORAGE_UNAVAILABLE, {
    internalDetails: {
      op,
      cause: err instanceof Error ? err.message : String(err),
    },
    cause: err,
  });
}

/** The deterministic storage key for one party document:
 *  party-documents/<party-id>/<document-id> — unique, independent of any
 *  user-provided filename, path-traversal-safe (both components are
 *  application-generated UUIDs), and operationally greppable. */
export function documentStorageKey(partyId: string, documentId: string): string {
  return `party-documents/${partyId}/${documentId}`;
}

/** Store an (already encrypted) document object. */
export async function putDocumentObject(
  storageKey: string,
  encrypted: Buffer,
): Promise<void> {
  requireDocumentStorage();
  const cfg = getConfig();
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: cfg.r2Bucket,
        Key: storageKey,
        Body: encrypted,
        ContentType: 'application/octet-stream',
      }),
    );
  } catch (err) {
    throw storageFailure('putObject', err);
  }
}

/** Fetch a document object's raw (still encrypted) bytes. */
export async function getDocumentObject(storageKey: string): Promise<Buffer> {
  requireDocumentStorage();
  const cfg = getConfig();
  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: cfg.r2Bucket, Key: storageKey }),
    );
    if (!res.Body) {
      throw new AppError(ErrorCode.DOCUMENT_STORAGE_CORRUPTED, {
        internalDetails: { storageKey, reason: 'empty object body' },
      });
    }
    // Buffer the streamed body (documents are bounded by the upload limit;
    // decryption + integrity verification happen before any response).
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw storageFailure('getObject', err);
  }
}

/** Remove a document object — compensation for a failed database write
 *  after a successful upload (never part of normal lifecycle: archived
 *  documents keep their objects forever). Best-effort but LOUD: a leaked
 *  ENCRYPTED object is preferable to masking the original failure, and the
 *  log identifies the key for manual cleanup. */
export async function deleteDocumentObject(storageKey: string): Promise<void> {
  requireDocumentStorage();
  const cfg = getConfig();
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: cfg.r2Bucket, Key: storageKey }),
    );
  } catch (err) {
    getLogger().error(
      { storageKey, cause: err instanceof Error ? err.message : String(err) },
      'Document compensation delete failed (object may need manual cleanup)',
    );
  }
}
