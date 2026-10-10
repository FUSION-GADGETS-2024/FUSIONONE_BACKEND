/**
 * PartyFormModal — the Add Party dialog with its optional initial document.
 *
 * These tests pin the creation-time document shortcut:
 *   - the Add Party dialog offers an OPTIONAL document section;
 *   - a document can be selected and removed before saving;
 *   - creating a party WITHOUT a document works exactly as before;
 *   - the selected initial document is uploaded through the EXISTING
 *     party-document backend and associated with the NEW party;
 *   - a failed document upload is SURFACED clearly — the party is still
 *     created, still returned to the caller, and the user is directed to
 *     Party Detail → Documents (never a silent success, never a deleted
 *     party);
 *   - the Edit Party dialog has no document section (administration lives
 *     on Party Detail only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { PartyFormModal } from '@/components/parties/PartyFormModal'

// ── Mocks ────────────────────────────────────────────────────────────────────

const insertSingleMock = vi.hoisted(() => vi.fn())
const updateSingleMock = vi.hoisted(() => vi.fn())
const uploadDocumentMock = vi.hoisted(() => vi.fn())
const invalidateDocumentsMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/platform/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'parties') throw new Error(`unexpected table ${table}`)
      return {
        insert: () => ({ select: () => ({ single: insertSingleMock }) }),
        update: () => ({ eq: () => ({ select: () => ({ single: updateSingleMock }) }) }),
      }
    },
  },
}))

vi.mock('@/features/party-documents/api', () => ({
  uploadPartyDocument: uploadDocumentMock,
}))

vi.mock('@/features/invalidate', () => ({
  invalidatePartyDocuments: invalidateDocumentsMock,
}))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => toastMock,
}))

const PARTY = { id: 'party-9', name: 'Acme Corp', number: '919876543210', address: null } as any
const NEW_PARTY = { id: 'party-new', name: 'New Party', number: '919876543211', address: null } as any

beforeEach(() => {
  vi.clearAllMocks()
  insertSingleMock.mockResolvedValue({ data: NEW_PARTY, error: null })
  updateSingleMock.mockResolvedValue({ data: PARTY, error: null })
  uploadDocumentMock.mockResolvedValue({ id: 'doc-new' })
})

const fillRequired = () => {
  fireEvent.change(screen.getByPlaceholderText('e.g. Acme Corp'), { target: { value: 'New Party' } })
  fireEvent.change(screen.getByPlaceholderText('98765 43210'), { target: { value: '98765 43210' } })
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save Party' }))

describe('PartyFormModal — optional initial document', () => {
  it('offers the optional document section on Add Party', () => {
    render(<MemoryRouter><PartyFormModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} /></MemoryRouter>)

    expect(screen.getByText('Document')).toBeTruthy()
    expect(screen.getByText('Select Document')).toBeTruthy()
    expect(screen.getByText(/JPG, PNG, WebP or PDF · Optional/i)).toBeTruthy()
    // The supported-types file picker exists.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.accept).toBe('image/jpeg,image/png,image/webp,.pdf')
  })

  it('a selected document is shown by name and can be removed', () => {
    render(<MemoryRouter><PartyFormModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} /></MemoryRouter>)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['id-card'], 'id-card.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(screen.getByText('id-card.pdf')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove selected document' }))
    expect(screen.queryByText('id-card.pdf')).toBeNull()
    expect(screen.getByText('Select Document')).toBeTruthy()
  })

  it('creates the party correctly WITHOUT a document (existing behavior)', async () => {
    const onSuccess = vi.fn()
    const onClose = vi.fn()
    render(<MemoryRouter><PartyFormModal isOpen onClose={onClose} onSuccess={onSuccess} /></MemoryRouter>)

    fillRequired()
    save()

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(NEW_PARTY))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    // No document upload was attempted.
    expect(uploadDocumentMock).not.toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalledWith('Success', 'Party added successfully.')
  })

  it('uploads the selected initial document for the newly created party', async () => {
    const onSuccess = vi.fn()
    render(<MemoryRouter><PartyFormModal isOpen onClose={vi.fn()} onSuccess={onSuccess} /></MemoryRouter>)

    fillRequired()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['id-card'], 'id-card.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })
    save()

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(NEW_PARTY))
    // The document went through the EXISTING party-document backend, for
    // the NEW party's id.
    await waitFor(() => {
      expect(uploadDocumentMock).toHaveBeenCalledTimes(1)
      expect(uploadDocumentMock).toHaveBeenCalledWith(NEW_PARTY.id, file)
    })
    // The party's document list cache is refreshed.
    expect(invalidateDocumentsMock).toHaveBeenCalledWith(NEW_PARTY.id)
  })

  it('a failed document upload is surfaced — the party remains usable', async () => {
    uploadDocumentMock.mockRejectedValue(new Error('File too large'))
    const onSuccess = vi.fn()
    const onClose = vi.fn()
    render(<MemoryRouter><PartyFormModal isOpen onClose={onClose} onSuccess={onSuccess} /></MemoryRouter>)

    fillRequired()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' })] } })
    save()

    // The party IS created and IS returned to the caller (it remains usable).
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(NEW_PARTY))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    // The failure is surfaced clearly — never a silent success.
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        'Document Not Saved',
        expect.stringContaining('Party Detail → Documents'),
      )
    })
    expect(toastMock.error.mock.calls[0][1]).toContain('File too large')
    expect(toastMock.error.mock.calls[0][1]).toContain('The party was created')
    // The success toast is NOT shown for the document path.
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('the Edit Party dialog has NO document section', () => {
    render(
      <MemoryRouter>
        <PartyFormModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} initialData={PARTY} />
      </MemoryRouter>,
    )

    expect(screen.getByText('Edit Party')).toBeTruthy()
    expect(screen.queryByText('Select Document')).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})
