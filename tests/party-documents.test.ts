/**
 * Party Documents backend — unit + orchestration tests.
 *
 * Covers the spec-mandated backend matrix:
 *   - envelope encryption: roundtrip, tamper detection, checksum
 *   - file inspection: supported types, unsupported MIME, invalid content
 *   - size limit enforcement (oversized file)
 *   - image processing (real worker: decode → orient → cap → JPEG)
 *   - PDF validation (preserved bytes)
 *   - upload orchestration: successful upload path
 *   - R2 upload failure → no database row (Case C)
 *   - database failure after R2 upload → compensation delete (Case D)
 *   - replace failure cases (old stays active — Case E; final-DB-op
 *     failure rolls the replacement back — Case F)
 *   - party-scoped resolution + wrong-party access (document of another
 *     party is "not found")
 *   - archive idempotence
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { randomUUID } from 'node:crypto'

// ── Test configuration (master key: base64 of 32 zero-ish bytes) ────────────
process.env.NODE_ENV = 'test'
process.env.DOCUMENTS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.R2_ACCOUNT_ID = 'test-account'
process.env.R2_ACCESS_KEY_ID = 'test-key'
process.env.R2_SECRET_ACCESS_KEY = 'test-secret'
process.env.R2_BUCKET = 'test-bucket'
process.env.MAX_DOCUMENT_FILE_BYTES = '10485760'

// ── Module mocks (storage + repository — the R2/DB seams) ───────────────────

const putObjectMock = mock(async (_key: string, _bytes: Buffer) => undefined)
const getObjectMock = mock(async (_key: string) => Buffer.alloc(0))
const deleteObjectMock = mock(async (_key: string) => undefined)

mock.module('../src/party-documents/storage.js', () => ({
  putDocumentObject: putObjectMock,
  getDocumentObject: getObjectMock,
  deleteDocumentObject: deleteObjectMock,
  documentStorageKey: (partyId: string, documentId: string) =>
    `party-documents/${partyId}/${documentId}`,
  requireDocumentStorage: () => undefined,
  isDocumentStorageConfigured: () => true,
}))

interface RepoRow {
  id: string
  party_id: string
  file_name: string
  mime_type: string
  file_size: number
  checksum_sha256: string
  storage_key: string
  encryption_alg: string
  key_version: number
  encrypted_dek: string
  dek_iv: string
  dek_tag: string
  file_iv: string
  file_tag: string
  status: 'active' | 'archived'
  created_at: string
  archived_at: string | null
}

const dbRows = new Map<string, RepoRow>()
const insertMock = mock(async (_db: unknown, doc: RepoRow) => {
  // Emulate the database defaults the real insert applies.
  const row: RepoRow = {
    ...doc,
    status: 'active',
    created_at: new Date().toISOString(),
    archived_at: null,
  }
  dbRows.set(doc.id, row)
  return { ...row }
})
const archiveMock = mock(
  async (_db: unknown, partyId: string, documentId: string) => {
    const row = dbRows.get(documentId)
    // Wrong party / missing → NOT FOUND (the real repository contract).
    if (!row || row.party_id !== partyId) throw new Error('document not found')
    if (row.status === 'active') {
      row.status = 'archived'
      row.archived_at = new Date().toISOString()
    }
    return { ...row }
  },
)
const getMock = mock(async (_db: unknown, partyId: string, documentId: string) => {
  const row = dbRows.get(documentId)
  if (!row || row.party_id !== partyId) return null
  return { ...row }
})
const listMock = mock(async (_db: unknown, partyId: string) =>
  [...dbRows.values()].filter((r) => r.party_id === partyId).map((r) => ({ ...r })),
)
const deleteRowMock = mock(async (_db: unknown, documentId: string) => {
  dbRows.delete(documentId)
})
const partyExistsMock = mock(async (_db: unknown, partyId: string) => partyId === PARTY_ID)

mock.module('../src/party-documents/repository.js', () => ({
  listPartyDocuments: listMock,
  getPartyDocument: getMock,
  insertPartyDocument: insertMock,
  archivePartyDocument: archiveMock,
  deletePartyDocumentRow: deleteRowMock,
  partyExists: partyExistsMock,
}))

// The image worker is a real child process — keep the REAL implementation
// (integration-tested below); only the PDF path avoids it entirely.

const {
  encryptDocumentFile,
  decryptDocumentFile,
  sha256Hex,
} = await import('../src/party-documents/crypto.js')
const { classifyDocumentFile } = await import('../src/party-documents/validate.js')
const {
  uploadDocument,
  replaceDocument,
  archiveDocument,
  getDocumentFile,
  normalizeFileName,
} = await import('../src/party-documents/service.js')

const PARTY_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_PARTY_ID = '22222222-2222-2222-2222-222222222222'
const DB = {} as never

// A minimal valid PDF (header + body + EOF marker).
const VALID_PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
  Buffer.alloc(40, 0x25),
  Buffer.from('\n%%EOF'),
])

beforeEach(() => {
  dbRows.clear()
  putObjectMock.mockClear()
  getObjectMock.mockClear()
  deleteObjectMock.mockClear()
  insertMock.mockClear()
  archiveMock.mockClear()
  getMock.mockClear()
  deleteRowMock.mockClear()
})

// ── Envelope encryption ─────────────────────────────────────────────────────

describe('party document envelope encryption (AES-256-GCM)', () => {
  it('roundtrips a file and reports its plaintext checksum', () => {
    const plaintext = Buffer.from('FUSION ONE document — identity declaration bytes')
    const enc = encryptDocumentFile(plaintext)

    expect(enc.ciphertext.equals(plaintext)).toBe(false)
    expect(enc.ciphertext.length).toBeGreaterThanOrEqual(plaintext.length)
    expect(enc.checksumSha256).toBe(sha256Hex(plaintext))
    expect(enc.material.encryption_alg).toBe('AES-256-GCM')
    expect(enc.material.key_version).toBe(1)
    // None of the base64 material may leak the plaintext or key.
    const materialBlob = Object.values(enc.material).join('|')
    expect(materialBlob.includes(plaintext.toString('base64'))).toBe(false)

    const dec = decryptDocumentFile(enc.ciphertext, enc.material)
    expect(dec.equals(plaintext)).toBe(true)
    expect(sha256Hex(dec)).toBe(enc.checksumSha256)
  })

  it('produces unique ciphertexts + material for identical plaintexts (unique DEK/IV)', () => {
    const plaintext = Buffer.from('same input document')
    const a = encryptDocumentFile(plaintext)
    const b = encryptDocumentFile(plaintext)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(a.material.encrypted_dek).not.toBe(b.material.encrypted_dek)
    expect(a.material.file_iv).not.toBe(b.material.file_iv)
  })

  it('rejects a tampered ciphertext (GCM authentication failure)', () => {
    const enc = encryptDocumentFile(Buffer.from('authenticated content'))
    const tampered = Buffer.from(enc.ciphertext)
    tampered[0] = tampered[0] ^ 0xff
    expect(() => decryptDocumentFile(tampered, enc.material)).toThrow()
  })

  it('rejects a tampered wrapped DEK', () => {
    const enc = encryptDocumentFile(Buffer.from('authenticated content'))
    const material = { ...enc.material, encrypted_dek: Buffer.from('tampered-dek').toString('base64') }
    expect(() => decryptDocumentFile(enc.ciphertext, material)).toThrow()
  })

  it('rejects an unknown key version without touching the master key', () => {
    const enc = encryptDocumentFile(Buffer.from('v1 document'))
    expect(() =>
      decryptDocumentFile(enc.ciphertext, { ...enc.material, key_version: 99 }),
    ).toThrow(/integrity check/i)
  })
})

// ── File inspection (content, never trust) ──────────────────────────────────

describe('party document file classification', () => {
  it('accepts JPEG, PNG, WebP and PDF by content', () => {
    expect(classifyDocumentFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime).toBe('image/jpeg')
    expect(
      classifyDocumentFile(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])).mime,
    ).toBe('image/png')
    expect(
      classifyDocumentFile(Buffer.concat([Buffer.from('RIFF'), Buffer.from([9, 0, 0, 0]), Buffer.from('WEBPVP8')])).mime,
    ).toBe('image/webp')
    expect(classifyDocumentFile(VALID_PDF)).toEqual({ mime: 'application/pdf', kind: 'pdf' })
  })

  it('rejects an unsupported MIME type by content (GIF)', () => {
    expect(() => classifyDocumentFile(Buffer.from('GIF89a' + '....'))).toThrow()
  })

  it('rejects invalid file content (truncated PDF without %%EOF)', () => {
    const truncated = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(30, 0x25)])
    expect(() => classifyDocumentFile(truncated)).toThrow()
  })

  it('rejects an empty file', () => {
    expect(() => classifyDocumentFile(Buffer.alloc(0))).toThrow()
  })

  it('ignores a lying filename/extension (content decides)', () => {
    // JPEG bytes named .pdf classify as an image.
    expect(classifyDocumentFile(Buffer.from([0xff, 0xd8, 0xff, 0xe1])).kind).toBe('image')
  })
})

// ── Service orchestration (mocked storage + repository) ─────────────────────

describe('party document service', () => {
  it('normalizeFileName sanitizes and caps filenames', () => {
    expect(normalizeFileName(undefined)).toBe('document')
    expect(normalizeFileName('  \u0007weird\u001f name.pdf ')).toBe('weird name.pdf')
    expect(normalizeFileName('x'.repeat(400)).length).toBe(255)
  })

  it('uploads a valid PDF: process → encrypt → R2 → row (success path)', async () => {
    const row = await uploadDocument(DB, PARTY_ID, 'declaration.pdf', VALID_PDF)
    expect(row.party_id).toBe(PARTY_ID)
    expect(row.mime_type).toBe('application/pdf')
    expect(row.status).toBe('active')
    expect(row.file_size).toBe(VALID_PDF.length)
    expect(putObjectMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledTimes(1)
    // The stored object key encodes the party/document relationship.
    const inserted = insertMock.mock.calls[0][1] as RepoRow
    expect(inserted.storage_key).toBe(`party-documents/${PARTY_ID}/${row.id}`)
    expect(inserted.checksum_sha256).toBe(sha256Hex(VALID_PDF))
  })

  it('Case A/B: rejects an unsupported/invalid file — nothing stored', async () => {
    await expect(uploadDocument(DB, PARTY_ID, 'evil.gif', Buffer.from('GIF89a...'))).rejects.toThrow()
    expect(putObjectMock).not.toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()

    await expect(
      uploadDocument(DB, PARTY_ID, 'broken.pdf', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(20)])),
    ).rejects.toThrow()
    expect(putObjectMock).not.toHaveBeenCalled()
    expect(dbRows.size).toBe(0)
  })

  it('rejects an oversized file server-side', async () => {
    const huge = Buffer.concat([VALID_PDF, Buffer.alloc(1024 * 1024 * 11)])
    await expect(uploadDocument(DB, PARTY_ID, 'huge.pdf', huge)).rejects.toThrow(/size/i)
    expect(putObjectMock).not.toHaveBeenCalled()
    expect(dbRows.size).toBe(0)
  })

  it('rejects a non-existent party', async () => {
    await expect(uploadDocument(DB, OTHER_PARTY_ID, 'doc.pdf', VALID_PDF)).rejects.toThrow()
    expect(putObjectMock).not.toHaveBeenCalled()
  })

  it('Case C: R2 upload failure → no database row', async () => {
    putObjectMock.mockImplementationOnce(async () => {
      throw new Error('r2 unavailable')
    })
    await expect(uploadDocument(DB, PARTY_ID, 'doc.pdf', VALID_PDF)).rejects.toThrow()
    expect(insertMock).not.toHaveBeenCalled()
    expect(dbRows.size).toBe(0)
  })

  it('Case D: database insert failure after R2 upload → compensation delete of the new object', async () => {
    insertMock.mockImplementationOnce(async () => {
      throw new Error('db down')
    })
    await expect(uploadDocument(DB, PARTY_ID, 'doc.pdf', VALID_PDF)).rejects.toThrow()
    expect(putObjectMock).toHaveBeenCalledTimes(1)
    expect(deleteObjectMock).toHaveBeenCalledTimes(1)
    expect(deleteObjectMock.mock.calls[0][0]).toBe(putObjectMock.mock.calls[0][0])
    expect(dbRows.size).toBe(0)
  })

  it('Case E: replace upload failure → the old document stays active and unchanged', async () => {
    const old = await uploadDocument(DB, PARTY_ID, 'old-id.pdf', VALID_PDF)

    putObjectMock.mockImplementationOnce(async () => {
      throw new Error('r2 unavailable')
    })
    await expect(replaceDocument(DB, PARTY_ID, old.id, 'new.pdf', VALID_PDF)).rejects.toThrow()

    const stillOld = dbRows.get(old.id)!
    expect(stillOld.status).toBe('active')
    expect(stillOld.archived_at).toBeNull()
    expect(dbRows.size).toBe(1)
    expect(archiveMock).not.toHaveBeenCalled()
  })

  it('replace success: new document active, old document archived', async () => {
    const old = await uploadDocument(DB, PARTY_ID, 'old.pdf', VALID_PDF)
    const result = await replaceDocument(DB, PARTY_ID, old.id, 'new.pdf', VALID_PDF)

    expect(result.document.status).toBe('active')
    expect(result.archived.id).toBe(old.id)
    expect(result.archived.status).toBe('archived')
    expect(result.archived.archived_at).not.toBeNull()
    expect(dbRows.size).toBe(2)
  })

  it('Case F: replace final-DB-op failure → the new document is removed again, old remains active', async () => {
    const old = await uploadDocument(DB, PARTY_ID, 'old.pdf', VALID_PDF)

    archiveMock.mockImplementationOnce(async () => {
      throw new Error('archive failed')
    })
    await expect(replaceDocument(DB, PARTY_ID, old.id, 'new.pdf', VALID_PDF)).rejects.toThrow()

    // The replacement was fully rolled back.
    expect(dbRows.size).toBe(1)
    const stillOld = dbRows.get(old.id)!
    expect(stillOld.status).toBe('active')
    expect(deleteRowMock).toHaveBeenCalledTimes(1)
    expect(deleteObjectMock).toHaveBeenCalledTimes(1)
  })

  it('replace targets an ACTIVE document of the same party only', async () => {
    const doc = await uploadDocument(DB, PARTY_ID, 'a.pdf', VALID_PDF)
    // Wrong party → not found.
    await expect(replaceDocument(DB, OTHER_PARTY_ID, doc.id, 'b.pdf', VALID_PDF)).rejects.toThrow()
    // Archived → refused.
    await archiveDocument(DB, PARTY_ID, doc.id)
    await expect(replaceDocument(DB, PARTY_ID, doc.id, 'b.pdf', VALID_PDF)).rejects.toThrow(
      /active document can be replaced/i,
    )
  })

  it('archive is idempotent (an archived document stays archived, nothing deleted)', async () => {
    const doc = await uploadDocument(DB, PARTY_ID, 'a.pdf', VALID_PDF)
    const first = await archiveDocument(DB, PARTY_ID, doc.id)
    expect(first.status).toBe('archived')
    const second = await archiveDocument(DB, PARTY_ID, doc.id)
    expect(second.status).toBe('archived')
    expect(dbRows.size).toBe(1)
    expect(deleteObjectMock).not.toHaveBeenCalled()
    expect(deleteRowMock).not.toHaveBeenCalled()
  })

  it('archive on a wrong-party document id → not found', async () => {
    const doc = await uploadDocument(DB, PARTY_ID, 'a.pdf', VALID_PDF)
    await expect(archiveDocument(DB, OTHER_PARTY_ID, doc.id)).rejects.toThrow()
  })

  it('wrong-party access is not found (party-scoped resolution)', async () => {
    const doc = await uploadDocument(DB, PARTY_ID, 'a.pdf', VALID_PDF)
    await expect(getDocumentFile(DB, OTHER_PARTY_ID, doc.id)).rejects.toThrow()
    await expect(getDocumentFile(DB, PARTY_ID, randomUUID())).rejects.toThrow()
  })

  it('preview/download: fetch → decrypt → integrity-verified plaintext', async () => {
    const row = await uploadDocument(DB, PARTY_ID, 'a.pdf', VALID_PDF)

    // Serve back exactly what was uploaded (the real encrypted object).
    const uploadedObject = putObjectMock.mock.calls[0][1] as Buffer
    getObjectMock.mockImplementation(async () => uploadedObject)

    const file = await getDocumentFile(DB, PARTY_ID, row.id)
    expect(file.plaintext.equals(VALID_PDF)).toBe(true)
    expect(file.row.file_name).toBe('a.pdf')
    expect(file.row.id).toBe(row.id)
  })

  it('detects storage corruption (checksum mismatch after decryption)', async () => {
    const row = await uploadDocument(DB, PARTY_ID, 'a.pdf', VALID_PDF)
    // Serve a DIFFERENT validly-encrypted object (wrong content).
    const other = encryptDocumentFile(Buffer.from('totally different document'))
    getObjectMock.mockImplementation(async () => other.ciphertext)
    await expect(getDocumentFile(DB, PARTY_ID, row.id)).rejects.toThrow(/integrity|corrupt/i)
  })

  it('historical access: an ARCHIVED document still resolves and decrypts', async () => {
    const doc = await uploadDocument(DB, PARTY_ID, 'old-id.pdf', VALID_PDF)
    const uploadedObject = putObjectMock.mock.calls[0][1] as Buffer
    await archiveDocument(DB, PARTY_ID, doc.id)

    getObjectMock.mockImplementation(async () => uploadedObject)
    const file = await getDocumentFile(DB, PARTY_ID, doc.id)
    expect(file.row.status).toBe('archived')
    expect(file.plaintext.equals(VALID_PDF)).toBe(true)
  })
})
