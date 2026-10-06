/**
 * Settings hash tab persistence — focused regression tests.
 *
 * The URL hash is the canonical state for the active Settings tab:
 *   /settings           → default tab (Profile)
 *   /settings#profile   → Profile
 *   /settings#whatsapp  → WhatsApp
 *
 * The navigation is the shared segmented tab selector (the Payments page's
 * visual language) — the active tab is exposed via aria-selected.
 *
 * Regression coverage for the previous bugs:
 *   - the hash was read only ONCE on mount (Back/Forward never switched
 *     the tab — no hashchange listener);
 *   - a mount-time effect WROTE the hash (adding a spurious history entry
 *     for /settings without a hash).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import SettingsPage from '@/pages/settings/SettingsPage'

// ── Provider / feature mocks (the page's tab logic is what's under test) ────

vi.mock('@/components/providers/SessionProvider', () => ({
  useSession: () => ({
    user: { id: 'u1', email: 'owner@test' },
    appUser: { id: 'u1', email: 'owner@test', userType: 'owner' },
    isOwner: true,
    signOut: vi.fn(),
  }),
}))

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

// Stable reference (React Query returns stable data identities — a fresh
// object per render would loop ProfilePanel's storeQuery.data effect).
// vi.hoisted: the vi.mock factory runs before the module body, so the
// constant must be hoisted with it.
const STORE_DATA = vi.hoisted(() => ({
  id: 's1',
  name: 'Store',
  address: '',
  phone: '+91',
  email: '',
  website: '',
  gstin: '',
}))

vi.mock('@/features/settings/api', () => ({
  useStore: () => ({ data: STORE_DATA, isLoading: false }),
}))

vi.mock('@/features/whatsapp/useWhatsAppMessageSettings', () => ({
  useWhatsAppMessageSettings: () => ({
    isReady: true,
    settings: {
      sale: { autoSend: false, template: '' },
      purchase: { autoSend: false, template: '' },
      proforma: { autoSend: false, template: '' },
      paymentIn: { autoSend: false, template: '' },
      paymentOut: { autoSend: false, template: '' },
      statementIn: { template: '' },
      statementOut: { template: '' },
      reminder: { template: '' },
    },
  }),
}))

vi.mock('@/features/whatsapp/WhatsAppPlatformContext', () => ({
  useWhatsAppPlatformContext: () => ({ status: null, transport: 'connecting', syncing: true }),
}))

vi.mock('@/platform/whatsapp/http', () => ({
  postLogin: vi.fn(),
  postLogout: vi.fn(),
}))

vi.mock('@/platform/supabase/client', () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() } },
}))

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

/** The segmented tab button for a tab label. */
const navButton = (label: RegExp | string) =>
  screen.getByRole('tab', { name: label }) as HTMLButtonElement

/** Whether the given tab button is the ACTIVE tab (aria-selected). */
const isActive = (btn: HTMLButtonElement) => btn.getAttribute('aria-selected') === 'true'

/** The tab currently visible, derived from the rendered panel content. */
function visibleTab(): 'profile' | 'whatsapp' {
  const profileHeading = screen.queryByText('Business Profile')
  const whatsappHeading = screen.queryByText('WhatsApp Account')
  if (profileHeading) return 'profile'
  if (whatsappHeading) return 'whatsapp'
  throw new Error('Neither panel rendered')
}

beforeEach(() => {
  window.location.hash = ''
})

afterEach(() => {
  window.location.hash = ''
})

describe('SettingsPage — hash tab persistence', () => {
  it('defaults to the Profile tab when no hash is present, without writing a hash', () => {
    expect(window.location.hash).toBe('')
    renderPage()
    expect(visibleTab()).toBe('profile')
    expect(isActive(navButton('Profile'))).toBe(true)
    // Regression: the page must NOT write a hash on mount (the old effect
    // added a spurious #profile history entry to /settings).
    expect(window.location.hash).toBe('')
  })

  it('opens the WhatsApp tab immediately for /settings#whatsapp (refresh/direct link)', () => {
    window.location.hash = 'whatsapp'
    renderPage()
    expect(visibleTab()).toBe('whatsapp')
    expect(isActive(navButton('WhatsApp'))).toBe(true)
  })

  it('opens the Profile tab for /settings#profile', () => {
    window.location.hash = 'profile'
    renderPage()
    expect(visibleTab()).toBe('profile')
  })

  it('falls back to the default tab for an INVALID hash', () => {
    window.location.hash = 'bogus'
    renderPage()
    expect(visibleTab()).toBe('profile')
    expect(isActive(navButton('Profile'))).toBe(true)
  })

  it('clicking WhatsApp updates the hash and switches the tab', () => {
    renderPage()

    fireEvent.click(navButton('WhatsApp'))
    expect(window.location.hash).toBe('#whatsapp')
    expect(visibleTab()).toBe('whatsapp')
  })

  it('clicking Profile updates the hash and switches the tab', () => {
    window.location.hash = 'whatsapp'
    renderPage()

    fireEvent.click(navButton('Profile'))
    expect(window.location.hash).toBe('#profile')
    expect(visibleTab()).toBe('profile')
  })

  it('Back/Forward navigation (hashchange) switches the tab', async () => {
    window.location.hash = 'whatsapp'
    renderPage()
    expect(visibleTab()).toBe('whatsapp')

    // Simulate the browser Back button: the hash changes without a click.
    act(() => {
      window.location.hash = 'profile'
    })
    await waitFor(() => expect(visibleTab()).toBe('profile'))

    // Simulate Forward.
    act(() => {
      window.location.hash = 'whatsapp'
    })
    await waitFor(() => expect(visibleTab()).toBe('whatsapp'))
  })

  it('clicking the already-active tab does not push a duplicate history entry', () => {
    window.location.hash = 'whatsapp'
    renderPage()
    expect(window.location.hash).toBe('#whatsapp')

    fireEvent.click(navButton('WhatsApp'))
    expect(window.location.hash).toBe('#whatsapp')
    expect(visibleTab()).toBe('whatsapp')
  })
})
