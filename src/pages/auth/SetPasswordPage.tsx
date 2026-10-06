import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  SetupFlowClient,
  type SetupLinkType,
} from '@/platform/supabase/setup-client'
import { Button } from '@/components/ui/Button'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card'
import { useToast } from '@/components/ui/Toast'
import { Lock, ArrowLeft, ShieldCheck, LinkIcon, AlertTriangle, CheckCircle2 } from 'lucide-react'

/**
 * /set-password — ONE page for BOTH email-action contexts:
 *
 *   1. Invitation acceptance  (/set-password?token_hash=…&type=invite)
 *   2. Password recovery      (/set-password?token_hash=…&type=recovery)
 *
 * This page is an ISOLATED auth action, deliberately outside
 * RequireAppAccess. It consumes the one-time email token with Supabase's
 * native verifyOtp() through a dedicated, in-memory-only setup client
 * (platform/supabase/setup-client.ts) — the invitation/recovery session is
 * NEVER adopted into the main application client, never stored in a cookie,
 * and never classified by the application access state machine.
 *
 * The link parameters come from the invitation / password-reset email. The
 * user never types a token; the email link is the entry credential.
 *
 * On success OR abandonment the setup client is terminated locally (its
 * refresh token revoked with scope 'local', auto-refresh stopped) and the
 * user is sent to /login — a NORMAL password login is the only way into the
 * application. The main application session (whoever is signed in) is never
 * touched by anything this page does.
 */

/**
 * Transient, page-local flow states (never application auth state).
 * The password form renders only after the one-time token verifies.
 */
type Phase =
  | { kind: 'CHECKING' }
  | { kind: 'READY'; email: string | null }
  | { kind: 'SUBMITTING'; email: string | null }
  | { kind: 'SUCCESS' }
  | { kind: 'NO_LINK' }
  | { kind: 'EXPIRED_LINK' }
  | { kind: 'INVALID_LINK' }
  | { kind: 'SESSION_ERROR' }
  | { kind: 'PASSWORD_ERROR'; email: string | null; message: string }

const LINK_STATE_COPY: Record<'EXPIRED_LINK' | 'INVALID_LINK', string> = {
  EXPIRED_LINK:
    'This link has expired or has already been used. Each invitation or reset link works once — request a new email to continue.',
  INVALID_LINK:
    'This link is invalid. Open the invitation or password-reset email again, or request a new one.',
}

export default function SetPasswordPage() {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'CHECKING' })
  const setupRef = useRef<SetupFlowClient | null>(null)
  const startedRef = useRef(false)

  // ONE-SHOT link processing (StrictMode-safe). Capture the callback
  // parameters synchronously, strip them from the URL immediately (tokens
  // must never linger in the address bar or history), then consume the
  // one-time token with the isolated setup client. The async continuation
  // is deliberately not cancelled — its result must land even for a
  // simulated remount.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const params = new URLSearchParams(window.location.search)

    // Strip ALL callback data (query + hash) from the URL right after
    // capture — never in history, never visible, never logged.
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname)
    }

    const tokenHash = params.get('token_hash') ?? ''
    const type = params.get('type') ?? ''

    // Validate the callback shape: type must be exactly invite|recovery and
    // the token hash must be present and non-empty. Anything else — no
    // parameters, an old-format implicit/PKCE link, a wrong or unsupported
    // type — is NOT a usable setup callback and never shows the form.
    if (tokenHash.length === 0 || (type !== 'invite' && type !== 'recovery')) {
      setPhase({ kind: 'NO_LINK' })
      return
    }

    const setup = SetupFlowClient.create()
    setupRef.current = setup

    void setup.verify(tokenHash, type as SetupLinkType).then((result) => {
      if (result.ok) {
        setPhase({ kind: 'READY', email: result.context.email })
      } else {
        setPhase({ kind: result.reason })
      }
    })
  }, [])

  // Abandonment by navigation away from the page: nothing persistent exists
  // (the setup client is in-memory only), but terminate the flow explicitly
  // so the refresh token is revoked and the auto-refresh timer stops.
  useEffect(() => {
    return () => {
      void setupRef.current?.terminate()
    }
  }, [])

  /**
   * "Abandon this invitation/recovery operation." Terminate the setup
   * session locally, clear everything, and go to /login — replacing history
   * (never back to the Supabase verification URL, never a global logout,
   * never touching another user's normal application session).
   */
  const abandon = async () => {
    const setup = setupRef.current
    setupRef.current = null
    if (setup) await setup.terminate()
    navigate('/login', { replace: true })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (phase.kind === 'SUBMITTING') return
    const setup = setupRef.current
    if (!setup) return

    // UX-only pre-validation; Supabase stays authoritative for the policy.
    if (password.length < 6) {
      error('Password too short', 'Use at least 6 characters.')
      return
    }
    if (password !== confirm) {
      error('Passwords do not match', 'Re-enter the same password in both fields.')
      return
    }

    setPhase({ kind: 'SUBMITTING', email: phase.kind === 'READY' ? phase.email : null })
    const result = await setup.updatePassword(password)
    if (!result.ok) {
      // The setup session is untouched — retry is safe.
      setPhase((prev) => ({
        kind: 'PASSWORD_ERROR',
        email: prev.kind === 'READY' || prev.kind === 'SUBMITTING' ? prev.email : null,
        message: result.message,
      }))
      error('Could not set password', result.message)
      return
    }

    // SUCCESS — the password is set. Terminate the setup session locally
    // (never a global signOut), dispose the client, then require a normal
    // login. The setup context NEVER becomes an application session.
    setPhase({ kind: 'SUCCESS' })
    setupRef.current = null
    await setup.terminate()
    success('Password set', 'Sign in with your new password to continue.')
    navigate('/login', { replace: true })
  }

  const showForm = phase.kind === 'READY' || phase.kind === 'SUBMITTING' || phase.kind === 'PASSWORD_ERROR'
  const busy = phase.kind === 'SUBMITTING'

  const description = showForm
    ? 'Choose a password for your account. You will sign in with it afterwards.'
    : phase.kind === 'CHECKING'
      ? 'Checking your link…'
      : phase.kind === 'SUCCESS'
        ? 'Password set. Redirecting to sign in…'
        : phase.kind === 'EXPIRED_LINK' || phase.kind === 'INVALID_LINK'
          ? 'Your email link could not be accepted.'
          : phase.kind === 'SESSION_ERROR'
            ? 'Your email link could not be opened right now.'
            : 'This password link is no longer active.'

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 relative overflow-hidden font-sans">
      <div className="absolute top-[-10rem] left-[-10rem] w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10rem] right-[-10rem] w-96 h-96 bg-violet-500/10 rounded-full blur-3xl pointer-events-none" />

      <Card className="w-full max-w-md relative z-10 p-2 shadow-xl border-slate-100">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-14 h-14 mb-3 rounded-2xl bg-indigo-50 flex items-center justify-center">
            <Lock className="w-7 h-7 text-indigo-600" />
          </div>
          <CardTitle className="text-xl font-bold text-slate-900 tracking-tight">Set your password</CardTitle>
          <CardDescription className="text-slate-500 text-sm mt-2">{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {phase.kind === 'CHECKING' ? (
            <div className="pt-6 flex flex-col items-center gap-3 text-slate-400" aria-live="polite">
              <div className="h-6 w-6 rounded-full border-2 border-indigo-200 border-t-indigo-600 animate-spin" />
              <p className="text-xs font-medium">Checking your link…</p>
            </div>
          ) : showForm ? (
            <form onSubmit={handleSubmit} className="space-y-4 pt-4">
              {phase.kind === 'READY' && phase.email ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-center">
                  <p className="text-[11px] uppercase font-semibold tracking-wider text-slate-400">Account</p>
                  <p className="text-sm font-semibold text-slate-900 truncate mt-0.5">{phase.email}</p>
                </div>
              ) : null}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider pl-1">
                  New password
                </label>
                <PasswordInput
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  icon={<Lock className="h-4 w-4" />}
                  className="h-11"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider pl-1">
                  Confirm password
                </label>
                <PasswordInput
                  placeholder="Re-enter the password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  icon={<Lock className="h-4 w-4" />}
                  className="h-11"
                />
              </div>
              <Button
                type="submit"
                className="w-full h-11 text-base bg-indigo-600 hover:bg-indigo-700 mt-2"
                isLoading={busy}
              >
                Set password
              </Button>
              <p className="flex items-center justify-center gap-1.5 text-[11px] text-slate-400 mt-3">
                <ShieldCheck className="h-3.5 w-3.5" />
                After saving you&apos;ll sign in with your new password.
              </p>
            </form>
          ) : phase.kind === 'SUCCESS' ? (
            <div className="pt-6 flex flex-col items-center gap-3 text-emerald-600" aria-live="polite">
              <CheckCircle2 className="w-8 h-8" />
              <p className="text-xs font-medium text-slate-500">Password set — taking you to sign in…</p>
            </div>
          ) : phase.kind === 'EXPIRED_LINK' || phase.kind === 'INVALID_LINK' ? (
            <div className="pt-4 space-y-4" role="alert">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex items-start gap-3">
                <LinkIcon className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                <p className="text-xs text-slate-500 leading-relaxed">{LINK_STATE_COPY[phase.kind]}</p>
              </div>
            </div>
          ) : phase.kind === 'SESSION_ERROR' ? (
            <div className="pt-4 space-y-4" role="alert">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                <p className="text-xs text-slate-500 leading-relaxed">
                  The setup session could not be started. Please reopen the invitation or password-reset email
                  and try again.
                </p>
              </div>
            </div>
          ) : (
            <div className="pt-4 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 flex items-start gap-3">
                <LinkIcon className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                <p className="text-xs text-slate-500 leading-relaxed">
                  This password link is no longer active. Open the invitation or password-reset email to
                  continue.
                </p>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={abandon}
            className="flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 mt-5 mx-auto"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to sign in
          </button>
        </CardContent>
      </Card>
    </div>
  )
}
