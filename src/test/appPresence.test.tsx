/**
 * Application-scope client presence tests — the WhatsApp/SSE lifecycle
 * belongs to the AUTHENTICATED APPLICATION, not the WhatsApp panel.
 *
 * Pins the required conceptual behavior:
 *   0 -> 1  when the authenticated application first opens
 *   1 -> 1  across ALL ordinary route changes (Dashboard → Sales →
 *            Settings → WhatsApp → Dashboard)
 *   1 -> 0  only when the authenticated application client disappears
 *
 * A WhatsApp panel unmount must NOT decrement application-level client
 * presence, and navigating back must not create a duplicate SSE
 * connection. Also pins the NON-BLOCKING shell requirement: the
 * application renders immediately — it never waits for the SSE stream
 * (nor, transitively, for Redis/Baileys/WhatsApp availability).
 *
 * These tests mount the REAL WhatsAppPlatformProvider (the app shell's
 * observer) with the transport + snapshot fetch mocked, and swap "pages"
 * exactly like the router does — the provider and the SSE connection
 * stay mounted for the whole application lifetime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WhatsAppPlatformProvider } from '@/features/whatsapp/WhatsAppPlatformContext'
import { useWhatsAppPlatformContext } from '@/features/whatsapp/WhatsAppPlatformContext'
import { fetchBackendStatus } from '@/platform/whatsapp/http'

// ── Controlled SSE stream mock (same contract as the hook tests) ──────────

class MockSSEStream {
  static instances: MockSSEStream[] = []
  closed = false

  constructor() {
    MockSSEStream.instances.push(this)
  }

  close() {
    this.closed = true
  }

  get envelope(): AsyncIterable<unknown> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        const queue: unknown[] = []
        while (!self.closed) {
          if (queue.length === 0) {
            await new Promise<void>((r) => setTimeout(r, 50))
            continue
          }
          yield queue.shift()!
        }
      },
    }
  }
}

vi.mock('@/platform/whatsapp/sse', () => ({
  connectAuthenticatedEventStream: vi.fn(),
  SSE_PAIRING_STALL_TIMEOUT_MS: 10_000,
}))

vi.mock('@/platform/whatsapp/http', () => ({
  fetchBackendStatus: vi.fn(),
  postLogin: vi.fn(),
  postLogout: vi.fn(),
  postCancelPairing: vi.fn(),
}))

const { connectAuthenticatedEventStream } = await import('@/platform/whatsapp/sse')

// ── A tiny authenticated-app stand-in ──────────────────────────────────────

/** A "page" that CONSUMES the shared WhatsApp state (like the panel). */
function WhatsAppConsumerPage() {
  const { status } = useWhatsAppPlatformContext()
  return <p data-testid="wa-state">{status ? status.state : 'hydrating'}</p>
}

/** An ordinary application page that never touches WhatsApp state. */
function PlainPage({ name }: { name: string }) {
  return <h1>{name}</h1>
}

/**
 * The app-shell stand-in: ONE WhatsAppPlatformProvider wrapping whatever
 * "page" is current — the provider (and its SSE connection) lives at the
 * application level, exactly like the real AppShell.
 */
function AppShellStandIn({ page }: { page: ReactNode }) {
  return <WhatsAppPlatformProvider>{page}</WhatsAppPlatformProvider>
}

beforeEach(async () => {
  MockSSEStream.instances = []
  vi.clearAllMocks()
  // Explicit per-test implementations (clearAllMocks keeps implementations
  // from PREVIOUS tests alive — reset both to the healthy defaults).
  vi.mocked(connectAuthenticatedEventStream).mockImplementation(
    async () => new MockSSEStream() as never,
  )
  vi.mocked(fetchBackendStatus).mockResolvedValue({
    server: { state: 'running', timestamp: new Date().toISOString() },
    whatsapp: {
      state: 'IDLE',
      session: 'NONE',
      connected: false,
      jid: null,
      qrAvailable: false,
      qr: null,
      qrExpiresInSeconds: null,
      qrExpiresAt: null,
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Application-scope client presence (one SSE per application client)', () => {
  it('the authenticated application opening establishes exactly ONE SSE connection — without any WhatsApp panel mounted', async () => {
    // The app opens on the DASHBOARD: no Settings page, no WhatsApp panel.
    const { unmount } = render(
      <AppShellStandIn page={<PlainPage name="Dashboard" />} />,
    )

    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    expect(connectAuthenticatedEventStream).toHaveBeenCalledTimes(1)
    // Client presence exists while the application is open — the stream is
    // live, not closed.
    expect(MockSSEStream.instances[0].closed).toBe(false)

    unmount()
  })

  it('ordinary route navigation NEVER drops or duplicates the SSE connection', async () => {
    const { rerender, unmount } = render(
      <AppShellStandIn page={<PlainPage name="Dashboard" />} />,
    )
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))

    // Dashboard → Sales → Settings (WhatsApp panel mounts) → back to
    // Dashboard (WhatsApp panel unmounts) — the SAME stream persists.
    rerender(<AppShellStandIn page={<PlainPage name="Sales" />} />)
    rerender(<AppShellStandIn page={<WhatsAppConsumerPage />} />)
    await waitFor(() => expect(screen.getByTestId('wa-state').textContent).toBe('disconnected'))
    rerender(<AppShellStandIn page={<PlainPage name="Dashboard" />} />)

    // Give any (wrong) reconnect logic a chance to fire — none may.
    await new Promise((r) => setTimeout(r, 120))

    expect(MockSSEStream.instances.length).toBe(1) // no duplicate connection
    expect(connectAuthenticatedEventStream).toHaveBeenCalledTimes(1)
    expect(MockSSEStream.instances[0].closed).toBe(false) // presence remains

    // Multiple route changes keep the total count stable.
    rerender(<AppShellStandIn page={<PlainPage name="Purchases" />} />)
    rerender(<AppShellStandIn page={<PlainPage name="Inventory" />} />)
    rerender(<AppShellStandIn page={<WhatsAppConsumerPage />} />)
    await new Promise((r) => setTimeout(r, 50))
    expect(MockSSEStream.instances.length).toBe(1)

    unmount()
  })

  it('closing the actual application client ends presence (the stream closes exactly once)', async () => {
    const { unmount } = render(
      <AppShellStandIn page={<PlainPage name="Dashboard" />} />,
    )
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))

    // The authenticated application client disappears (sign-out unmounts
    // the app shell) — presence ends with exactly one clean close.
    unmount()

    expect(MockSSEStream.instances.length).toBe(1)
    expect(MockSSEStream.instances[0].closed).toBe(true)
  })
})

describe('Non-blocking application shell', () => {
  it('the app renders its normal UI IMMEDIATELY — it does not wait for the SSE stream', async () => {
    // The stream NEVER establishes (a hanging connect promise — WhatsApp
    // backend unreachable). The application must still render instantly.
    vi.mocked(connectAuthenticatedEventStream).mockImplementation(
      () => new Promise(() => {}) as never,
    )

    let rendered = false
    render(
      <AppShellStandIn
        page={
          <div>
            <PlainPage name="Dashboard" />
            <WhatsAppConsumerPage />
            {(() => {
              rendered = true
              return null
            })()}
          </div>
        }
      />,
    )

    // The main UI is fully painted synchronously — no suspension, no
    // waiting for SSE/Redis/Baileys/WhatsApp.
    expect(rendered).toBe(true)
    expect(screen.getByText('Dashboard')).toBeTruthy()
    // The WhatsApp consumer renders its honest unhydrated state.
    expect(screen.getByTestId('wa-state').textContent).toBe('hydrating')
  })

  it('a failing WhatsApp snapshot fetch does not prevent the main UI from loading', async () => {
    vi.mocked(fetchBackendStatus).mockRejectedValue(new Error('backend down'))

    render(
      <AppShellStandIn
        page={
          <div>
            <PlainPage name="Sales" />
            <WhatsAppConsumerPage />
          </div>
        }
      />,
    )

    expect(screen.getByText('Sales')).toBeTruthy()
    // The failed snapshot is non-fatal — the app stays up.
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.getByText('Sales')).toBeTruthy()
    expect(screen.getByTestId('wa-state').textContent).toBe('hydrating')
  })

  it('WhatsApp state updates re-render ONLY consumers — the provider subtree stays stable', async () => {
    // A plain page sibling that must NOT re-render when WhatsApp events
    // arrive (render isolation of the application shell).
    let plainRenders = 0
    function CountingPlainPage() {
      plainRenders += 1
      return <PlainPage name="Dashboard" />
    }

    const { rerender } = render(
      <AppShellStandIn
        page={
          <div>
            <CountingPlainPage />
            <WhatsAppConsumerPage />
          </div>
        }
      />,
    )
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    const rendersBeforeEvent = plainRenders

    // Force a WhatsApp state change through the provider's state (the
    // snapshot lands after the initial mount here).
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.getByTestId('wa-state').textContent).toBe('disconnected'),
      )
    })

    expect(screen.getByTestId('wa-state').textContent).toBe('disconnected')
    // The plain page was NOT re-rendered by the WhatsApp update (the
    // provider's children element kept its identity — React bailed out).
    expect(plainRenders).toBe(rendersBeforeEvent)

    rerender(
      <AppShellStandIn
        page={
          <div>
            <CountingPlainPage />
            <WhatsAppConsumerPage />
          </div>
        }
      />,
    )
  })
})
