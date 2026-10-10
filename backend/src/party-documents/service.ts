/**
 * Party document service — the ONE orchestration layer for Party Documents.
 *
 * Upload pipeline (browser → multipart → this service):
 *   authenticate (route) → party authorization (route) → file validation
 *   → processing (image worker / PDF preserve) → checksum → encryption
 *   → R2 → party_documents row → response
 *
 * FAILURE / COMPENSATION CONTRACT (never silently swallow, never store
 * half of a document):
 *   A. validation fails        → nothing stored
 *   B. processing fails        → nothing stored
 *   C. R2 upload fails         → no database row
 *   D. R2 ok, DB insert fails  → the new R2 object is removed, error returned
 *   E. replace upload fails    → the old document stays active, unchanged
 *   F. replace created but the final DB operation fails
 *                              → the new row AND object are removed again so
 *                                the old active document remains the truth
 *
 * Documents are deliberately decoupled from sale transactions: a document
 * uploaded but not yet used by a trade-in is NOT an orphan — it is an
 * unused party document, manageable from Party Detail.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import { getLogger } from '../logging/logger.js';
import {
  currentKeyVersion,
  encryptDocumentFile,
  decryptDocumentFile,
  requireDocumentEncryption,
  sha256Hex,
} from './crypto.js';
import {
  deleteDocumentObject,
  documentStorageKey,
  getDocumentObject,
  putDocumentObject,
  requireDocumentStorage,
} from './storage.js';
import { classifyDocumentFile } from './validate.js';
import { processDocumentImage } from './image-worker.js';
import {
  archivePartyDocument,
  deletePartyDocumentRow,
  getPartyDocument,
  insertPartyDocument,
  listPartyDocuments,
  partyExists,
  type PartyDocumentFullRow,
  type PartyDocumentRow,
} from './repository.js';

/** Maximum stored length of the original filename (metadata only). */
const FILE_NAME_MAX = 255;

/** Normalize the user-provided filename to safe display metadata. */
export function normalizeFileName(name: string | undefined | null): string {
  const trimmed = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (trimmed.length === 0) return 'document';
  // Keep the extension readable; cap the total length.
  return trimmed.length > FILE_NAME_MAX ? trimmed.slice(0, FILE_NAME_MAX) : trimmed;
}

/** The processed, ready-to-store form of an uploaded file. */
interface ProcessedUpload {
  bytes: Buffer;
  mime: string;
}

/**
 * Validate + process one uploaded file (content-inspected, never trusting
 * the browser's hints):
 *   images → decode → EXIF-orient → cap at 2560px → re-encode JPEG
 *            (re-encoding strips all source metadata)
 *   PDFs   → structural validation, preserved byte-for-byte (never
 *            rasterized, never transformed)
 */
async function processUpload(bytes: Buffer): Promise<ProcessedUpload> {
  if (bytes.length === 0) {
    throw new AppError(ErrorCode.DOCUMENT_FILE_REQUIRED);
  }
  const cfg = getConfig();
  if (bytes.length > cfg.maxDocumentFileBytes) {
    throw new AppError(ErrorCode.DOCUMENT_FILE_TOO_LARGE, {
      message: `The document file exceeds the maximum allowed size (${Math.floor(cfg.maxDocumentFileBytes / (1024 * 1024))} MB).`,
    });
  }

  const classified = classifyDocumentFile(bytes);

  if (classified.kind === 'pdf') {
    return { bytes, mime: classified.mime };
  }

  try {
    const processed = await processDocumentImage(bytes);
    if (processed.jpeg.length === 0) {
      throw new Error('empty processed image');
    }
    // The stored image is the processed JPEG (orientation-corrected,
    // dimension-capped, metadata-free) — its ACTUAL type is image/jpeg.
    return { bytes: processed.jpeg, mime: 'image/jpeg' };
  } catch (err) {
    // The content sniffed as an image type but could not be decoded —
    // treat as an invalid file, never as a silently-accepted passthrough.
    throw new AppError(ErrorCode.DOCUMENT_FILE_INVALID, {
      message: 'The image file could not be processed. It may be corrupted.',
      internalDetails: {
        sniffed: classified.mime,
        cause: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/** The full creation step shared by upload and replace: process → encrypt
 *  → store in R2 → insert the row; on a row failure, remove the object
 *  (Case D compensation) and rethrow. Returns the persisted public row. */
async function createDocumentRow(
  db: SupabaseClient,
  partyId: string,
  rawFileName: string | undefined,
  bytes: Buffer,
): Promise<PartyDocumentRow> {
  const processed = await processUpload(bytes);
  const documentId = randomUUID();
  const storageKey = documentStorageKey(partyId, documentId);

  const encrypted = encryptDocumentFile(processed.bytes);

  // C. R2 failure → no database row, nothing stored.
  await putDocumentObject(storageKey, encrypted.ciphertext);

  try {
    return await insertPartyDocument(db, {
      id: documentId,
      party_id: partyId,
      file_name: normalizeFileName(rawFileName),
      mime_type: processed.mime,
      file_size: processed.bytes.length,
      checksum_sha256: encrypted.checksumSha256,
      storage_key: storageKey,
      encryption_alg: encrypted.material.encryption_alg,
      key_version: encrypted.material.key_version,
      encrypted_dek: encrypted.material.encrypted_dek,
      dek_iv: encrypted.material.dek_iv,
      dek_tag: encrypted.material.dek_tag,
      file_iv: encrypted.material.file_iv,
      file_tag: encrypted.material.file_tag,
    });
  } catch (err) {
    // D. Database failure after a successful upload → compensate.
    getLogger().error(
      { partyId, documentId, storageKey, cause: err instanceof Error ? err.message : String(err) },
      'party_documents insert failed after R2 upload — compensating (removing the new object)',
    );
    await deleteDocumentObject(storageKey);
    throw err;
  }
}

/** Fail-closed configuration gate for every document operation. */
function requireDocumentsConfigured(): void {
  requireDocumentStorage();
  requireDocumentEncryption();
}

// ── Public service operations ──────────────────────────────────────────────

/** List one party's documents (newest first). */
export async function listDocuments(
  db: SupabaseClient,
  partyId: string,
): Promise<PartyDocumentRow[]> {
  requireDocumentsConfigured();
  if (!(await partyExists(db, partyId))) {
    throw new AppError(ErrorCode.PARTY_NOT_FOUND, { internalDetails: { partyId } });
  }
  return listPartyDocuments(db, partyId);
}

/** Upload a new document for a party (active by definition). */
export async function uploadDocument(
  db: SupabaseClient,
  partyId: string,
  fileName: string | undefined,
  bytes: Buffer,
): Promise<PartyDocumentRow> {
  requireDocumentsConfigured();
  if (!(await partyExists(db, partyId))) {
    throw new AppError(ErrorCode.PARTY_NOT_FOUND, { internalDetails: { partyId } });
  }
  return createDocumentRow(db, partyId, fileName, bytes);
}

/** Replace one ACTIVE document: the new document is fully created first;
 *  only then does the old one become archived (never the reverse order).
 *  Historical trade-in references to the old document are untouched and
 *  remain resolvable forever. */
export async function replaceDocument(
  db: SupabaseClient,
  partyId: string,
  documentId: string,
  fileName: string | undefined,
  bytes: Buffer,
): Promise<{ document: PartyDocumentRow; archived: PartyDocumentRow }> {
  requireDocumentsConfigured();

  // The target must be an existing ACTIVE document of THIS party.
  const existing = await getPartyDocument(db, partyId, documentId);
  if (!existing) {
    throw new AppError(ErrorCode.DOCUMENT_NOT_FOUND, {
      internalDetails: { partyId, documentId },
    });
  }
  if (existing.status !== 'active') {
    throw new AppError(ErrorCode.API_REQUEST_INVALID, {
      message: 'Only an active document can be replaced.',
      internalDetails: { documentId, status: existing.status },
    });
  }

  // E. Any failure inside createDocumentRow leaves the old document
  //    completely untouched (it is only archived AFTER the new row exists).
  const created = await createDocumentRow(db, partyId, fileName, bytes);

  try {
    const archived = await archivePartyDocument(db, partyId, documentId);
    return { document: created, archived };
  } catch (err) {
    // F. Final DB operation failed → remove the new document completely so
    //    the old active document remains the single truth (no misleading
    //    "replacement completed" state).
    getLogger().error(
      { partyId, documentId, newDocumentId: created.id, cause: err instanceof Error ? err.message : String(err) },
      'Archiving the replaced document failed — rolling back the replacement (new document removed)',
    );
    try {
      await deletePartyDocumentRow(db, created.id);
    } catch (cleanupErr) {
      getLogger().error(
        { documentId: created.id, cause: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
        'Rollback row-delete failed — the new row may need manual review',
      );
    }
    await deleteDocumentObject(documentStorageKey(partyId, created.id));
    throw err;
  }
}

/** Archive one document (idempotent; nothing is ever deleted). */
export async function archiveDocument(
  db: SupabaseClient,
  partyId: string,
  documentId: string,
): Promise<PartyDocumentRow> {
  requireDocumentsConfigured();
  return archivePartyDocument(db, partyId, documentId);
}

/** The decrypted, integrity-verified file for preview/download. */
export interface DocumentFile {
  row: PartyDocumentRow;
  plaintext: Buffer;
}

/** Fetch + decrypt + verify one document (preview and download share this
 *  exact secure path; the route decides inline vs attachment headers). */
export async function getDocumentFile(
  db: SupabaseClient,
  partyId: string,
  documentId: string,
): Promise<DocumentFile> {
  requireDocumentsConfigured();

  // Party-scoped resolution: a document of another party is simply not
  // found — ownership is verified, never merely trusted from the id.
  const row: PartyDocumentFullRow | null = await getPartyDocument(db, partyId, documentId);
  if (!row) {
    throw new AppError(ErrorCode.DOCUMENT_NOT_FOUND, {
      internalDetails: { partyId, documentId },
    });
  }

  const encrypted = await getDocumentObject(row.storage_key);
  const plaintext = decryptDocumentFile(encrypted, {
    encryption_alg: row.encryption_alg,
    key_version: row.key_version,
    encrypted_dek: row.encrypted_dek,
    dek_iv: row.dek_iv,
    dek_tag: row.dek_tag,
    file_iv: row.file_iv,
    file_tag: row.file_tag,
  });

  // Integrity: the stored checksum must match the decrypted plaintext.
  if (sha256Hex(plaintext) !== row.checksum_sha256) {
    throw new AppError(ErrorCode.DOCUMENT_STORAGE_CORRUPTED, {
      internalDetails: { documentId, reason: 'checksum mismatch after decryption' },
    });
  }

  return {
    row: {
      id: row.id,
      party_id: row.party_id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size: row.file_size,
      checksum_sha256: row.checksum_sha256,
      status: row.status,
      created_at: row.created_at,
      archived_at: row.archived_at,
    },
    plaintext,
  };
}

/** Re-exported for route-level fail-closed checks. */
export { currentKeyVersion };
