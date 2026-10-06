/**
 * WhatsAppPairingDialog tests — the ONE surface that owns the QR.
 *
 * Pins the required dialog semantics:
 *   - pairing state opens the dialog; the QR renders ONLY here (never in
 *     the Settings Connection card)
 *   - a QR refresh updates the SAME dialog in place (no remount churn)
 *   - a successful connection (or any state leaving pairing) closes the
 *     dialog automatically — no stale QR, no manual closure needed
 *   - Close/Cancel/X REQUEST the backend pairing cancellation
 *     (POST /api/whatsapp/cancelPairing) — never a mere hide; a failed
 *     cancel keeps the dialog open (the pairing is still active)
 *   - the dialog is NOT owned by the WhatsApp panel: the panel unmounting
 *     or route navigation never cancels the pairing
 *   - a temporarily reconnecting SSE transport never cancels the pairing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WhatsAppPairingDialog } from '@/components/whatsapp/WhatsAppPairingDialog'
import type { WhatsAppPlatformView } from '@/features/whatsapp/useWhatsAppPlatform'
import type { WhatsAppStatus } from '@/platform/whatsapp/types'
import { postCancelPairing, postLogin } from '@/platform/whatsapp/http'

// ── Mocks ───────────────────────────────────────────────────────────────────

let mockView: WhatsAppPlatformView
const mockError = vi.fn()

vi.mock('@/features/whatsapp/WhatsAppPlatformContext', () => ({
  useWhatsAppPlatformContext: () => mockView,
}))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: mockError, warning: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/platform/whatsapp/http', () => ({
  postCancelPairing: vi.fn(),
  postLogin: vi.fn(),
}))

// ── Fixtures ────────────────────────────────────────────────────────────────

function statusOf(partial: Partial<WhatsAppStatus>): WhatsAppStatus {
  return {
    state: 'disconnected',
    session: null,
    connected: false,
    accountId: null,
    accountName: null,
    qrCode: null,
    qrAvailable: false,
    qrExpiresInSeconds: null,
    qrExpiresAt: null,
    lastError: null,
    ...partial,
  }
}

const PAIRING_WITH_QR = (qr: string, seconds = 42): WhatsAppPlatformView => ({
  status: statusOf({
    state: 'pairing',
    qrCode: qr,
    qrAvailable: true,
    qrExpiresInSeconds: seconds,
  }),
  transport: 'open',
  syncing: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockView = { status: null, transport: 'connecting', syncing: true }
  vi.mocked(postCancelPairing).mockResolvedValue({
    success: true,
    state: 'IDLE',
    session: 'NONE',
    message: 'Pairing cancelled',
  })
  vi.mocked(postLogin).mockResolvedValue({ success: true, state: 'PAIRING', message: 'ok' })
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WhatsAppPairingDialog — open/close driven by backend state', () => {
  it('opens on pairing state and renders the QR ONLY in the dialog', () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')

    render(<WhatsAppPairingDialog />)

    expect(screen.getByText('Pair WhatsApp')).toBeTruthy()
    const img = screen.getByAltText('WhatsApp pairing QR code') as HTMLImageElement
    expect(img.src).toBe('data:image/png;base64,QR-A')
    expect(screen.getByText('Next QR refresh in 42s')).toBeTruthy()
    expect(screen.getByRole('button', { name: /cancel pairing/i })).toBeTruthy()
  })

  it('stays closed when unhydrated (no fabricated pairing state)', () => {
    mockView = { status: null, transport: 'connecting', syncing: true }

    render(<WhatsAppPairingDialog />)

    expect(screen.queryByText('Pair WhatsApp')).toBeNull()
    expect(screen.queryByAltText('WhatsApp pairing QR code')).toBeNull()
  })

  it('pairing without a QR yet → generating state, still the same dialog', () => {
    mockView = {
      status: statusOf({ state: 'pairing' }),
      transport: 'open',
      syncing: false,
    }

    render(<WhatsAppPairingDialog />)

    expect(screen.getByText('Pair WhatsApp')).toBeTruthy()
    expect(screen.getByText('Generating the QR code…')).toBeTruthy()
    expect(screen.queryByAltText('WhatsApp pairing QR code')).toBeNull()
  })

  it('a QR refresh updates the SAME dialog in place', () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    const { rerender } = render(<WhatsAppPairingDialog />)
    expect((screen.getByAltText('WhatsApp pairing QR code') as HTMLImageElement).src).toBe(
      'data:image/png;base64,QR-A',
    )

    // Backend QR rotation: the new QR lands through the shared state.
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-B', 60)
    rerender(<WhatsAppPairingDialog />)

    expect((screen.getByAltText('WhatsApp pairing QR code') as HTMLImageElement).src).toBe(
      'data:image/png;base64,QR-B',
    )
    expect(screen.getByText('Next QR refresh in 60s')).toBeTruthy()
    // One dialog, not a remounted duplicate.
    expect(screen.getAllByText('Pair WhatsApp').length).toBe(1)
  })

  it('successful connection closes the dialog automatically (no stale QR)', () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    const { rerender } = render(<WhatsAppPairingDialog />)
    expect(screen.getByAltText('WhatsApp pairing QR code')).toBeTruthy()

    // The scan succeeded: the backend state left PAIRING (CONNECTED here).
    mockView = {
      status: statusOf({ state: 'connected', connected: true, accountId: '918795103722:54@s.whatsapp.net' }),
      transport: 'open',
      syncing: false,
    }
    rerender(<WhatsAppPairingDialog />)

    expect(screen.queryByText('Pair WhatsApp')).toBeNull()
    expect(screen.queryByAltText('WhatsApp pairing QR code')).toBeNull()
  })

  it('a terminal backend state (cancelled → disconnected) closes the dialog', () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    const { rerender } = render(<WhatsAppPairingDialog />)

    // The backend converged to IDLE + NONE after the cancel.
    mockView = {
      status: statusOf({ state: 'disconnected', session: 'NONE' }),
      transport: 'open',
      syncing: false,
    }
    rerender(<WhatsAppPairingDialog />)

    expect(screen.queryByText('Pair WhatsApp')).toBeNull()
    expect(screen.queryByAltText('WhatsApp pairing QR code')).toBeNull()
  })
})

describe('WhatsAppPairingDialog — explicit cancel semantics', () => {
  it('Cancel requests the BACKEND pairing cancellation (not a mere hide)', async () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    render(<WhatsAppPairingDialog />)

    fireEvent.click(screen.getByRole('button', { name: /cancel pairing/i }))

    await waitFor(() => expect(postCancelPairing).toHaveBeenCalledTimes(1))
    // While the request is in flight the button is BUSY in place: it keeps
    // the SAME action identity (loading never renames the label — the
    // accessible name is preserved by the transparent-label busy state) and
    // is disabled so the cancel cannot be double-fired.
    const cancel = screen.getByRole('button', { name: /cancel pairing/i }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
  })

  it('the header X is GONE (one dismissal affordance — the footer Cancel pairing)', async () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    render(<WhatsAppPairingDialog />)

    // Action dialog contract: Cancel + primary action in the footer, no
    // duplicate header X (both used to call the same requestCancel).
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('a FAILED cancel keeps the dialog open (pairing still active) and surfaces the error', async () => {
    vi.mocked(postCancelPairing).mockRejectedValue(new Error('network down'))
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    render(<WhatsAppPairingDialog />)

    fireEvent.click(screen.getByRole('button', { name: /cancel pairing/i }))

    await waitFor(() => expect(mockError).toHaveBeenCalled())
    // The dialog is still open and the action is usable again.
    expect(screen.getByText('Pair WhatsApp')).toBeTruthy()
    expect(screen.getByAltText('WhatsApp pairing QR code')).toBeTruthy()
    expect(screen.getByRole('button', { name: /cancel pairing/i })).toBeTruthy()
  })

  it('Refresh QR requests the backend login (idempotent); the QR itself still comes from state', async () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    render(<WhatsAppPairingDialog />)

    fireEvent.click(screen.getByRole('button', { name: /refresh qr/i }))

    await waitFor(() => expect(postLogin).toHaveBeenCalledTimes(1))
    // The dialog never fabricates a QR — it waits for the state to change.
    expect((screen.getByAltText('WhatsApp pairing QR code') as HTMLImageElement).src).toBe(
      'data:image/png;base64,QR-A',
    )
  })
})

describe('WhatsAppPairingDialog — invariant geometry (fixed QR slot, stable status line)', () => {
  // jsdom has no layout engine, so these tests pin the STRUCTURAL
  // invariants that produce the stable geometry: the QR slot's own fixed
  // dimensions define the QR area in EVERY phase (placeholder, QR, QR
  // refresh), the image is contained by the slot (its intrinsic size can
  // never size the dialog), and the countdown/status line is always
  // present at a fixed height. Pixel-level height invariance is verified
  // live (agent-browser) against the real layout.
  const getSlot = () => screen.getByTestId('pairing-qr-slot') as HTMLElement
  const getCountdown = () => screen.getByTestId('pairing-qr-countdown') as HTMLElement

  it('the fixed QR slot exists BEFORE the QR arrives — placeholder inside the SAME slot', () => {
    mockView = { status: statusOf({ state: 'pairing' }), transport: 'open', syncing: false }
    render(<WhatsAppPairingDialog />)

    const slot = getSlot()
    // The slot's own fixed dimensions define the QR region.
    expect(slot.className).toContain('h-60')
    expect(slot.className).toContain('w-60')
    // The pre-QR placeholder renders INSIDE the fixed slot.
    expect(slot.querySelector('[role="status"]')).toBeTruthy()
    expect(screen.getByText('Generating the QR code…')).toBeTruthy()
  })

  it('the QR image is CONTAINED by the slot — intrinsic dimensions cannot size the dialog', () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    render(<WhatsAppPairingDialog />)

    const slot = getSlot()
    expect(slot.className).toContain('h-60')
    expect(slot.className).toContain('w-60')
    const img = slot.querySelector('img')
    expect(img).toBeTruthy()
    // The image fills the fixed slot instead of contributing its own size.
    expect(img!.className).toContain('h-full')
    expect(img!.className).toContain('w-full')
    expect(img!.className).toContain('object-contain')
  })

  it('QR appearing and QR refreshing keep the SAME slot element (same region, no reflow)', () => {
    mockView = { status: statusOf({ state: 'pairing' }), transport: 'open', syncing: false }
    const { rerender } = render(<WhatsAppPairingDialog />)
    const slotBeforeQr = getSlot()

    // The QR appears → it replaces the placeholder INSIDE the same slot.
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A', 42)
    rerender(<WhatsAppPairingDialog />)
    expect(getSlot()).toBe(slotBeforeQr)

    // The backend rotates the QR → QR #2 occupies exactly the same region.
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-B', 60)
    rerender(<WhatsAppPairingDialog />)
    expect(getSlot()).toBe(slotBeforeQr)
    expect((slotBeforeQr.querySelector('img') as HTMLImageElement).src).toBe(
      'data:image/png;base64,QR-B',
    )
  })

  it('the countdown/status line is ALWAYS present at a fixed height — text swaps never move the layout', () => {
    mockView = { status: statusOf({ state: 'pairing' }), transport: 'open', syncing: false }
    const { rerender } = render(<WhatsAppPairingDialog />)

    // Pre-QR: the line already exists (fixed height), with placeholder text.
    const line = getCountdown()
    expect(line.className).toContain('h-5')
    expect(screen.getByText('The QR code will appear here.')).toBeTruthy()

    // QR + countdown value → the SAME line node, new text.
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A', 42)
    rerender(<WhatsAppPairingDialog />)
    expect(getCountdown()).toBe(line)
    expect(screen.getByText('Next QR refresh in 42s')).toBeTruthy()

    // Countdown ticking → text-only change in the same box.
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A', 7)
    rerender(<WhatsAppPairingDialog />)
    expect(getCountdown()).toBe(line)
    expect(screen.getByText('Next QR refresh in 7s')).toBeTruthy()

    // Countdown at zero → refresh-transition text, same box.
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A', 0)
    rerender(<WhatsAppPairingDialog />)
    expect(getCountdown()).toBe(line)
    expect(screen.getByText('Refreshing QR…')).toBeTruthy()
  })

  it('the scan instructions and the footer buttons render identically with and without the QR', () => {
    const instructions =
      'Open WhatsApp on your phone → Settings → Linked Devices → Link a Device, then scan this code.'
    mockView = { status: statusOf({ state: 'pairing' }), transport: 'open', syncing: false }
    const { rerender } = render(<WhatsAppPairingDialog />)

    // Instructions and actions exist BEFORE the QR — the geometry below
    // the slot is identical in both phases.
    expect(screen.getByText(instructions)).toBeTruthy()
    expect(screen.getByRole('button', { name: /cancel pairing/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /refresh qr/i })).toBeTruthy()

    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    rerender(<WhatsAppPairingDialog />)

    expect(screen.getByText(instructions)).toBeTruthy()
    expect(screen.getByRole('button', { name: /cancel pairing/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /refresh qr/i })).toBeTruthy()
  })
})

describe('WhatsAppPairingDialog — passive events NEVER cancel the pairing', () => {
  it('the WhatsApp panel is not required: the dialog renders and holds without it', async () => {
    // Only the dialog is mounted (the app-level state drives it) — no
    // WhatsApp panel anywhere.
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')
    render(<WhatsAppPairingDialog />)

    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText('Pair WhatsApp')).toBeTruthy()
    expect(postCancelPairing).not.toHaveBeenCalled()
  })

  it('route navigation (the page content changing) does not cancel the pairing', async () => {
    mockView = PAIRING_WITH_QR('data:image/png;base64,QR-A')

    // A tiny app-shell stand-in: the "page" swaps while the dialog stays
    // driven by the shared application-level state.
    const App = ({ page }: { page: string }) => (
      <>
        <div>{page}</div>
        <WhatsAppPairingDialog />
      </>
    )
    const { rerender } = render(<App page="Dashboard" />)

    rerender(<App page="Sales" />)
    rerender(<App page="Settings" />)
    rerender(<App page="Dashboard" />)

    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText('Pair WhatsApp')).toBeTruthy()
    expect(postCancelPairing).not.toHaveBeenCalled()
  })

  it('a temporary SSE disconnect (transport reconnecting) does not cancel the pairing', async () => {
    mockView = { ...PAIRING_WITH_QR('data:image/png;base64,QR-A'), transport: 'reconnecting' }
    render(<WhatsAppPairingDialog />)

    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText('Pair WhatsApp')).toBeTruthy()
    expect(screen.getByAltText('WhatsApp pairing QR code')).toBeTruthy()
    expect(postCancelPairing).not.toHaveBeenCalled()
  })
})
