/**
 * Party document encryption — application-level AES-256-GCM envelope
 * encryption (R2 at-rest encryption is NOT relied upon).
 *
 *   random 32-byte DEK (per document, never stored in the clear)
 *     → encrypts the processed file (unique 12-byte IV, 16-byte GCM tag)
 *     → the DEK itself is wrapped with the backend-only MASTER KEY of the
 *       current key_version (also AES-256-GCM, its own IV + tag)
 *     → R2 receives only ciphertext; the database stores the wrapped DEK,
 *       the IVs/tags, the algorithm name and the key version
 *
 * Key rotation: the master key comes from the environment; key_version is
 * written alongside every document. Decryption selects the master key by
 * version (the current key today; future keys migrate documents one
 * version at a time without redesigning the model).
 *
 * SECURITY: the master key and the wrapped DEKs are never logged, never
 * serialized into any response, and never exposed to any frontend.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { getConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../errors/registry.js';

const ALGORITHM = 'AES-256-GCM';
const IV_BYTES = 12; // GCM standard nonce size
const KEY_BYTES = 32; // AES-256

/** The encryption material persisted with a document row (base64 fields —
 *  everything needed to decrypt except the master key itself). */
export interface DocumentEncryptionMaterial {
  encryption_alg: string;
  key_version: number;
  encrypted_dek: string;
  dek_iv: string;
  dek_tag: string;
  file_iv: string;
  file_tag: string;
}

/** The result of encrypting one document file. */
export interface EncryptedDocument {
  /** The ciphertext buffer to store in R2 (IV is NOT prepended — the IVs
   *  and tags live as database metadata columns). */
  ciphertext: Buffer;
  material: DocumentEncryptionMaterial;
  /** SHA-256 of the PLAINTEXT (integrity reference for retrieval). */
  checksumSha256: string;
}

/** Decode + validate the configured master key (base64, exactly 32 bytes). */
function masterKey(version: number): Buffer {
  const cfg = getConfig();
  if (cfg.documentsMasterKey.length === 0) {
    throw new AppError(ErrorCode.DOCUMENTS_NOT_CONFIGURED, {
      internalDetails: { reason: 'DOCUMENTS_MASTER_KEY missing' },
    });
  }
  // Only version 1 exists today; future rotations add version selection.
  if (version !== 1) {
    throw new AppError(ErrorCode.DOCUMENT_STORAGE_CORRUPTED, {
      internalDetails: { reason: 'unknown key_version', keyVersion: version },
    });
  }
  const key = Buffer.from(cfg.documentsMasterKey, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new AppError(ErrorCode.DOCUMENTS_NOT_CONFIGURED, {
      internalDetails: { reason: 'DOCUMENTS_MASTER_KEY must be base64 of 32 bytes' },
    });
  }
  return key;
}

/** Require the encryption configuration (fail closed — same convention as
 *  the storage gate; both must be configured for document endpoints). */
export function requireDocumentEncryption(): void {
  masterKey(1);
}

/** The current key version (the version written for NEW documents). */
export function currentKeyVersion(): number {
  return 1;
}

/** SHA-256 of the plaintext bytes (hex) — the stored integrity reference. */
export function sha256Hex(plaintext: Buffer): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Encrypt one document file with a fresh per-document DEK. */
export function encryptDocumentFile(plaintext: Buffer): EncryptedDocument {
  const keyVersion = currentKeyVersion();
  const mk = masterKey(keyVersion);

  // 1. Per-document data encryption key (random, never persisted in clear).
  const dek = randomBytes(KEY_BYTES);

  // 2. Encrypt the file with the DEK.
  const fileIv = randomBytes(IV_BYTES);
  const fileCipher = createCipheriv('aes-256-gcm', dek, fileIv);
  const ciphertext = Buffer.concat([
    fileCipher.update(plaintext),
    fileCipher.final(),
  ]);
  const fileTag = fileCipher.getAuthTag();

  // 3. Wrap the DEK with the master key (envelope encryption).
  const dekIv = randomBytes(IV_BYTES);
  const dekCipher = createCipheriv('aes-256-gcm', mk, dekIv);
  const encryptedDek = Buffer.concat([
    dekCipher.update(dek),
    dekCipher.final(),
  ]);
  const dekTag = dekCipher.getAuthTag();

  return {
    ciphertext,
    material: {
      encryption_alg: ALGORITHM,
      key_version: keyVersion,
      encrypted_dek: encryptedDek.toString('base64'),
      dek_iv: dekIv.toString('base64'),
      dek_tag: dekTag.toString('base64'),
      file_iv: fileIv.toString('base64'),
      file_tag: fileTag.toString('base64'),
    },
    checksumSha256: sha256Hex(plaintext),
  };
}

/** Decrypt a stored document file. The caller re-verifies the plaintext
 *  checksum afterwards (integrity is the service layer's decision). */
export function decryptDocumentFile(
  encrypted: Buffer,
  material: DocumentEncryptionMaterial,
): Buffer {
  if (material.encryption_alg !== ALGORITHM) {
    throw new AppError(ErrorCode.DOCUMENT_STORAGE_CORRUPTED, {
      internalDetails: { reason: 'unknown encryption algorithm', alg: material.encryption_alg },
    });
  }
  const mk = masterKey(material.key_version);

  // 1. Unwrap the DEK (master key) — GCM verifies authenticity here.
  let dek: Buffer;
  try {
    const dekIv = Buffer.from(material.dek_iv, 'base64');
    const dekTag = Buffer.from(material.dek_tag, 'base64');
    const dekDecipher = createDecipheriv('aes-256-gcm', mk, dekIv);
    dekDecipher.setAuthTag(dekTag);
    dek = Buffer.concat([
      dekDecipher.update(Buffer.from(material.encrypted_dek, 'base64')),
      dekDecipher.final(),
    ]);
  } catch {
    throw new AppError(ErrorCode.DOCUMENT_STORAGE_CORRUPTED, {
      internalDetails: { reason: 'DEK unwrap failed (wrong master key or tampered metadata)' },
    });
  }

  // 2. Decrypt the file with the DEK — GCM verifies authenticity again.
  try {
    const fileIv = Buffer.from(material.file_iv, 'base64');
    const fileTag = Buffer.from(material.file_tag, 'base64');
    const fileDecipher = createDecipheriv('aes-256-gcm', dek, fileIv);
    fileDecipher.setAuthTag(fileTag);
    return Buffer.concat([
      fileDecipher.update(encrypted),
      fileDecipher.final(),
    ]);
  } catch {
    throw new AppError(ErrorCode.DOCUMENT_STORAGE_CORRUPTED, {
      internalDetails: { reason: 'file decryption failed (tampered object or metadata)' },
    });
  }
}
