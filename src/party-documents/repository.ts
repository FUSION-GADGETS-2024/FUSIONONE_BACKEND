/**
 * Party document repository — authoritative Supabase access for the
 * party_documents entity, always under the CALLER's JWT + RLS (the same
 * boundary as the invoice document repository). The service layer owns the
 * storage/encryption decisions; this layer owns rows.
 *
 * Every accessor takes a SupabaseClient so route handlers pass the
 * requesting user's client (RLS enforces the app-user boundary) — identity
 * never comes from request bodies.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError, ErrorCode } from '../errors/registry.js';

/** The public row shape of a party document (metadata only — the
 *  encryption material is read internally by the service, never returned
 *  to any client). */
export interface PartyDocumentRow {
  id: string;
  party_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  checksum_sha256: string;
  status: 'active' | 'archived';
  created_at: string;
  archived_at: string | null;
}

/** The full row (including envelope-encryption material) — internal to the
 *  backend service; NEVER serialized into any API response. */
export interface PartyDocumentFullRow extends PartyDocumentRow {
  storage_key: string;
  encryption_alg: string;
  key_version: number;
  encrypted_dek: string;
  dek_iv: string;
  dek_tag: string;
  file_iv: string;
  file_tag: string;
}

const PUBLIC_COLUMNS =
  'id, party_id, file_name, mime_type, file_size, checksum_sha256, status, created_at, archived_at';
const FULL_COLUMNS =
  `${PUBLIC_COLUMNS}, storage_key, encryption_alg, key_version, encrypted_dek, dek_iv, dek_tag, file_iv, file_tag`;

function pgError(step: string, message: string): AppError {
  return new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
    internalDetails: { step, pgError: message },
  });
}

/** Load one party's documents (newest first) under the caller's identity. */
export async function listPartyDocuments(
  db: SupabaseClient,
  partyId: string,
): Promise<PartyDocumentRow[]> {
  const { data, error } = await db
    .from('party_documents')
    .select(PUBLIC_COLUMNS)
    .eq('party_id', partyId)
    .order('created_at', { ascending: false });
  if (error) throw pgError('party_documents.select', error.message);
  return (data ?? []) as unknown as PartyDocumentRow[];
}

/** Load one full document row (metadata + encryption material) for the
 *  given party — the caller MUST verify party ownership (this is the
 *  party-scoped access contract: a document of ANOTHER party is simply
 *  "not found" here). */
export async function getPartyDocument(
  db: SupabaseClient,
  partyId: string,
  documentId: string,
): Promise<PartyDocumentFullRow | null> {
  const { data, error } = await db
    .from('party_documents')
    .select(FULL_COLUMNS)
    .eq('id', documentId)
    .eq('party_id', partyId)
    .maybeSingle();
  if (error) throw pgError('party_documents.select_one', error.message);
  return (data as unknown as PartyDocumentFullRow) ?? null;
}

/** The insert payload for a new document row. */
export interface NewPartyDocument {
  id: string;
  party_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  checksum_sha256: string;
  storage_key: string;
  encryption_alg: string;
  key_version: number;
  encrypted_dek: string;
  dek_iv: string;
  dek_tag: string;
  file_iv: string;
  file_tag: string;
}

/** Insert one document row (RLS WITH CHECK enforces the app-user boundary).
 *  Returns the public row. */
export async function insertPartyDocument(
  db: SupabaseClient,
  doc: NewPartyDocument,
): Promise<PartyDocumentRow> {
  const { data, error } = await db
    .from('party_documents')
    .insert(doc)
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) throw pgError('party_documents.insert', error.message);
  return data as unknown as PartyDocumentRow;
}

/** Archive one document row (idempotent: an already-archived document
 *  returns as-is; the row, the R2 object and every historical trade-in
 *  reference remain untouched). Returns the updated public row. */
export async function archivePartyDocument(
  db: SupabaseClient,
  partyId: string,
  documentId: string,
): Promise<PartyDocumentRow> {
  const { data, error } = await db
    .from('party_documents')
    .update({ status: 'archived', archived_at: new Date().toISOString() })
    .eq('id', documentId)
    .eq('party_id', partyId)
    .eq('status', 'active')
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw pgError('party_documents.archive', error.message);
  if (data) return data as unknown as PartyDocumentRow;
  // No row updated: either missing (wrong party) or already archived.
  const existing = await getPartyDocument(db, partyId, documentId);
  if (!existing) {
    throw new AppError(ErrorCode.DOCUMENT_NOT_FOUND, {
      internalDetails: { documentId, partyId },
    });
  }
  return existing;
}

/** Hard-delete one document row — compensation ONLY, never lifecycle. */
export async function deletePartyDocumentRow(
  db: SupabaseClient,
  documentId: string,
): Promise<void> {
  const { error } = await db
    .from('party_documents')
    .delete()
    .eq('id', documentId);
  if (error) throw pgError('party_documents.delete', error.message);
}

/** Verify a party exists under the caller's identity (RLS scopes the read);
 *  distinguishes PARTY_NOT_FOUND from DOCUMENT_NOT_FOUND for clear errors. */
export async function partyExists(
  db: SupabaseClient,
  partyId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('parties')
    .select('id')
    .eq('id', partyId)
    .maybeSingle();
  if (error) throw pgError('parties.select', error.message);
  return data != null;
}
