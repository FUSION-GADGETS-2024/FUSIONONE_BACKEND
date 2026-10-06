import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router'
import { useSession, type AccessState } from '@/components/providers/SessionProvider'

/**
 * Route guards for the application-access state model.
 *
 * The access state (resolved once in SessionProvider) is the single source
 * of truth — no role/verification/onboarding conditions live in individual
 * pages. Guards only MAP states to destinations:
 *
 *   LOADING                → render nothing (no flash of the wrong page)
 *   UNAUTHENTICATED        → /login?redirect=<path>
 *   EMAIL_UNVERIFIED       → /verify-email
 *   NO_ACCESS              → /no-access (terminal, sign out)
 *   BLOCKED                → /blocked (terminal, sign out — never onboarding)
 *   OWNER_SETUP_REQUIRED   → /setup-store (owner-only wizard)
 *   READY                  → the application
 *
 * PROFILE COMPLETION is a POST-AUTH gate (deliberately NOT a state in the
 * machine): an authorized user (READY, or the owner whose store setup is
 * still pending — personal profile completes BEFORE store onboarding)
 * whose display_name is missing is routed to /profile-setup before any
 * application route, the store wizard, or /login can render. Profile
 * completeness is derived from the app-user row (display_name present and
 * non-blank) — never a stored flag.
 *
 * There is deliberately no setup state here: /set-password owns the
 * invitation/recovery lifecycle entirely on its own (isolated setup client,
 * outside RequireAppAccess) and is never a destination of the application
 * access machine.
 */

/** Where a given access state should land (null = stay on the page). */
function destinationFor(state: AccessState): string | null {
  switch (state) {
    case 'UNAUTHENTICATED':
      return '/login'
    case 'EMAIL_UNVERIFIED':
      return '/verify-email'
    case 'NO_ACCESS':
      return '/no-access'
    case 'BLOCKED':
      return '/blocked'
    case 'OWNER_SETUP_REQUIRED':
      return '/setup-store'
    default:
      return null
  }
}

/**
 * An AUTHORIZED application user: READY (user or owner with store), or the
 * owner whose store setup is still pending. Both may (must) complete their
 * personal profile first — the profile gate precedes store onboarding.
 */
function isAuthorized(state: AccessState): boolean {
  return state === 'READY' || state === 'OWNER_SETUP_REQUIRED'
}

/**
 * A safe INTERNAL route for return/redirect semantics: never an external
 * URL (must start with a single '/'), never an auth/setup page (those
 * would loop or misroute). Returns null for anything unsafe — callers
 * fall back to /home.
 */
export function safeReturnTo(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null
  if (candidate.includes('://') || candidate.includes('\\')) return null
  const forbidden = [
    '/profile-setup',
    '/login',
    '/set-password',
    '/forgot-password',
    '/verify-email',
    '/no-access',
    '/blocked',
    '/setup-store',
    '/onboarding',
  ]
  if (
    forbidden.some(
      (p) => candidate === p || candidate.startsWith(p + '/') || candidate.startsWith(p + '?'),
    )
  ) {
    return null
  }
  return candidate
}

function RouteByState() {
  const { state, profileComplete } = useSession()

  if (state === 'LOADING') return null
  // An authorized user completes their profile before anything else.
  if (isAuthorized(state) && !profileComplete) {
    return <Navigate to="/profile-setup" replace />
  }
  if (state === 'READY') return <Navigate to="/home" replace />
  // destinationFor covers every remaining state; the fallback never fires.
  const to = destinationFor(state) ?? '/home'
  return <Navigate to={to} replace />
}

/** Protects every normal application route (inside the AppShell). */
export function RequireAppAccess() {
  const { state, profileComplete } = useSession()
  const location = useLocation()

  if (state === 'LOADING') return null
  if (state === 'READY') {
    if (profileComplete) return <Outlet />
    // Post-auth profile-completion gate: the application (AppShell,
    // financial-year provider, WhatsApp provider, business pages) never
    // mounts for a profile-incomplete user — no flash at any level. The
    // intended internal route is preserved for the return trip.
    return (
      <Navigate
        to="/profile-setup"
        replace
        state={{ returnTo: location.pathname + location.search }}
      />
    )
  }
  if (state === 'UNAUTHENTICATED') {
    const params = new URLSearchParams({ redirect: location.pathname })
    return <Navigate to={`/login?${params.toString()}`} replace />
  }
  // Remaining states all map to a destination; the fallback never fires.
  return <Navigate to={destinationFor(state) ?? '/home'} replace />
}

/**
 * /login — an authenticated user is routed by their access state (a READY
 * user goes to the app, a blocked user to their state page). Unauthenticated
 * users see the form. An authorized user whose profile is incomplete is
 * sent to /profile-setup — carrying the login page's ?redirect= target as
 * the returnTo so the intended destination survives the whole chain.
 */
export function RedirectIfAuthed() {
  const { state, profileComplete } = useSession()
  const [searchParams] = useSearchParams()

  if (state === 'LOADING') return null
  if (state === 'UNAUTHENTICATED') return <Outlet />
  if (isAuthorized(state) && !profileComplete) {
    return (
      <Navigate
        to="/profile-setup"
        replace
        state={{ returnTo: safeReturnTo(searchParams.get('redirect')) }}
      />
    )
  }
  return <RouteByState />
}

/**
 * /verify-email — shown for the EMAIL_UNVERIFIED state and for blocked
 * login attempts (GoTrue refuses to issue a session to an unconfirmed
 * account, so the page must also render WITHOUT a session — the email is
 * carried via router state from the login page; the page itself redirects
 * to /login when neither is present).
 */
export function RequireEmailUnverified() {
  const { state } = useSession()

  if (state === 'LOADING') return null
  if (state === 'EMAIL_UNVERIFIED' || state === 'UNAUTHENTICATED') return <Outlet />
  return <RouteByState />
}

/** /no-access — terminal state; every other state is routed away. */
export function RequireNoAccess() {
  const { state } = useSession()

  if (state === 'LOADING') return null
  if (state === 'NO_ACCESS') return <Outlet />
  return <RouteByState />
}

/** /blocked — terminal state (owner-blocked account); every other state is
 *  routed away. Blocked is NEVER treated as onboarding or a store problem. */
export function RequireBlocked() {
  const { state } = useSession()

  if (state === 'LOADING') return null
  if (state === 'BLOCKED') return <Outlet />
  return <RouteByState />
}

/**
 * /setup-store — the owner-only store setup wizard.
 *
 * OWNER_SETUP_REQUIRED renders the wizard — but only after the owner's
 * personal profile is complete (login → verification → role/status →
 * PROFILE COMPLETION → store onboarding → application). A READY owner
 * going back is sent to the app; every other state (user, NULL,
 * unverified) is routed away — directly typing /setup-store never works
 * for them.
 */
export function RequireOwnerSetup() {
  const { state, profileComplete } = useSession()

  if (state === 'LOADING') return null
  if (state === 'OWNER_SETUP_REQUIRED' && profileComplete) return <Outlet />
  return <RouteByState />
}

/**
 * /profile-setup — personal profile completion for an authorized user
 * whose display_name is missing.
 *
 * Accessible ONLY when ALL are true: authenticated, email verified,
 * user_type owner/user, status active, display_name missing. Everything
 * else follows normal application routing (unauthenticated → /login,
 * unverified → /verify-email, NULL role → /no-access, blocked → /blocked,
 * profile already complete → the application / store wizard). While the
 * state is resolving, nothing renders — no form flash, no app flash.
 *
 * When the profile completes ON THIS PAGE, the guard itself continues to
 * the intended destination (the returnTo captured when the gate redirected
 * here) — so the guard-driven navigation and the page's own success
 * navigation always converge on the same target (never a stateless /home
 * that would silently drop the intended route).
 */
export function RequireProfileSetup() {
  const { state, profileComplete } = useSession()
  const location = useLocation()

  if (state === 'LOADING') return null
  if (isAuthorized(state) && !profileComplete) return <Outlet />
  if (isAuthorized(state) && profileComplete) {
    return (
      <Navigate
        to={safeReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo) ?? '/home'}
        replace
      />
    )
  }
  return <RouteByState />
}
