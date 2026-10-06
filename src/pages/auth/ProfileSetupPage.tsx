import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '@/components/providers/SessionProvider'
import { safeReturnTo } from '@/components/guards'
import {
  validateDisplayName,
  updateOwnDisplayName,
} from '@/features/profile/display-name'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card'
import { User, AlertCircle } from 'lucide-react'

/**
 * /profile-setup — personal account profile completion.
 *
 * A proper standalone page (NOT a dialog, NOT inside the AppShell — no
 * sidebar, no financial-year selector, no WhatsApp controls, no store
 * settings, no business navigation mount here). It uses the NORMAL
 * application authentication session (the main @supabase/ssr client) —
 * deliberately different from /set-password, which owns the isolated
 * email-action lifecycle. This page NEVER touches the setup client.
 *
 * Reachable ONLY through its guard (RequireProfileSetup): an authenticated,
 * email-verified, ACTIVE owner/user whose display_name is missing. Every
 * other state is routed by the normal application routing — the guard
 * renders nothing while loading, so neither the form nor the application
 * ever flashes.
 *
 * On Continue: trim → validate → submit ONLY display_name through the
 * narrow self-update RLS boundary → wait for confirmed database success →
 * update the app-user cache → navigate to the originally intended internal
 * route (returnTo) or /home. Never navigates before the database succeeds.
 */

/** Transient, page-local form states (never application auth state). */
type Phase =
  | { kind: 'FORM'; formError: string | null }
  | { kind: 'SUBMITTING' }
  | { kind: 'SUCCESS' }

export default function ProfileSetupPage() {
  const { user } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'FORM', formError: null })

  const busy = phase.kind === 'SUBMITTING'
  const formError = phase.kind === 'FORM' ? phase.formError : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Prevent duplicate submission (the same guard disables the button).
    if (phase.kind === 'SUBMITTING') return

    const userId = user?.id
    if (!userId) {
      // The guard guarantees an authenticated session; defensive only.
      setPhase({
        kind: 'FORM',
        formError: 'Your session could not be resolved. Please sign in again.',
      })
      return
    }

    const validation = validateDisplayName(name)
    if (!validation.valid) {
      setPhase({ kind: 'FORM', formError: validation.message })
      return
    }

    setPhase({ kind: 'SUBMITTING' })
    const result = await updateOwnDisplayName(userId, name)
    if (!result.ok) {
      // The database value is untouched — retry is safe.
      setPhase({ kind: 'FORM', formError: result.message })
      return
    }

    // Confirmed database success. Update the app-user cache so the
    // profile-completion gate immediately sees the completed profile
    // (display_name stays the single source of truth — no flag is stored),
    // then navigate to the intended internal destination.
    setPhase({ kind: 'SUCCESS' })
    queryClient.setQueryData<{ userType: 'owner' | 'user'; status: string; displayName: string | null } | null>(
      ['app-user', userId],
      (prev) => (prev ? { ...prev, displayName: result.displayName } : prev),
    )
    const target = safeReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo) ?? '/home'
    navigate(target, { replace: true })
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 relative overflow-hidden font-sans">
      {/* Decorative background elements — the shared auth-page language. */}
      <div className="absolute top-[-10rem] left-[-10rem] w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10rem] right-[-10rem] w-96 h-96 bg-violet-500/10 rounded-full blur-3xl pointer-events-none" />

      <Card className="w-full max-w-md relative z-10 p-2 shadow-xl border-slate-100">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-14 h-14 mb-3 relative">
            <img
              src="/Logo_Rounded.png"
              alt="FUSION ONE Logo"
              width={56}
              height={56}
              className="w-14 h-14 rounded-xl object-contain shadow-md"
            />
          </div>
          <CardTitle className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent tracking-tight">
            FUSION ONE
          </CardTitle>
          <div className="mx-auto w-14 h-14 mt-5 mb-3 rounded-2xl bg-indigo-50 flex items-center justify-center">
            <User className="w-7 h-7 text-indigo-600" />
          </div>
          <CardTitle className="text-xl font-bold text-slate-900 tracking-tight">
            Complete your profile
          </CardTitle>
          <CardDescription className="text-slate-500 text-sm mt-2">
            Let&apos;s get your account ready.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4 pt-4">
            <div className="space-y-1">
              <label htmlFor="display-name" className="text-xs font-semibold text-slate-600 uppercase tracking-wider pl-1">
                Your name
              </label>
              <Input
                id="display-name"
                type="text"
                placeholder="e.g. Wamiq Khan"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                autoComplete="name"
                icon={<User className="h-4 w-4" />}
                className="h-11"
                aria-invalid={formError != null}
                disabled={busy || phase.kind === 'SUCCESS'}
              />
            </div>

            {formError && (
              <div
                className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-2.5 flex items-start gap-2.5"
                role="alert"
              >
                <AlertCircle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                <p className="text-xs text-rose-600 leading-relaxed">{formError}</p>
              </div>
            )}

            <Button
              type="submit"
              className="w-full h-11 text-base bg-indigo-600 hover:bg-indigo-700 mt-2"
              isLoading={busy}
              disabled={busy || phase.kind === 'SUCCESS'}
            >
              Continue
            </Button>
            <p className="text-center text-[11px] text-slate-400 mt-3">
              You can change this later from Profile.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
