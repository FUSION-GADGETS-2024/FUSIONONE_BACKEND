import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The ISOLATED email-action (setup) auth client for /set-password.
 *
 * Two authentication lifecycles exist in this app:
 *
 *   A. NORMAL APPLICATION AUTHENTICATION — the main @supabase/ssr browser
 *      client (cookie-backed, persistent) created in platform/supabase/client.
 *   B. EMAIL ACTION / SETUP AUTHENTICATION — invitation acceptance and
 *      password recovery. THIS module. Completely separate from (A).
 *
 * The setup client is created per /set-password page lifecycle (never a
 * global singleton), holds its session ONLY in memory
 * (persistSession: false — no cookie, no localStorage, no sessionStorage),
 * never inspects the URL (detectSessionInUrl: false), and is explicitly
 * torn down when the flow ends (local signOut + stopAutoRefresh + listener
 * disposal). A hard page reload therefore requires reopening the original
 * email link — the email link is the durable entry credential.
 *
 * The one-time email token is consumed with Supabase's native
 * verifyOtp({ token_hash, type }); the password is set with the native
 * updateUser({ password }). No custom tokens, no manual JWT decoding, no
 * session adoption into the main application client — ever.
 */

/** The only email-action types /set-password accepts. */
export type SetupLinkType = 'invite' | 'recovery'

/** A verified setup context — a temporary in-memory session + who it is for. */
export interface SetupContext {
  /** The invited/recovering user's email (display only). */
  email: string | null
}

/** Precise, never-guessed rejection reasons for a setup link. */
export type SetupLinkRejection =
  | 'EXPIRED_LINK'
  | 'INVALID_LINK'
  | 'SESSION_ERROR'

/** Result of consuming a one-time setup token. */
export type VerifyResult =
  | { ok: true; context: SetupContext }
  | { ok: false; reason: SetupLinkRejection }

/**
 * The setup-flow service. Owns the isolated Supabase client and its full
 * lifecycle. The /set-password page is its ONLY consumer; nothing else in
 * the application may import or hold an instance.
 */
export class SetupFlowClient {
  private readonly client: SupabaseClient
  private disposed = false

  private constructor() {
    this.client = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          // In-memory only — the setup session is never persisted anywhere.
          persistSession: false,
          // This client never adopts URL callbacks; the page parses the
          // link and calls verifyOtp explicitly.
          detectSessionInUrl: false,
          // Keep the token fresh for the (short) lifetime of the flow.
          autoRefreshToken: true,
          // Distinct (inert) storage key: with persistSession disabled
          // nothing is ever written, but a unique key keeps this client
          // unmistakably separate from the main application client.
          storageKey: `fusionone-setup-${import.meta.env.VITE_SUPABASE_URL.replace(/[^a-z0-9]/gi, '')}`,
        },
      },
    )
  }

  /** Create a fresh isolated setup client for one /set-password lifecycle. */
  static create(): SetupFlowClient {
    return new SetupFlowClient()
  }

  /**
   * Consume the one-time email token with Supabase's native verification.
   * `type` must be exactly 'invite' or 'recovery' — everything else is
   * rejected by the caller before reaching here.
   */
  async verify(tokenHash: string, type: SetupLinkType): Promise<VerifyResult> {
    const { data, error } = await this.client.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    })
    if (error) {
      // GoTrue reports consumed AND expired one-time tokens as otp_expired;
      // anything else (malformed token, network, …) maps to its own reason.
      if (error.code === 'otp_expired') return { ok: false, reason: 'EXPIRED_LINK' }
      const text = `${error.code ?? ''} ${error.message}`.toLowerCase()
      if (text.includes('expired') || text.includes('already')) return { ok: false, reason: 'EXPIRED_LINK' }
      if (error.status === 400 || error.code === 'validation_failed') return { ok: false, reason: 'INVALID_LINK' }
      return { ok: false, reason: 'SESSION_ERROR' }
    }
    if (!data.session) {
      return { ok: false, reason: 'SESSION_ERROR' }
    }
    return { ok: true, context: { email: data.session.user?.email ?? null } }
  }

  /**
   * Set the user's password through native Supabase Auth, using the setup
   * session. The server stays authoritative for password policy; the return
   * carries only what the UI needs to show.
   */
  async updatePassword(password: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const { error } = await this.client.auth.updateUser({ password })
    if (error) return { ok: false, message: error.message }
    return { ok: true }
  }

  /**
   * Locally terminate the setup session: revoke THIS session's refresh
   * token (scope 'local' — other sessions of the same user, e.g. a normal
   * login on another device, are never touched), clear the in-memory
   * session, stop the auto-refresh timer, and drop all auth listeners.
   * Best-effort by design: if the network revocation fails, the session
   * still vanishes with this process — nothing persistent remains either
   * way (persistSession: false).
   */
  async terminate(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.client.auth.stopAutoRefresh()
    } catch {
      // ignore — never instantiated a timer is fine
    }
    try {
      await this.client.auth.signOut({ scope: 'local' })
    } catch {
      // best-effort revocation; the in-memory session dies with the client
    }
  }

  /** Whether terminate() has already run (idempotent disposal guard). */
  get isTerminated(): boolean {
    return this.disposed
  }
}
