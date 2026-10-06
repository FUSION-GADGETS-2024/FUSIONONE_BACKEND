import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/platform/supabase/client'
import { clearQueryCache } from '@/features/invalidate'
import { clearInvoicePdfCache } from '@/features/invoice/pdf-cache'

/** Raw auth identity (Supabase session user). */
export interface SessionUser {
  id: string
  email: string
}

/** The application role — the ONLY role field (owner | user). */
export type AppUserType = 'owner' | 'user'

/** A verified, provisioned FUSION ONE application user. */
export interface AppUser {
  id: string
  email: string
  userType: AppUserType
  /** Personal display name (null = profile not completed yet). */
  displayName: string | null
}

/**
 * The application access state — one explicit state machine instead of
 * role/verification/onboarding conditions scattered across components.
 *
 *   LOADING                — session / app-user / store resolution in flight
 *   UNAUTHENTICATED        — no Supabase session
 *   EMAIL_UNVERIFIED       — session exists, email not verified (no access)
 *   NO_ACCESS              — verified but no authorized FUSION ONE user
 *                            (missing row, user_type NULL/invalid — fail closed)
 *   BLOCKED                — verified + provisioned but status = 'blocked'
 *                            (owner-blocked account: app access denied — never
 *                            onboarding, never a store-setup problem)
 *   OWNER_SETUP_REQUIRED   — the single owner whose store is not configured
 *                            (onboarding is STORE-level, owner-only)
 *   READY                  — owner or user with full shared-data access
 *
 * There is deliberately NO setup state in this machine. Invitation and
 * password-recovery authentication is a SEPARATE lifecycle owned entirely
 * by /set-password and its isolated setup client — it never appears as an
 * application session, so this provider never classifies it.
 */
export type AccessState =
  | 'LOADING'
  | 'UNAUTHENTICATED'
  | 'EMAIL_UNVERIFIED'
  | 'NO_ACCESS'
  | 'BLOCKED'
  | 'OWNER_SETUP_REQUIRED'
  | 'READY'

interface SessionContextType {
  /** Raw auth identity (kept for existing consumers). */
  user: SessionUser | null
  /** Resolved application user (owner/user) — null unless authorized. */
  appUser: AppUser | null
  state: AccessState
  /** True while the access state is being resolved. */
  isLoading: boolean
  /** True only for the application owner (real authorization state). */
  isOwner: boolean
  /**
   * Whether the authorized user has completed their personal profile
   * (display_name present and non-blank). Derived from the same
   * app-user row the access state uses — never a stored flag, never a
   * second request. A profile-incomplete user is still a fully
   * authorized user (verification/role/status are unaffected); the
   * profile-completion gate is a POST-AUTH concern, not an auth state.
   */
  profileComplete: boolean
  signOut: () => Promise<void>
  /** Re-run access resolution (e.g. after verification/resend). */
  refreshAccess: () => Promise<void>
}

const SessionContext = createContext<SessionContextType | null>(null)

export function useSession(): SessionContextType {
  const ctx = useContext(SessionContext)
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  return ctx
}

/** The caller's application-account row (role + access status + profile). */
interface AppUserRow {
  userType: AppUserType
  status: 'active' | 'blocked'
  displayName: string | null
}

interface RawSession {
  id: string
  email: string
  emailConfirmed: boolean
}

function toRawSession(session: Session | null): RawSession | null {
  if (!session) return null
  // Only a NORMAL password login is an application session — the same rule
  // the backend and every RLS helper enforce (amr method must be 'password').
  // A session established any other way (only possible as a pre-refactor
  // legacy cookie) is not an application session: resolve as none. The
  // provider separately triggers a one-time local signOut to clean it up.
  if (mainSessionAuthMethod(session) !== 'password') return null
  const user = session.user
  return {
    id: user.id,
    email: user.email ?? '',
    emailConfirmed: user.email_confirmed_at != null,
  }
}

/** Decode the session's own access-token claims (no verification needed —
 *  the token is Supabase-issued and held by this client). */
function mainSessionAuthMethod(session: Session | null): string | null {
  if (!session) return null
  const amr = (session.user as { amr?: { method?: string }[] } | undefined)?.amr
  if (amr?.[0]?.method) return amr[0].method
  try {
    const payload = JSON.parse(
      atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
    ) as { amr?: { method?: string }[] }
    const method = payload.amr?.[0]?.method
    return typeof method === 'string' ? method : null
  } catch {
    return null
  }
}

/**
 * THE single authoritative session + application-access state for the SPA.
 *
 * The session is read once on mount and kept current via onAuthStateChange
 * (Supabase's own mechanism — no custom token storage). Application access
 * is then resolved from three sources, in order:
 *   1. the session itself (verification),
 *   2. the caller's public.users row (self-read through RLS),
 *   3. for the owner, the shared store row (setup completion).
 *
 * Only a NORMAL password login is an application session (the same rule the
 * backend and every RLS helper enforce: JWT amr method must be 'password').
 * The main client can no longer acquire any other kind of session — but as
 * one-time hygiene for sessions adopted under the OLD architecture (stale
 * cookies from before that refactor), a non-password session still sitting
 * in the main client is signed out LOCALLY and treated as unauthenticated.
 * It is never classified into an application state.
 *
 * Whenever the signed-in IDENTITY changes, the whole user-scoped cache
 * (queries + invoice PDFs) is cleared so a new session can never be served
 * the previous user's data.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [raw, setRaw] = useState<RawSession | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const lastUserIdRef = useRef<string | null>(null)
  const hygieneRef = useRef(false)

  // ONE-TIME legacy-session hygiene. The main client can no longer acquire
  // any session except a password login (detectSessionInUrl is off and
  // nothing calls setSession), but a browser that still holds an OLD
  // invitation/recovery session in the cookie (adopted by the pre-refactor
  // architecture) would otherwise sit in the app forever: it passes the
  // self-read policy, resolves as READY, and is then denied by every
  // business policy (amr must be 'password' — the same rule the backend and
  // RLS enforce). Such a session is NOT a normal application session: sign
  // it out locally (scope 'local' — only that session's refresh token) and
  // treat the browser as unauthenticated. It is never classified into an
  // application state.
  const rejectNonPasswordSession = (session: Session | null) => {
    if (!session || hygieneRef.current) return
    if (mainSessionAuthMethod(session) === 'password') return
    hygieneRef.current = true
    void supabase.auth
      .signOut({ scope: 'local' })
      .catch(() => undefined)
      .then(() => {
        setRaw(null)
        setSessionLoaded(true)
      })
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      rejectNonPasswordSession(data.session)
      setRaw(toRawSession(data.session))
      setSessionLoaded(true)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      rejectNonPasswordSession(session)
      setRaw(toRawSession(session))
      setSessionLoaded(true)
    })

    return () => {
      sub.subscription.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cache transition safety: the user-scoped cache must never outlive its
  // identity. Clear on ANY identity change (sign-in as someone else,
  // sign-out) — not just SIGNED_OUT.
  const currentUserId = raw?.id ?? null
  useEffect(() => {
    if (lastUserIdRef.current !== currentUserId) {
      const hadUser = lastUserIdRef.current !== null
      lastUserIdRef.current = currentUserId
      if (hadUser || currentUserId === null) {
        clearQueryCache()
        void clearInvoicePdfCache()
      }
    }
  }, [currentUserId])

  const sessionUser = raw ? { id: raw.id, email: raw.email } : null

  // The caller's application-user row. RLS confines the read to the caller's
  // own row; a missing row, user_type outside owner/user, or any status other
  // than exactly 'active' is fail-closed (blocked).
  const appUserQuery = useQuery({
    queryKey: ['app-user', raw?.id],
    enabled: !!raw && raw.emailConfirmed,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<AppUserRow | null> => {
      const { data, error } = await supabase
        .from('users')
        .select('user_type, status, display_name')
        .eq('id', raw!.id)
        .maybeSingle()
      if (error) throw error
      const row = data as { user_type?: unknown; status?: unknown; display_name?: unknown } | null
      const userType = row?.user_type
      if (userType !== 'owner' && userType !== 'user') return null
      return {
        userType,
        status: row?.status === 'active' ? 'active' : 'blocked',
        displayName: typeof row?.display_name === 'string' ? row.display_name : null,
      }
    },
  })

  // The shared store row — needed by the owner's setup gate (and by the app
  // shell/sidebar once READY). Same queryKey as useStore: one cached query.
  const needsStoreCheck = appUserQuery.data?.userType === 'owner'
  const storeQuery = useQuery({
    queryKey: ['store', 'current'],
    enabled: needsStoreCheck,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<unknown | null> => {
      const { data, error } = await supabase.from('store').select('*').maybeSingle()
      if (error) throw error
      return (data as unknown | null) ?? null
    },
  })

  const state: AccessState = useMemo(() => {
    if (!sessionLoaded && !raw) return 'LOADING'
    if (!raw) return 'UNAUTHENTICATED'
    if (!raw.emailConfirmed) return 'EMAIL_UNVERIFIED'
    if (appUserQuery.isLoading) return 'LOADING'
    if (!appUserQuery.data) return 'NO_ACCESS' // missing row, NULL or invalid — fail closed
    if (appUserQuery.data.status === 'blocked') return 'BLOCKED'
    if (appUserQuery.data.userType === 'user') return 'READY'
    // owner: store-level onboarding gate (owner-only; users are never gated)
    if (storeQuery.isLoading) return 'LOADING'
    if (storeQuery.isSuccess) {
      const store = storeQuery.data as { onboarding_complete?: boolean } | null
      if (!store || !store.onboarding_complete) return 'OWNER_SETUP_REQUIRED'
    }
    return 'READY'
  }, [sessionLoaded, raw, appUserQuery.isLoading, appUserQuery.data, storeQuery.isLoading, storeQuery.isSuccess, storeQuery.data])

  const appUser: AppUser | null =
    state === 'READY' && raw
      ? {
          id: raw.id,
          email: raw.email,
          userType: appUserQuery.data!.userType,
          displayName: appUserQuery.data!.displayName,
        }
      : null

  // Profile completeness is DERIVED from the already-loaded app-user row —
  // the display_name field itself is the single source of truth (there is
  // deliberately no profile_completed flag anywhere). Meaningful only for
  // an authorized user; every other access state routes to its own page
  // long before the profile gate applies.
  const profileComplete =
    appUserQuery.data != null &&
    appUserQuery.data.displayName != null &&
    appUserQuery.data.displayName.trim().length > 0

  // NOTE on signOut scope: the normal application sign-out intentionally
  // uses Supabase's DEFAULT (global) scope — this app's product contract is
  // one operator account per browser, and a global sign-out revokes the
  // user's other device sessions too. The SETUP flow's termination (in
  // setup-client.ts) uses scope 'local' and never reaches this code.
  const signOut = async () => {
    await supabase.auth.signOut()
    navigate('/login')
  }

  const refreshAccess = async () => {
    await supabase.auth.refreshSession().catch(() => undefined)
    await queryClient.invalidateQueries({ queryKey: ['app-user'] })
    await queryClient.invalidateQueries({ queryKey: ['store', 'current'] })
  }

  const value = useMemo<SessionContextType>(
    () => ({
      user: sessionUser,
      appUser,
      state,
      isLoading: state === 'LOADING',
      isOwner: appUser?.userType === 'owner',
      profileComplete,
      signOut,
      refreshAccess,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionUser, appUser, state, profileComplete, queryClient],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
