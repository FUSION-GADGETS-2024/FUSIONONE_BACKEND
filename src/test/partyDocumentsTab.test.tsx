/**
 * PartyDocumentsTab — the Party Detail Documents tab.
 *
 * These tests pin the Party Documents management contract:
 *   - the tab lists the party's REAL document records with the full
 *     metadata columns (Document / Type / Size / Added / Status / Actions);
 *   - the active/archived counters match the actual listed documents;
 *   - the empty state explains the tab's purpose and offers Add Document;
 *   - the loading state is shown while documents load;
 *   - Add Document opens the file picker and uploads through the (mocked)
 *     backend API hook;
 *   - View opens the IN-APP preview dialog (never a new browser tab);
 *   - image and PDF previews render inside that dialog;
 *   - Download stays a SEPARATE action (the backend download route) that is
 *     fully row-neutral: the menu closes cleanly, the row and its VIEW
 *     control stay exactly as they were for the whole download flight (no
 *     ellipsis collapse, no stuck busy state), and the list stays intact —
 *     no invalidation, no refetch, no remount;
 *   - a failed download surfaces through the app's toast, never by
 *     mutating the row;
 *   - active documents expose Replace + Archive in the row menu, archived
 *     documents do not (management actions belong to the ACTIVE lifecycle);
 *   - Archive asks for confirmation first (the app's action-dialog pattern)
 *     and archives through the hook on confirm.
 *
 * The app's ActionMenu is a portal dropdown with an aria-labelled trigger
 * ("More actions"); the tests drive it the way a user does.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { PartyDocumentsTab } from '@/components/party-documents/PartyDocumentsTab'

// ── Provider / feature mocks ────────────────────────────────────────────────

const documentsMock = vi.hoisted(() => ({ data: null as unknown, isLoading: false, isError: false }))
const uploadMutationMock = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }))
const replaceMutationMock = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }))
const archiveMutationMock = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }))
const previewMock = vi.hoisted(() => vi.fn())
const downloadMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
    success: toastMock.success,
    error: toastMock.error,
    warning: vi.fn(),
    info: vi.fn(),
    remove: vi.fn(),
  }),
}))

vi.mock('@/features/party-documents/api', () => ({
  usePartyDocuments: () => documentsMock,
  useUploadPartyDocument: () => uploadMutationMock,
  useReplacePartyDocument: () => replaceMutationMock,
  useArchivePartyDocument: () => archiveMutationMock,
  fetchPartyDocumentPreview: previewMock,
  downloadPartyDocument: downloadMock,
}))

// pdf.js is a rendering detail of the preview dialog's PDF branch — mocked
// so the dialog renders in jsdom without the real worker bundle.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf-worker.js' }))

const PARTY_ID = 'party-1'

const DOC_ACTIVE_PDF = {
  id: 'doc-1',
  party_id: PARTY_ID,
  file_name: 'aadhaar.pdf',
  mime_type: 'application/pdf',
  file_size: 3145728,
  checksum_sha256: 'x'.repeat(64),
  status: 'active',
  created_at: '2032-06-15T10:00:00Z',
  archived_at: null,
}

const DOC_ARCHIVED_JPG = {
  id: 'doc-2',
  party_id: PARTY_ID,
  file_name: 'old-id.jpg',
  mime_type: 'image/jpeg',
  file_size: 512000,
  checksum_sha256: 'y'.repeat(64),
  status: 'archived',
  created_at: '2032-05-01T10:00:00Z',
  archived_at: '2032-06-10T09:00:00Z',
}

beforeAll(() => {
  // jsdom does not implement object URLs — stub them for the blob previews.
  URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  URL.revokeObjectURL = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  documentsMock.data = null
  documentsMock.isLoading = false
  documentsMock.isError = false
  // Default: the preview fetch resolves with a tiny image blob.
  previewMock.mockResolvedValue({ blob: new Blob(['image-bytes'], { type: 'image/jpeg' }), fileName: 'doc' })
  // Default: downloads resolve immediately.
  downloadMock.mockResolvedValue(undefined)
})

describe('PartyDocumentsTab', () => {
  it('lists the real document records with full metadata columns', () => {
    documentsMock.data = [DOC_ACTIVE_PDF, DOC_ARCHIVED_JPG]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    // Document names.
    expect(screen.getAllByText('aadhaar.pdf').length).toBeGreaterThan(0)
    expect(screen.getAllByText('old-id.jpg').length).toBeGreaterThan(0)
    // Type / Size / Added columns.
    expect(screen.getAllByText('PDF').length).toBeGreaterThan(0)
    expect(screen.getAllByText('JPEG').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3.0 MB').length).toBeGreaterThan(0)
    expect(screen.getAllByText('500 KB').length).toBeGreaterThan(0)
    // Column headers.
    expect(screen.getByText('Document')).toBeTruthy()
    expect(screen.getByText('Type')).toBeTruthy()
    expect(screen.getByText('Size')).toBeTruthy()
    expect(screen.getByText('Added')).toBeTruthy()
    expect(screen.getByText('Status')).toBeTruthy()
    // Lifecycle badges.
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(0)
  })

  it('active/archived counters match the actual listed documents', () => {
    documentsMock.data = [DOC_ACTIVE_PDF, DOC_ARCHIVED_JPG]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    // The counters say exactly what the rows show: one of each.
    expect(screen.getByText(/1 active · 1 archived/i)).toBeTruthy()
    expect(screen.getAllByText('aadhaar.pdf').length).toBeGreaterThan(0)
    expect(screen.getAllByText('old-id.jpg').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Archived').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the empty state when the party has no documents', () => {
    documentsMock.data = []
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    expect(screen.getByText(/No documents added yet/i)).toBeTruthy()
    expect(screen.getByText(/Add an identity or declaration document for this party/i)).toBeTruthy()
    // The empty state offers the fix: + Add Document (in the state itself).
    expect(screen.getAllByRole('button', { name: /Add Document/i }).length).toBeGreaterThanOrEqual(2)
  })

  it('empty counters never claim a document that is not listed', () => {
    documentsMock.data = []
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    // With no documents the counter line says so — not "1 active · 0 archived".
    expect(screen.getByText(/No documents yet/i)).toBeTruthy()
    expect(screen.queryByText(/1 active/i)).toBeNull()
  })

  it('shows the loading state while documents load', () => {
    documentsMock.isLoading = true
    documentsMock.data = null
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)
    expect(screen.getByText(/Loading documents/i)).toBeTruthy()
  })

  it('Add Document opens the picker and uploads the chosen file through the backend hook', () => {
    documentsMock.data = []
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()

    const file = new File(['%PDF-1.4 fake'], 'declaration.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(uploadMutationMock.mutate).toHaveBeenCalledTimes(1)
    expect(uploadMutationMock.mutate.mock.calls[0][0]).toBe(file)
  })

  it('View opens the IN-APP preview dialog — never a new browser tab', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0])

    // The in-app dialog opens with the document's filename…
    expect(await screen.findByRole('dialog', { name: 'aadhaar.pdf' })).toBeTruthy()
    // …and the preview bytes are fetched through the secure backend route.
    await waitFor(() => {
      expect(previewMock).toHaveBeenCalledWith(PARTY_ID, 'doc-1')
    })
    expect(windowOpen).not.toHaveBeenCalled()
    windowOpen.mockRestore()
  })

  it('image preview renders inside the application dialog', async () => {
    documentsMock.data = [DOC_ARCHIVED_JPG]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0])

    // The dialog (portaled to document.body) renders an actual image element.
    await waitFor(() => {
      const img = document.querySelector('img[alt="old-id.jpg"]')
      expect(img).toBeTruthy()
    })
  })

  it('PDF preview renders inside the application dialog (pdf.js pages)', async () => {
    const { getDocument } = await import('pdfjs-dist')
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() }
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
      render: () => renderTask,
      cleanup: vi.fn(),
    }
    ;(getDocument as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage: () => Promise.resolve(page) }),
      destroy: vi.fn(),
    })
    previewMock.mockResolvedValue({ blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), fileName: 'aadhaar.pdf' })

    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0])

    // The PDF parses through pdf.js and its pages render as canvases.
    await waitFor(() => {
      expect(getDocument).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getAllByRole('img', { name: /Document page/i }).length).toBe(2)
    })
  })

  it('the preview dialog exposes a Download action separate from Preview', async () => {
    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0])
    await screen.findByRole('dialog', { name: 'aadhaar.pdf' })

    // Download inside the dialog uses the dedicated download route.
    fireEvent.click(screen.getByRole('button', { name: /Download/i }))
    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledWith(PARTY_ID, 'doc-1')
    })
  })

  it('the row menu Download action is separate from View', async () => {
    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0])
    fireEvent.click(await screen.findByText('Download'))

    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledWith(PARTY_ID, 'doc-1')
      expect(previewMock).not.toHaveBeenCalled()
    })
  })

  // ── Download is row-neutral (the action-menu bug fix) ─────────────────────
  //
  // Regression test for the bug where clicking Download collapsed the row's
  // action area: the download's busy state lived on the row's VIEW control
  // (its label was rewritten to an ellipsis for the whole flight — and stuck
  // there if the fetch hung). The download now keeps NO row state: the menu
  // closes synchronously, the row and the whole list remain exactly as
  // loaded, and only a FAILURE is surfaced (as a toast, never as a row
  // mutation). The controlled promise pins the DURING-flight state.
  it('Download closes the menu and leaves the row untouched for the whole flight', async () => {
    let resolveDownload!: () => void
    downloadMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDownload = resolve
      }),
    )
    documentsMock.data = [DOC_ACTIVE_PDF, DOC_ARCHIVED_JPG]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    // Open the row's action menu, then choose Download — as a user does.
    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0])
    fireEvent.click(await screen.findByText('Download'))

    // The menu closed cleanly (its portal items unmounted)…
    await waitFor(() => {
      expect(screen.queryByText('Replace')).toBeNull()
      expect(screen.queryByText('Archive')).toBeNull()
    })

    // …while the download is still in flight, and the secure backend route
    // was called exactly once for this row.
    expect(downloadMock).toHaveBeenCalledTimes(1)
    expect(downloadMock).toHaveBeenCalledWith(PARTY_ID, 'doc-1')

    // DURING the flight: the row's VIEW control is untouched (no ellipsis
    // collapse, no busy glyph)…
    expect(screen.queryByText('…')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'View' }).length).toBeGreaterThan(0)
    // …the document row remains visible…
    expect(screen.getAllByText('aadhaar.pdf').length).toBeGreaterThan(0)
    // …and the whole Documents list remains intact.
    expect(screen.getAllByText('old-id.jpg').length).toBeGreaterThan(0)
    expect(screen.getByText(/1 active · 1 archived/i)).toBeTruthy()

    // The download completes — the row STILL remains, VIEW still intact.
    resolveDownload()
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'View' }).length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('…')).toBeNull()
    expect(screen.getAllByText('aadhaar.pdf').length).toBeGreaterThan(0)
    expect(screen.getAllByText('old-id.jpg').length).toBeGreaterThan(0)
    // No list reset: the loaded document state was still valid, so the
    // failure path was never taken and no error toast fired.
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('a failed download reports through the toast — never by mutating the row', async () => {
    downloadMock.mockRejectedValue(new Error('R2 stream closed'))
    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0])
    fireEvent.click(await screen.findByText('Download'))

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Download Failed', 'R2 stream closed')
    })
    // The row survived the failure — fully intact, VIEW unchanged.
    expect(screen.getAllByText('aadhaar.pdf').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'View' }).length).toBeGreaterThan(0)
    expect(screen.queryByText('…')).toBeNull()
  })

  it('Archive asks for confirmation, then archives through the hook', async () => {
    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    // Open the row menu, then its Archive item.
    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0])
    fireEvent.click(await screen.findByText('Archive'))

    // The confirmation dialog (the app's action-dialog pattern).
    expect(await screen.findByText('Archive Document')).toBeTruthy()
    // The dialog's own Archive action (the menu has closed by now).
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await waitFor(() => {
      expect(archiveMutationMock.mutate).toHaveBeenCalledTimes(1)
      expect(archiveMutationMock.mutate.mock.calls[0][0]).toBe('doc-1')
    })
  })

  it('archived documents expose NO Replace/Archive management actions', async () => {
    documentsMock.data = [DOC_ARCHIVED_JPG]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0])
    // The menu opens with ONLY Download (no Replace, no Archive).
    await waitFor(() => {
      expect(screen.getByText('Download')).toBeTruthy()
      expect(screen.queryByText('Replace')).toBeNull()
      expect(screen.queryByText('Archive')).toBeNull()
    })
  })

  it('active documents expose Replace and Download in the row menu', async () => {
    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0])
    expect(await screen.findByText('Replace')).toBeTruthy()
    expect(await screen.findByText('Download')).toBeTruthy()
  })

  it('Replace opens the file picker for the row document', async () => {
    documentsMock.data = [DOC_ACTIVE_PDF]
    render(<MemoryRouter><PartyDocumentsTab partyId={PARTY_ID} /></MemoryRouter>)

    fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[0])
    fireEvent.click(await screen.findByText('Replace'))

    // The hidden replace picker exists (a target was captured).
    const inputs = document.querySelectorAll('input[type="file"]')
    expect(inputs.length).toBeGreaterThanOrEqual(2) // add picker + replace picker

    const replaceInput = inputs[inputs.length - 1] as HTMLInputElement
    const file = new File(['%PDF-1.4 newer'], 'newer.pdf', { type: 'application/pdf' })
    fireEvent.change(replaceInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(replaceMutationMock.mutate).toHaveBeenCalledTimes(1)
      expect(replaceMutationMock.mutate.mock.calls[0][0]).toEqual({ documentId: 'doc-1', file })
    })
  })

  // ── The list-page height chain (count rendered, row visible) ────────────────
  //
  // Regression test for the bug where the tab showed "1 active · 0 archived"
  // while the document row was invisible: the tab root was a plain block
  // (space-y-3), which broke ListPage's bounded flex column — the fill-mode
  // DataTable card collapsed to its 2px border and the absolute-inset-0 rows
  // viewport (ListViewport) clipped every row at 0 height. jsdom has no
  // layout engine, so the guard pins the STRUCTURAL contract that makes the
  // height chain resolve: the root must be a stretching flex item AND a flex
  // column, exactly like the invoice tabs' fill DataTables.
  it('keeps the list-page height chain so counted rows are actually rendered', () => {
    documentsMock.data = [DOC_ACTIVE_PDF]
    // Embed the tab the way PartyDetailPage does: inside ListPage's bounded
    // flex column (flex min-h-0 flex-1 flex-col).
    const { container } = render(
      <MemoryRouter>
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          <PartyDocumentsTab partyId={PARTY_ID} />
        </div>
      </MemoryRouter>,
    )

    // The counter claims the document…
    expect(screen.getByText(/1 active · 0 archived/i)).toBeTruthy()
    // …and the row exists for the SAME document…
    expect(screen.getAllByText('aadhaar.pdf').length).toBeGreaterThan(0)

    // …and the height chain that makes that row visible is intact:
    // 1. the tab root is a stretching flex item + flex container (never a
    //    plain block wrapper — that collapses the fill card to 0px);
    const root = container.firstElementChild as HTMLElement
    expect(root).toBeTruthy()
    const rootClasses = root.className.split(/\s+/)
    expect(rootClasses).toContain('flex')
    expect(rootClasses).toContain('min-h-0')
    expect(rootClasses).toContain('flex-1')
    expect(rootClasses).toContain('flex-col')
    expect(rootClasses).not.toContain('space-y-3')

    // 2. the DataTable card is the flex child that fills the root (the
    //    fill-mode card classes), so its absolute rows viewport resolves to
    //    a real height instead of clipping the rows.
    const tableCard = [...container.querySelectorAll('div')].find(
      (d) => typeof d.className === 'string' && d.className.includes('rounded-xl border') && d.querySelector('table'),
    ) as HTMLElement | undefined
    expect(tableCard).toBeTruthy()
    const cardClasses = (tableCard as HTMLElement).className.split(/\s+/)
    expect(cardClasses).toContain('flex')
    expect(cardClasses).toContain('min-h-0')
    expect(cardClasses).toContain('flex-1')

    // 3. the rows viewport is present and is the card's scroller geometry
    //    (absolute inset-0) — which only produces a visible height when the
    //    chain above holds.
    const scroller = (tableCard as HTMLElement).querySelector('div.absolute.inset-0')
    expect(scroller).toBeTruthy()
    expect(scroller?.contains(screen.getAllByText('aadhaar.pdf')[0])).toBe(true)
  })
})
