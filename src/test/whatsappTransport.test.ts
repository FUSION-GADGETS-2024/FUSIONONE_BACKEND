/**
 * WhatsApp transport tests — the authenticated browser chain:
 *   platform/whatsapp/url.ts    (hosted-backend URL builder)
 *   platform/whatsapp/backend.ts (backend event mapping)
 *   platform/whatsapp/http.ts    (Bearer JWT REST calls)
 *
 * These replace the old server-side whatsappService singleton tests: the
 * SSE consumption semantics (event mapping, snapshot race guard, reconnect
 * backoff) now live in the browser hook and are covered by
 * useWhatsAppPlatform.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mapBackendEvent } from '@/platform/whatsapp/backend'

describe('waUrl — backend URL builder', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('direct mode: absolute backend origin', async () => {
    vi.stubEnv('VITE_FUSIONONE_BACKEND_BASE', 'https://backend-fusionone.fusiongadgets.in')
    vi.resetModules()
    const { waUrl } = await import('@/platform/whatsapp/url')
    expect(waUrl('/api/status')).toBe('https://backend-fusionone.fusiongadgets.in/api/status')
    expect(waUrl('/api/events?foo=1')).toBe('https://backend-fusionone.fusiongadgets.in/api/events?foo=1')
  })

  it('strips a trailing slash from the base', async () => {
    vi.stubEnv('VITE_FUSIONONE_BACKEND_BASE', 'https://backend-fusionone.fusiongadgets.in/')
    vi.resetModules()
    const { waUrl } = await import('@/platform/whatsapp/url')
    expect(waUrl('/api/status')).toBe('https://backend-fusionone.fusiongadgets.in/api/status')
  })
})

describe('mapBackendEvent — envelope mapping', () => {
  const envelope = (type: string, data: Record<string, unknown> = {}) => ({
    type,
    timestamp: '2026-09-29T00:00:00.000Z',
    data,
  })

  it('maps every business event type', () => {
    expect(mapBackendEvent(envelope('WHATSAPP_STATE_CHANGED'))?.type).toBe('state-changed')
    expect(mapBackendEvent(envelope('WHATSAPP_QR_AVAILABLE'))?.type).toBe('qr-available')
    expect(mapBackendEvent(envelope('WHATSAPP_QR_COUNTDOWN'))?.type).toBe('qr-countdown')
    expect(mapBackendEvent(envelope('MESSAGE_SEND_RESULT'))?.type).toBe('send-result')
    expect(mapBackendEvent(envelope('SECURITY_EVENT'))?.type).toBe('security-event')
  })

  it('does NOT forward SERVER_STATE_CHANGED (server lifecycle, not WhatsApp)', () => {
    expect(mapBackendEvent(envelope('SERVER_STATE_CHANGED'))).toBeNull()
  })

  it('ignores unknown event types (forward compatibility)', () => {
    expect(mapBackendEvent(envelope('SOMETHING_NEW'))).toBeNull()
  })

  it('preserves payload data verbatim', () => {
    const mapped = mapBackendEvent(envelope('WHATSAPP_QR_AVAILABLE', { qr: 'data:...', expiresAt: 'x' }))
    expect(mapped?.data).toEqual({ qr: 'data:...', expiresAt: 'x' })
  })
})

describe('http client — Bearer JWT on every call', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    // Deterministic backend URL regardless of the developer's .env.local
    vi.stubEnv('VITE_FUSIONONE_BACKEND_BASE', 'https://wa.example.test')
    vi.resetModules()
    // A session with an access token
    vi.doMock('@/platform/supabase/client', () => ({
      supabase: {
        auth: {
          getSession: vi.fn().mockResolvedValue({
            data: { session: { access_token: 'test-access-token' } },
          }),
        },
      },
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.doUnmock('@/platform/supabase/client')
  })

  it('sends the Authorization header with the session access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ server: { state: 'running' }, whatsapp: { state: 'IDLE', session: 'NONE' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchBackendStatus } = await import('@/platform/whatsapp/http')
    await fetchBackendStatus()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://wa.example.test/api/status')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test-access-token',
    })
  })

  it('fails fast when signed out (no session token)', async () => {
    vi.doMock('@/platform/supabase/client', () => ({
      supabase: {
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
        },
      },
    }))
    vi.resetModules()
    const { fetchBackendStatus } = await import('@/platform/whatsapp/http')
    await expect(fetchBackendStatus()).rejects.toThrow('Authentication required')
  })
})
