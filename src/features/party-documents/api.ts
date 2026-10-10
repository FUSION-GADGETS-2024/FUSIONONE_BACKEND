/**
 * Party Documents API client — the frontend's single access path to the
 * backend's party-scoped document routes.
 *
 * Documents NEVER touch the browser's Supabase client: storage is a
 * PRIVATE Cloudflare R2 bucket accessed ONLY through these authenticated
 * backend routes (multipart upload; decrypted preview/download streams).
 * The browser receives document metadata and file bytes — never storage
 * credentials, encryption keys, object paths or public URLs.
 *
 * Preview happens IN-APP: the preview stream is fetched as a Blob and
 * rendered inside the application's document preview dialog (never a
 * new browser tab). Download is a separate action that saves the file
 * with its original filename.
 *
 * Query invalidation is scoped to exactly one party's document list
 * (['party-documents', partyId]) — no broad application invalidation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import { waUrl } from '@/platform/whatsapp/url'

// ── Types ───────────────────────────────────────────────────────────────────

/** One party document (metadata only — exactly the backend's public row). */
export interface PartyDocument {
  id: string
  party_id: string
  file_name: string
  mime_type: string
  file_size: number
  checksum_sha256: string
  status: 'active' | 'archived'
  created_at: string
  archived_at: string | null
}

/** The document list's cache key — one entry per party. */
export const partyDocumentKeys = {
  all: ['party-documents'] as const,
  list: (partyId: string) => ['party-documents', partyId] as const,
}

// ── Authenticated backend calls ─────────────────────────────────────────────

async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const token = data.session?.access_token
  if (!token) throw new Error('Authentication required.')
  return token
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) return body.error.message
  } catch {
    // not JSON
  }
  return `Backend returned HTTP ${res.status}: ${res.statusText}`
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await accessToken()
  const res = await fetch(waUrl(path), {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as T
}

/** POST a file (multipart) to a party-scoped document route. */
async function postFile<T>(
  path: string,
  file: File,
): Promise<T> {
  const token = await accessToken()
  const form = new FormData()
  form.append('file', file, file.name)
  const res = await fetch(waUrl(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body: form,
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as T
}

/** Fetch a decrypted document stream (preview/download share this path). */
async function fetchDocumentBytes(
  partyId: string,
  documentId: string,
  disposition: 'preview' | 'download',
): Promise<{ blob: Blob; fileName: string }> {
  const token = await accessToken()
  const res = await fetch(
    waUrl(`/api/parties/${partyId}/documents/${documentId}/${disposition}`),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!res.ok) throw new Error(await parseError(res))
  // The Content-Disposition filename (RFC 5987) carries the stored original.
  const cd = res.headers.get('Content-Disposition') ?? ''
  const match = cd.match(/filename\*=UTF-8''([^;]+)/)
  const fileName = match ? decodeURIComponent(match[1]) : 'document'
  return { blob: await res.blob(), fileName }
}

// ── Operations (plain functions — used by hooks and imperative flows) ───────

export async function fetchPartyDocuments(partyId: string): Promise<PartyDocument[]> {
  const { documents } = await call<{ documents: PartyDocument[] }>(
    `/api/parties/${partyId}/documents`,
  )
  return documents
}

export async function uploadPartyDocument(partyId: string, file: File): Promise<PartyDocument> {
  const { document } = await postFile<{ document: PartyDocument }>(
    `/api/parties/${partyId}/documents`,
    file,
  )
  return document
}

export async function replacePartyDocument(
  partyId: string,
  documentId: string,
  file: File,
): Promise<{ document: PartyDocument; archived: PartyDocument }> {
  return postFile<{ document: PartyDocument; archived: PartyDocument }>(
    `/api/parties/${partyId}/documents/${documentId}/replace`,
    file,
  )
}

export async function archivePartyDocument(
  partyId: string,
  documentId: string,
): Promise<PartyDocument> {
  const { document } = await call<{ document: PartyDocument }>(
    `/api/parties/${partyId}/documents/${documentId}/archive`,
    { method: 'POST', body: {} },
  )
  return document
}

/** Fetch the decrypted document stream for IN-APP preview (rendered
 *  inside the application's preview dialog — never a new tab). */
export async function fetchPartyDocumentPreview(
  partyId: string,
  documentId: string,
): Promise<{ blob: Blob; fileName: string }> {
  return fetchDocumentBytes(partyId, documentId, 'preview')
}

/** Download the document with its original filename. */
export async function downloadPartyDocument(
  partyId: string,
  documentId: string,
): Promise<void> {
  const { blob, fileName } = await fetchDocumentBytes(partyId, documentId, 'download')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── TanStack Query layer ────────────────────────────────────────────────────

/** One party's documents (newest first; active + archived). */
export function usePartyDocuments(partyId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: partyDocumentKeys.list(partyId ?? ''),
    enabled: !!partyId && enabled,
    queryFn: () => fetchPartyDocuments(partyId!),
  })
}

/** Upload a new document; invalidates exactly this party's list. */
export function useUploadPartyDocument(partyId: string | null | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => uploadPartyDocument(partyId!, file),
    onSuccess: () => {
      if (partyId) {
        void queryClient.invalidateQueries({ queryKey: partyDocumentKeys.list(partyId) })
      }
    },
  })
}

/** Replace one document (new becomes active, old becomes archived);
 *  invalidates exactly this party's list. */
export function useReplacePartyDocument(partyId: string | null | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, file }: { documentId: string; file: File }) =>
      replacePartyDocument(partyId!, documentId, file),
    onSuccess: () => {
      if (partyId) {
        void queryClient.invalidateQueries({ queryKey: partyDocumentKeys.list(partyId) })
      }
    },
  })
}

/** Archive one document; invalidates exactly this party's list. */
export function useArchivePartyDocument(partyId: string | null | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (documentId: string) => archivePartyDocument(partyId!, documentId),
    onSuccess: () => {
      if (partyId) {
        void queryClient.invalidateQueries({ queryKey: partyDocumentKeys.list(partyId) })
      }
    },
  })
}
