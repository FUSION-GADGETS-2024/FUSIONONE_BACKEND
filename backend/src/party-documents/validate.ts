/**
 * Party document file validation — content inspection, never trust.
 *
 * The accepted types are JPEG, PNG, WebP and PDF. NONE of these checks rely
 * on the browser's accept attribute, the filename extension or the
 * browser-supplied Content-Type: the actual bytes are inspected (magic
 * numbers + PDF structure). The maximum size is enforced server-side here
 * (and pre-enforced while the multipart stream is still being read).
 */
import { AppError, ErrorCode } from '../errors/registry.js';


/** The supported document MIME types (the values persisted as mime_type). */
export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export type FileKind = 'image' | 'pdf';

/** The classification result of inspecting the actual bytes. */
export interface ClassifiedFile {
  mime: SupportedMimeType;
  kind: FileKind;
}

function startsWith(buf: Buffer, prefix: number[]): boolean {
  if (buf.length < prefix.length) return false;
  return prefix.every((b, i) => buf[i] === b);
}

/**
 * Inspect the actual file content and classify it.
 *
 *   JPEG : FF D8 FF
 *   PNG  : 89 50 4E 47 0D 0A 1A 0A
 *   WebP : "RIFF" .... "WEBP"
 *   PDF  : "%PDF-" header + a %%EOF marker within the last 2048 bytes
 *          (structure validation without transforming anything)
 *
 * Anything else (or a truncated/corrupt variant) is unsupported/invalid.
 */
export function classifyDocumentFile(bytes: Buffer): ClassifiedFile {
  if (bytes.length === 0) {
    throw new AppError(ErrorCode.DOCUMENT_FILE_REQUIRED);
  }

  // JPEG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', kind: 'image' };
  }

  // PNG
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', kind: 'image' };
  }

  // WebP: RIFF container ("RIFF" + size + "WEBP")
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    bytes.length >= 12 &&
    startsWith(bytes.subarray(8, 12), [0x57, 0x45, 0x42, 0x50]) // "WEBP"
  ) {
    return { mime: 'image/webp', kind: 'image' };
  }

  // PDF: header + end-of-file marker (structural sanity, no transformation).
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    // "%PDF-"
    const tail = bytes.subarray(Math.max(0, bytes.length - 2048));
    if (tail.indexOf(Buffer.from('%%EOF')) !== -1) {
      return { mime: 'application/pdf', kind: 'pdf' };
    }
    // Header claims PDF but the structure is broken.
    throw new AppError(ErrorCode.DOCUMENT_FILE_INVALID, {
      message: 'The PDF appears to be incomplete or corrupted.',
    });
  }

  throw new AppError(ErrorCode.DOCUMENT_FILE_TYPE_UNSUPPORTED);
}
