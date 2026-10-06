/**
 * WhatsAppPlatformPanel state-shell regression tests.
 *
 * The panel is a pure renderer of the APPLICATION-SCOPE WhatsApp state
 * (useWhatsAppPlatformContext) inside ONE invariant shell (stable
 * header/badge slot, reserved-height content region, stable action
 * footer). These tests pin:
 *
 *   1. Initial mount, first snapshot in flight → the stable shell with a
 *      skeleton; NOT 'disconnected' (no Connect button, no disconnected
 *      copy), no fabricated QR.
 *   2. Connected snapshot → connected + the HUMAN-READABLE account
 *      representation. The raw WhatsApp JID is NEVER rendered.
 *   3. Live 'connected' without the JID, identity fetch in flight → transient
 *      completing state; NOT a partial connected view.
 *   4. Transport reconnecting after a valid connected snapshot → the
 *      last-known connected state stays visible with the sync chip.
 *   5. Authoritative disconnected → clean human copy + Connect.
 *   6. Pairing → compact pairing STATUS ONLY: the QR, its countdown, and
 *      every QR action live in the WhatsAppPairingDialog, NEVER inside the
 *      Connection card (no QR image, no reserved QR height, no Refresh).
 *   7. IDLE + session PRESENT → backend-owned wake (no frontend login
 *      request); manual Connect stays as the escape hatch, no retry loop.
 *   8. Restoring/connecting → connecting states, never 'disconnected'.
 *   9. Error → visually distinct, retryable via Connect.
 *  10. Shell geometry invariants — the badge slot and the action footer
 *      exist in EVERY state (same component changing state, not different
 *      cards being mounted).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WhatsAppPlatformPanel } from '@/components/settings/WhatsAppPlatformPanel'
import type { WhatsAppPlatformView } from '@/features/whatsapp/useWhatsAppPlatform'
import type { WhatsAppStatus } from '@/platform/whatsapp/types'

// ── Mocks (the shared application-scope state is the ONLY state source) ───

let mockView: WhatsAppPlatformView

vi.mock('@/features/whatsapp/WhatsAppPlatformContext', () => ({
  useWhatsAppPlatformContext: () => mockView,
}))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/platform/whatsapp/http', () => ({
  postLogin: vi.fn(),
  postLogout: vi.fn(),
}))

// The panel's connection actions are owner-only; the tests assert the
// owner's Connect/Logout buttons.
vi.mock('@/components/providers/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'u1', email: 'owner@test' },
    appUser: { id: 'u1', email: 'owner@test', userType: 'owner' },
    isOwner: true,
    signOut: vi.fn(),
  }),
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

const JID = '918795103722:54@s.whatsapp.net'
/** The JID's phone, formatted for humans (+91 XXXXX XXXXX). */
const PHONE = '+91 87951 03722'

const CONNECTED_WITH_JID = statusOf({
  state: 'connected',
  connected: true,
  accountId: JID,
})

beforeEach(() => {
  mockView = { status: null, transport: 'connecting', syncing: true }
})

// ── Shell helpers ───────────────────────────────────────────────────────────

/** The header's status badge (stable slot present in every state). */
const badge = () => screen.getByLabelText('Connection status')

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WhatsAppPlatformPanel — hydration / loading state', () => {
  it('first opening while SSE is connecting → the stable shell + skeleton, not disconnected', () => {
    mockView = { status: null, transport: 'connecting', syncing: true }

    render(<WhatsAppPlatformPanel />)

    // The stable shell is present: header + badge slot…
    expect(screen.getByText('Connection')).toBeTruthy()
    expect(badge().textContent).toBe('Loading')
    // …and the loading skeleton is announced (a11y) and shown.
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('Loading WhatsApp state…')).toBeTruthy()

    // NOT disconnected: no Connect button, no disconnected copy.
    expect(screen.queryByRole('button', { name: /connect whatsapp/i })).toBeNull()
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
  })

  it('connected snapshot → connected + human-readable account details (formatted phone, never the raw JID)', () => {
    mockView = { status: CONNECTED_WITH_JID, transport: 'open', syncing: false }

    render(<WhatsAppPlatformPanel />)

    // The formatted phone and the connected identity are on screen…
    expect(screen.getByText(PHONE)).toBeTruthy()
    expect(screen.getByText('WhatsApp account')).toBeTruthy()
    expect(screen.getByRole('button', { name: /logout/i })).toBeTruthy()
    expect(badge().textContent).toBe('Connected')

    // …and the raw WhatsApp JID is NOWHERE in the rendered output.
    expect(screen.queryByText(JID)).toBeNull()
    expect(document.body.textContent).not.toContain('@s.whatsapp.net')
    expect(document.body.textContent).not.toContain('918795103722')

    // No sync indicator, no disconnected copy.
    expect(screen.queryByText('Syncing…')).toBeNull()
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
  })

  it('live connected without the JID, identity fetch in flight → completing state, NOT partial account info', () => {
    mockView = {
      status: statusOf({ state: 'connected', connected: true, accountId: null }),
      transport: 'open',
      syncing: true,
    }

    render(<WhatsAppPlatformPanel />)

    // The transient completing state is shown…
    expect(screen.getByText('Connected — fetching account details…')).toBeTruthy()
    // …and the partial connected view (placeholder name) is NOT.
    expect(screen.queryByText('WhatsApp account')).toBeNull()
    expect(screen.queryByText(PHONE)).toBeNull()
    // Not disconnected either.
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
  })

  it('temporary transport reconnect → last-known connected state remains visible + subtle sync indicator', () => {
    mockView = { status: CONNECTED_WITH_JID, transport: 'reconnecting', syncing: true }

    render(<WhatsAppPlatformPanel />)

    // The last-known-good state stays: phone + account info still on screen.
    expect(screen.getByText(PHONE)).toBeTruthy()
    expect(screen.getByText('WhatsApp account')).toBeTruthy()
    expect(screen.getByRole('button', { name: /logout/i })).toBeTruthy()

    // The subtle non-blocking sync indicator is shown…
    expect(screen.getByText('Syncing…')).toBeTruthy()
    // …and it did NOT become disconnected, nor re-show the skeleton.
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
    expect(screen.queryByText('Loading WhatsApp state…')).toBeNull()
  })

  it('authoritative disconnected → clean human copy with the Connect button', () => {
    mockView = { status: statusOf({ state: 'disconnected' }), transport: 'open', syncing: false }

    render(<WhatsAppPlatformPanel />)

    expect(screen.getByText(/WhatsApp isn.t connected/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /connect whatsapp/i })).toBeTruthy()
    expect(badge().textContent).toBe('Not connected')
    // No skeleton, no sync chip — this is a REAL account state.
    expect(screen.queryByText('Loading WhatsApp state…')).toBeNull()
    expect(screen.queryByText('Syncing…')).toBeNull()
  })

  it('pairing → compact pairing status ONLY: the QR lives in the pairing dialog, NEVER in the card', () => {
    mockView = {
      status: statusOf({
        state: 'pairing',
        qrCode: 'data:image/png;base64,QR',
        qrAvailable: true,
        qrExpiresInSeconds: 42,
      }),
      transport: 'open',
      syncing: false,
    }

    render(<WhatsAppPlatformPanel />)

    // Pairing status is visible in the card…
    expect(badge().textContent).toBe('Pairing')
    expect(screen.getByText(/pairing in progress/i)).toBeTruthy()
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
    // …but NO QR content of any kind renders inside the panel: no image,
    // no countdown line, no Refresh QR action (they belong to the dialog).
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText(/next qr refresh/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /refresh qr/i })).toBeNull()
  })
})

describe('WhatsAppPlatformPanel — idle wake / restoring (backend-owned lifecycle)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // The mocked http module must return promises (the panel chains .catch).
    const { postLogin } = await import('@/platform/whatsapp/http')
    ;(postLogin as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, state: 'CONNECTING', session: 'PRESENT' })
  })

  it('IDLE + session PRESENT → NO frontend login request (the backend owns the automatic wake); waking copy, no QR, Connect as escape hatch', async () => {
    const { postLogin } = await import('@/platform/whatsapp/http')
    mockView = {
      status: statusOf({ state: 'idle', session: 'PRESENT' }),
      transport: 'open',
      syncing: false,
    }

    const { rerender } = render(<WhatsAppPlatformPanel />)

    // The backend wakes the connection from CLIENT PRESENCE (the SSE
    // stream) — the panel NEVER issues a login request on its own.
    await new Promise((r) => setTimeout(r, 30))
    expect(postLogin).not.toHaveBeenCalled()

    // The waking copy — NOT a disconnected flash, NOT a Connect-first UX.
    expect(screen.getByText(/session is configured — the connection wakes automatically/i)).toBeTruthy()
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
    expect(screen.queryByAltText('WhatsApp pairing QR')).toBeNull()

    // The manual Connect stays available as the escape hatch (the backend
    // owns the wake; if it does not complete, the user can still connect).
    expect(screen.getByRole('button', { name: /connect whatsapp/i })).toBeTruthy()

    // Re-renders in the same idle state still NEVER fire a frontend wake.
    rerender(<WhatsAppPlatformPanel />)
    mockView = { status: statusOf({ state: 'idle', session: 'PRESENT' }), transport: 'open', syncing: false }
    rerender(<WhatsAppPlatformPanel />)
    expect(postLogin).not.toHaveBeenCalled()
  })

  it('restoring → a connecting state, never a false disconnected', () => {
    mockView = {
      status: statusOf({ state: 'restoring', session: 'RESTORING' }),
      transport: 'open',
      syncing: false,
    }

    render(<WhatsAppPlatformPanel />)

    expect(screen.getByText('Restoring your WhatsApp session…')).toBeTruthy()
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /connect whatsapp/i })).toBeNull()
    expect(badge().textContent).toBe('Restoring')
  })

  it('connecting / reconnecting → connecting states, never a false disconnected', () => {
    mockView = {
      status: statusOf({ state: 'connecting', session: 'PRESENT' }),
      transport: 'open',
      syncing: false,
    }

    const { rerender } = render(<WhatsAppPlatformPanel />)

    expect(screen.getByText('Starting WhatsApp connection…')).toBeTruthy()
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
    expect(badge().textContent).toBe('Connecting')

    mockView = {
      status: statusOf({ state: 'reconnecting', session: 'PRESENT' }),
      transport: 'open',
      syncing: false,
    }
    rerender(<WhatsAppPlatformPanel />)
    expect(screen.getByText('Reconnecting to WhatsApp…')).toBeTruthy()
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
    expect(badge().textContent).toBe('Reconnecting')
  })

  it('error state → visually distinct and retryable via Connect', () => {
    mockView = {
      status: statusOf({ state: 'error', lastError: 'Session was invalidated on the phone.' }),
      transport: 'open',
      syncing: false,
    }

    render(<WhatsAppPlatformPanel />)

    expect(screen.getByText('Session was invalidated on the phone.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /connect whatsapp/i })).toBeTruthy()
    expect(badge().textContent).toBe('Error')
    // Not collapsed into the disconnected copy.
    expect(screen.queryByText(/isn.t connected/i)).toBeNull()
  })
})

describe('WhatsAppPlatformPanel — invariant shell geometry', () => {
  const STATES: Array<{ name: string; view: WhatsAppPlatformView }> = [
    { name: 'loading', view: { status: null, transport: 'connecting', syncing: true } },
    { name: 'disconnected', view: { status: statusOf({ state: 'disconnected' }), transport: 'open', syncing: false } },
    { name: 'idle', view: { status: statusOf({ state: 'idle', session: 'PRESENT' }), transport: 'open', syncing: false } },
    { name: 'restoring', view: { status: statusOf({ state: 'restoring', session: 'RESTORING' }), transport: 'open', syncing: false } },
    { name: 'connecting', view: { status: statusOf({ state: 'connecting' }), transport: 'open', syncing: false } },
    { name: 'pairing', view: { status: statusOf({ state: 'pairing', qrCode: 'data:image/png;base64,QR', qrAvailable: true, qrExpiresInSeconds: 30 }), transport: 'open', syncing: false } },
    { name: 'connected', view: { status: CONNECTED_WITH_JID, transport: 'open', syncing: false } },
    { name: 'error', view: { status: statusOf({ state: 'error' }), transport: 'open', syncing: false } },
  ]

  it.each(STATES.map((s) => [s.name, s.view] as const))(
    '%s → renders inside the SAME shell (header, badge slot, action footer, service grid)',
    (_name, view) => {
      mockView = view
      const { unmount } = render(<WhatsAppPlatformPanel />)

      // The header title and badge slot exist in EVERY state…
      expect(screen.getByText('Connection')).toBeTruthy()
      expect(badge()).toBeTruthy()
      // …the action footer exists with its stable reserved height (even
      // when no action applies)…
      expect(screen.getByRole('group', { name: 'Account actions' })).toBeTruthy()
      // …and the 4-card service grid is present with stable geometry
      // ('Connected' legitimately also appears as the badge in the
      // connected state — at least one occurrence is the grid card).
      expect(screen.getAllByText('State').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Connected').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('QR Available').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Service').length).toBeGreaterThanOrEqual(1)

      unmount()
    },
  )

  it('the raw JID never appears in ANY state (internal state only)', () => {
    for (const { view } of STATES) {
      mockView = view
      const { unmount } = render(<WhatsAppPlatformPanel />)
      expect(document.body.textContent).not.toContain('@s.whatsapp.net')
      unmount()
    }
  })

  it('the Connection card is COMPACT — the content region is reserved only for the tallest REAL state (no QR-sized reservation)', () => {
    for (const { view } of STATES) {
      mockView = view
      const { unmount } = render(<WhatsAppPlatformPanel />)

      const region = screen.getByTestId('connection-card-content')
      // Compact reservation sized for the tallest REAL state (the two-line
      // status blocks, ~73px + py-4) — NOT the old QR-era min-h-[152px].
      expect(region.className).toContain('min-h-[108px]')
      expect(region.className).not.toContain('min-h-[152px]')
      expect(region.className).toContain('py-4')
      // No QR content inside the card in ANY state — the QR (and its
      // reserved geometry) lives ONLY in the pairing dialog.
      expect(region.querySelector('img')).toBeNull()
      expect(screen.queryByAltText('WhatsApp pairing QR code')).toBeNull()
      expect(screen.queryByTestId('pairing-qr-slot')).toBeNull()

      unmount()
    }
  })
})
