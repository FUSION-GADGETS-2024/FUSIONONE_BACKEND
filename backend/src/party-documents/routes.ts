/**
 * Party document routes — the party-scoped HTTP surface. The document
 * domain is expressed ONLY through the Party resource:
 *
 *   GET  /api/parties/:partyId/documents                              (list)
 *   POST /api/parties/:partyId/documents                              (upload, multipart)
 *   GET  /api/parties/:partyId/documents/:documentId/preview          (inline)
 *   GET  /api/parties/:partyId/documents/:documentId/download         (attachment)
 *   POST /api/parties/:partyId/documents/:documentId/replace          (multipart)
 *   POST /api/parties/:partyId/documents/:documentId/archive
 *
 * There is deliberately NO /api/documents route of any kind. Every request
 * re-verifies document.party_id === :partyId — a document id alone never
 * suffices. The browser never receives storage credentials, encryption
 * keys, object paths or public URLs: previews/downloads are streamed as
 * decrypted plaintext with inline/attachment disposition.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import { requireAuthorizedUser } from '../api/authorize.js';
import { getUserClient } from '../supabase/clients.js';
import {
  archiveDocument,
  getDocumentFile,
  listDocuments,
  replaceDocument,
  uploadDocument,
} from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AppError(ErrorCode.API_REQUEST_INVALID, {
      message: `A valid ${label} is required.`,
    });
  }
  return value;
}

/** RFC 6266 quoted-string escape for Content-Disposition filenames. */
function dispositionFilename(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\]/g, '_');
  return encodeURIComponent(cleaned).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** The multipart file part shape used by readMultipartFile (the plugin is
 *  registered in api/server.ts; this local shape keeps the contract
 *  explicit without depending on module augmentation). */
interface MultipartFilePart {
  filename: string;
  file: AsyncIterable<Buffer>;
}

/** Read the single 'file' part of a multipart request with the size limit
 *  enforced WHILE STREAMING (never after buffering). */
async function readMultipartFile(req: FastifyRequest): Promise<{ fileName: string | undefined; bytes: Buffer }> {
  const cfg = getConfig();

  let file: MultipartFilePart | undefined;
  try {
    file = (await (req as unknown as { file: () => Promise<MultipartFilePart | undefined> }).file()) ?? undefined;
  } catch {
    throw new AppError(ErrorCode.DOCUMENT_FILE_REQUIRED, {
      message: 'A document file is required (multipart/form-data with a file field).',
    });
  }
  if (!file || !file.file) {
    throw new AppError(ErrorCode.DOCUMENT_FILE_REQUIRED);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = file.file as AsyncIterable<Buffer>;
  try {
    for await (const chunk of reader) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > cfg.maxDocumentFileBytes) {
        throw new AppError(ErrorCode.DOCUMENT_FILE_TOO_LARGE, {
          message: `The document file exceeds the maximum allowed size (${Math.floor(cfg.maxDocumentFileBytes / (1024 * 1024))} MB).`,
        });
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // The multipart stream failed mid-read (e.g. client abort / plugin
    // limit) — nothing was stored.
    throw new AppError(ErrorCode.DOCUMENT_FILE_INVALID, {
      message: 'The upload was interrupted. Please try again.',
      internalDetails: { cause: err instanceof Error ? err.message : String(err) },
    });
  }

  if (total === 0) {
    throw new AppError(ErrorCode.DOCUMENT_FILE_REQUIRED);
  }
  return { fileName: file.filename, bytes: Buffer.concat(chunks) };
}

/** Send a decrypted document with the requested disposition. */
async function sendDocument(
  req: FastifyRequest,
  reply: FastifyReply,
  disposition: 'inline' | 'attachment',
): Promise<void> {
  const user = await requireAuthorizedUser(req);
  const params = req.params as { partyId?: string; documentId?: string };
  const partyId = requireUuid(params?.partyId, 'party id');
  const documentId = requireUuid(params?.documentId, 'document id');

  const file = await getDocumentFile(getUserClient(user.token), partyId, documentId);

  reply.header('Content-Type', file.row.mime_type);
  reply.header('Content-Length', file.plaintext.length);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', 'private, no-store');
  reply.header(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${dispositionFilename(file.row.file_name)}`,
  );
  reply.code(200).send(file.plaintext);
}

/** Register every party-document route on the existing app instance. */
export async function registerPartyDocumentRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/parties/:partyId/documents — the party's document list.
  app.get('/api/parties/:partyId/documents', async (req: FastifyRequest) => {
    const user = await requireAuthorizedUser(req);
    const partyId = requireUuid((req.params as { partyId?: string })?.partyId, 'party id');
    const documents = await listDocuments(getUserClient(user.token), partyId);
    return { documents };
  });

  // POST /api/parties/:partyId/documents — upload a new document.
  app.post(
    '/api/parties/:partyId/documents',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await requireAuthorizedUser(req);
      const partyId = requireUuid((req.params as { partyId?: string })?.partyId, 'party id');
      const { fileName, bytes } = await readMultipartFile(req);
      const document = await uploadDocument(getUserClient(user.token), partyId, fileName, bytes);
      reply.code(201).send({ document });
    },
  );

  // GET /api/parties/:partyId/documents/:documentId/preview — inline render.
  app.get(
    '/api/parties/:partyId/documents/:documentId/preview',
    async (req: FastifyRequest, reply: FastifyReply) => {
      await sendDocument(req, reply, 'inline');
    },
  );

  // GET /api/parties/:partyId/documents/:documentId/download — attachment.
  app.get(
    '/api/parties/:partyId/documents/:documentId/download',
    async (req: FastifyRequest, reply: FastifyReply) => {
      await sendDocument(req, reply, 'attachment');
    },
  );

  // POST /api/parties/:partyId/documents/:documentId/replace — upload the
  // replacement; the old document becomes archived only on full success.
  app.post(
    '/api/parties/:partyId/documents/:documentId/replace',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await requireAuthorizedUser(req);
      const params = req.params as { partyId?: string; documentId?: string };
      const partyId = requireUuid(params?.partyId, 'party id');
      const documentId = requireUuid(params?.documentId, 'document id');
      const { fileName, bytes } = await readMultipartFile(req);
      const result = await replaceDocument(
        getUserClient(user.token),
        partyId,
        documentId,
        fileName,
        bytes,
      );
      reply.code(200).send(result);
    },
  );

  // POST /api/parties/:partyId/documents/:documentId/archive — active →
  // archived (idempotent; nothing is deleted, ever).
  app.post(
    '/api/parties/:partyId/documents/:documentId/archive',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await requireAuthorizedUser(req);
      const params = req.params as { partyId?: string; documentId?: string };
      const partyId = requireUuid(params?.partyId, 'party id');
      const documentId = requireUuid(params?.documentId, 'document id');
      const document = await archiveDocument(getUserClient(user.token), partyId, documentId);
      reply.code(200).send({ document });
    },
  );
}
