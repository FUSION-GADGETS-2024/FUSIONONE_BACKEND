/**
 * platform/whatsapp/sse.ts — authenticated fetch-SSE transport tests.
 *
 * Covers the transport-level self-healing that replaces what the old
 * same-origin EventSource bridge gave the Next.js app:
 *   - Authorization header + SSE frame parsing (comments, multi-event chunks)
 *   - 401 → Supabase session refresh → single retry with the fresh token
 *   - STALL WATCHDOG: a silently-dead stream (no bytes for 45s) is aborted
 *     and surfaced as an error so the hook's reconnect loop takes over
 *   - the watchdog resets on activity (keepalives/events keep the stream)
 *   - close() aborts the fetch, clears the watchdog, ends the iterator
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BackendEventEnvelope } from '@/platform/whatsapp/backend'

// ── Supabase session mock ───────────────────────────────────────────────────

const sessionMock = {
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}

vi.mock('@/platform/supabase/client', () => ({
  supabase: { auth: sessionMock },
}))

// ── Controllable SSE response body ──────────────────────────────────────────

class ControlledBody {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  readonly body: ReadableStream<Uint8Array>

  constructor() {
    this.body = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c
      },
    })
  }

  write(text: string): void {
    this.controller?.enqueue(new TextEncoder().encode(text))
  }

  close(): void {
    this.controller?.close()
  }

  /** Wire a fetch AbortSignal to the body, mimicking the browser: aborting
 *  the fetch rejects pending reads of its response body. */
  static tieToSignal(signal: AbortSignal, bodies: ControlledBody[]): void {
    signal.addEventListener('abort', () => {
      const err = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      })
      for (const b of bodies) b.error(err)
    })
  }

  private error(err: unknown): void {
    this.controller?.error(err)
  }
}

interface FetchCall {
  url: string
  init: RequestInit
}

let fetchMock: ReturnType<typeof vi.fn>
let calls: FetchCall[]
let bodies: ControlledBody[]
let responses: Array<Record<string, unknown>>

beforeEach(async () => {
  vi.stubEnv('VITE_FUSIONONE_BACKEND_BASE', 'https://wa.example.test')
  vi.resetModules()

  sessionMock.getSession.mockResolvedValue({
    data: { session: { access_token: 'token-A' } },
  })
  sessionMock.refreshSession.mockResolvedValue({ data: { session: null } })

  calls = []
  bodies = []
  responses = []
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = new ControlledBody()
    bodies.push(body)
    ControlledBody.tieToSignal(init.signal as AbortSignal, [body])
    const response = { ok: true, status: 200, body: body.body, json: async () => ({}) }
    responses.push(response)
    return response
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const EVENT_1 = 'data: {"type":"WHATSAPP_STATE_CHANGED","timestamp":"t1","data":{"state":"PAIRING"}}'
const EVENT_2 = 'data: {"type":"WHATSAPP_QR_COUNTDOWN","timestamp":"t2","data":{"remainingSeconds":59}}'

async function connect() {
  const { connectAuthenticatedEventStream } = await import('@/platform/whatsapp/sse')
  return connectAuthenticatedEventStream()
}

/** Drain the stream into an array; returns the promise that rejects on error. */
function consume(stream: { envelope: AsyncIterable<BackendEventEnvelope> }, sink: BackendEventEnvelope[]) {
  return (async () => {
    for await (const env of stream.envelope) sink.push(env)
  })()
}

// ─────────────────────────────────────────────────────────────────────────────

describe('connectAuthenticatedEventStream — request + parsing', () => {
  it('sends the Bearer token + Accept headers to GET /api/events', async () => {
    const stream = await connect()
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://wa.example.test/api/events')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer token-A',
      Accept: 'text/event-stream',
    })
    stream.close()
  })

  it('parses data frames and ignores comment/keepalive lines', async () => {
    const stream = await connect()
    const received: BackendEventEnvelope[] = []
    const consumer = consume(stream, received)

    bodies[0].write(': connected\n\n')
    bodies[0].write(`${EVENT_1}\n\n`)
    bodies[0].write(': ping\n\n')
    bodies[0].write(`${EVENT_2}\n\n`)
    await new Promise((r) => setTimeout(r, 0))

    expect(received.length).toBe(2)
    expect(received[0]).toEqual({
      type: 'WHATSAPP_STATE_CHANGED',
      timestamp: 't1',
      data: { state: 'PAIRING' },
    })
    expect(received[1]).toEqual({
      type: 'WHATSAPP_QR_COUNTDOWN',
      timestamp: 't2',
      data: { remainingSeconds: 59 },
    })

    bodies[0].close()
    await consumer // ends cleanly
    stream.close()
  })

  it('parses multiple events that arrive in ONE network chunk (split on blank lines)', async () => {
    const stream = await connect()
    const received: BackendEventEnvelope[] = []
    const consumer = consume(stream, received)

    bodies[0].write(`${EVENT_1}\n\n${EVENT_2}\n\n`)
    await new Promise((r) => setTimeout(r, 0))

    expect(received.length).toBe(2)
    bodies[0].close()
    await consumer
    stream.close()
  })

  it('drops malformed data frames without killing the stream', async () => {
    const stream = await connect()
    const received: BackendEventEnvelope[] = []
    const consumer = consume(stream, received)

    bodies[0].write('data: not-json\n\n')
    bodies[0].write(`${EVENT_1}\n\n`)
    await new Promise((r) => setTimeout(r, 0))

    expect(received.length).toBe(1)
    bodies[0].close()
    await consumer
    stream.close()
  })
})

describe('connectAuthenticatedEventStream — 401 auth refresh', () => {
  it('refreshes the Supabase session once and retries with the fresh token', async () => {
    // First attempt: expired token → 401
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const body = new ControlledBody()
      bodies.push(body)
      ControlledBody.tieToSignal(init.signal as AbortSignal, [body])
      const response = {
        ok: false,
        status: 401,
        body: null,
        json: async () => ({ error: { code: 'API_AUTH_INVALID', message: 'JWT expired' } }),
      }
      responses.push(response)
      return response
    })
    sessionMock.refreshSession.mockResolvedValue({
      data: { session: { access_token: 'token-B' } },
    })

    const stream = await connect()

    // The retry used the fresh token and delivers events.
    expect(calls.length).toBe(2)
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer token-B')
    expect(sessionMock.refreshSession).toHaveBeenCalledTimes(1)

    const received: BackendEventEnvelope[] = []
    const consumer = consume(stream, received)
    bodies[1].write(`${EVENT_1}\n\n`)
    await new Promise((r) => setTimeout(r, 0))
    expect(received.length).toBe(1)
    bodies[1].close()
    await consumer
    stream.close()
  })

  it('fails with the backend error when no fresh session is available', async () => {
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const response = {
        ok: false,
        status: 401,
        body: null,
        json: async () => ({ error: { code: 'API_AUTH_INVALID', message: 'Invalid JWT' } }),
      }
      responses.push(response)
      return response
    })
    sessionMock.refreshSession.mockResolvedValue({ data: { session: null } })

    await expect(connect()).rejects.toThrow('Invalid JWT')
    expect(calls.length).toBe(1) // no second attempt
  })
})

describe('connectAuthenticatedEventStream — connect timeout (wedged fetch recovery)', () => {
  it('aborts a connect attempt whose fetch never reaches headers', async () => {
    // Regression: a fetch that starts into a network blackhole can stay
    // pending forever. Without the connect timeout this wedged the hook's
    // reconnect loop permanently (the UI stayed deaf until a page reload).
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation((url: string, init: RequestInit) => {
        calls.push({ url, init })
        const signal = init.signal as AbortSignal
        // Never resolves on its own — only the AbortController can end it.
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          )
        })
      })

      const attempt = connect()
      const rejection = expect(attempt).rejects.toThrow()

      // 15s connect timeout → the wedged fetch is aborted and surfaced.
      await vi.advanceTimersByTimeAsync(15_000)
      await rejection
      expect(calls.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('connectAuthenticatedEventStream — stall watchdog', () => {
  it('aborts the stream after 45s of silence and surfaces an error (silent death recovery)', async () => {
    vi.useFakeTimers()
    try {
      const stream = await connect()
      const received: BackendEventEnvelope[] = []
      const consumer = consume(stream, received)
      // Attach the rejection expectation IMMEDIATELY (under fake timers the
      // watchdog can fire while the test awaits, and a momentarily-unhandled
      // rejection would be flagged by the runner).
      const rejection = expect(consumer).rejects.toThrow('SSE stream stalled')

      // One event arrives, then the connection goes silently dead
      // (no FIN/RST — a pending read() that never settles).
      bodies[0].write(`${EVENT_1}\n\n`)
      await vi.advanceTimersByTimeAsync(1000)
      expect(received.length).toBe(1)

      // 45s of silence → watchdog aborts → the iterator rejects.
      await vi.advanceTimersByTimeAsync(45_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the watchdog on activity — keepalives keep a live stream open', async () => {
    vi.useFakeTimers()
    try {
      const stream = await connect()
      const received: BackendEventEnvelope[] = []
      const consumer = consume(stream, received)

      // t=0: event
      bodies[0].write(`${EVENT_1}\n\n`)
      await vi.advanceTimersByTimeAsync(1000)

      // t=44s: a keepalive comment arrives just inside the 45s window.
      await vi.advanceTimersByTimeAsync(43_000)
      bodies[0].write(': ping\n\n')

      // t=54s: without the reset, the watchdog (armed at t=0) would have
      // fired at t=45s. The stream must still be alive.
      await vi.advanceTimersByTimeAsync(10_000)
      bodies[0].write(`${EVENT_2}\n\n`)
      await vi.advanceTimersByTimeAsync(1000)
      expect(received.length).toBe(2)

      // Now true silence → stall fires 45s after the last bytes.
      const rejection = expect(consumer).rejects.toThrow('SSE stream stalled')
      await vi.advanceTimersByTimeAsync(45_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('close() aborts the fetch, clears the watchdog, and ends the iterator cleanly', async () => {
    vi.useFakeTimers()
    try {
      const stream = await connect()
      const received: BackendEventEnvelope[] = []
      const consumer = consume(stream, received)

      bodies[0].write(`${EVENT_1}\n\n`)
      await vi.advanceTimersByTimeAsync(0)
      expect(received.length).toBe(1)

      stream.close()
      stream.close() // idempotent

      // The consumer ends (no error) — a clean close, not a stall.
      await consumer

      // The watchdog timer was cleared: nothing fires later.
      await vi.advanceTimersByTimeAsync(120_000)
      expect((calls[0].init.signal as AbortSignal).aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive stall bound (pairing cadence)
// ─────────────────────────────────────────────────────────────────────────────

describe('connectAuthenticatedEventStream — adaptive stall bound (getStallTimeoutMs)', () => {
  async function connectAdaptive(getStallTimeoutMs: () => number) {
    const { connectAuthenticatedEventStream } = await import('@/platform/whatsapp/sse')
    return connectAuthenticatedEventStream({ getStallTimeoutMs })
  }

  it('aborts a pairing stream after 10s of silence (10 missed 1s countdown ticks)', async () => {
    vi.useFakeTimers()
    try {
      const stream = await connectAdaptive(() => 10_000)
      const received: BackendEventEnvelope[] = []
      const consumer = consume(stream, received)
      const rejection = expect(consumer).rejects.toThrow('SSE stream stalled')

      // Countdown events tick every second... then the stream goes silent.
      bodies[0].write(`${EVENT_2}\n\n`)
      await vi.advanceTimersByTimeAsync(1000)
      expect(received.length).toBe(1)

      // 10s of silence while PAIRING (guaranteed 1 event/s) = provably dead.
      await vi.advanceTimersByTimeAsync(10_000)
      await rejection

      // The fetch was aborted (the transport gave up on the dead stream).
      expect(calls[0].init.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT fire the default 45s watchdog early for a non-pairing stream', async () => {
    vi.useFakeTimers()
    try {
      const stream = await connectAdaptive(() => 45_000)
      const received: BackendEventEnvelope[] = []
      const consumer = consume(stream, received)

      bodies[0].write(`${EVENT_1}\n\n`)
      await vi.advanceTimersByTimeAsync(1000)

      // 30s silence (a keepalive-less window shorter than the default bound):
      // the stream must still be alive — the bound is 45s here.
      await vi.advanceTimersByTimeAsync(30_000)
      bodies[0].write(`${EVENT_2}\n\n`)
      await vi.advanceTimersByTimeAsync(1000)
      expect(received.length).toBe(2)

      stream.close()
      await consumer
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads the bound on every re-arm — a state change tightens an armed watchdog', async () => {
    vi.useFakeTimers()
    try {
      // The consumer starts with the default 45s bound (state unknown), then
      // reports pairing after the first event arrives — exactly how the hook
      // drives it through statusRef.
      let bound = 45_000
      const stream = await connectAdaptive(() => bound)
      const received: BackendEventEnvelope[] = []
      const consumer = consume(stream, received)
      const rejection = expect(consumer).rejects.toThrow('SSE stream stalled')

      bodies[0].write(`${EVENT_1}\n\n`) // pairing state event → consumer tightens
      bound = 10_000
      await vi.advanceTimersByTimeAsync(1000)

      // 30s of silence: under the OLD bound the stream would still be
      // considered alive; the tightened re-armed watchdog fires at 10s.
      await vi.advanceTimersByTimeAsync(10_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
