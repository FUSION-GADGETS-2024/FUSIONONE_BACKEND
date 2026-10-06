import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { supabase } from '@/platform/supabase/client'
import { useSession } from '@/components/providers/SessionProvider'
import { Button } from '@/components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card'
import { useToast } from '@/components/ui/Toast'
import { MailCheck, LogOut, RefreshCw } from 'lucide-react'

/**
 * EMAIL_UNVERIFIED state — a hard security gate. The user is authenticated
 * but their email is not verified, so they get NO application access until
 * Supabase Auth confirms the address. Supabase remains the source of truth;
 * this page only informs and offers the native resend + sign out.
 */
export default function VerifyEmailPage() {
  const { user, signOut, refreshAccess } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [resending, setResending] = useState(false)
  const [checking, setChecking] = useState(false)

  // The email to display: the signed-in identity, or the one captured from
  // a blocked login attempt (passed via router state). Without either there
  // is nothing to verify here — back to the login page.
  const stateEmail = (location.state as { email?: string } | null)?.email
  const email = user?.email || stateEmail || ''
  if (!email) {
    return <Navigate to="/login" replace />
  }

  const handleResend = async () => {
    if (!email) return
    setResending(true)
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email })
      if (resendError) throw resendError
      success('Email sent', `Verification email re-sent to ${email}`)
    } catch (err) {
      error('Could not send email', err instanceof Error ? err.message : 'Please try again later.')
    } finally {
      setResending(false)
    }
  }

  const handleCheckAgain = async () => {
    setChecking(true)
    try {
      await refreshAccess()
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <Card className="w-full max-w-md relative z-10 p-2 shadow-xl border-slate-100">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-14 h-14 mb-3 rounded-2xl bg-indigo-50 flex items-center justify-center">
            <MailCheck className="w-7 h-7 text-indigo-600" />
          </div>
          <CardTitle className="text-xl font-bold text-slate-900 tracking-tight">Verify your email</CardTitle>
          <CardDescription className="text-slate-500 text-sm mt-2">
            You&apos;re signed in, but your email address hasn&apos;t been verified yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center">
            <p className="text-[11px] uppercase font-semibold tracking-wider text-slate-400">Account</p>
            <p className="text-sm font-semibold text-slate-900 truncate mt-0.5">{email || '—'}</p>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed mt-4">
            Check your inbox (and spam folder) and click the link in the email we sent you. FUSION ONE
            stays locked until your address is verified.
          </p>

          <div className="space-y-2.5 mt-5">
            <Button
              onClick={handleResend}
              disabled={resending || !email}
              isLoading={resending}
              className="w-full h-10 text-sm bg-indigo-600 hover:bg-indigo-700"
            >
              {/* Icon always mounted — the Button's loading overlay keeps the
                  reserved footprint identical in every state. */}
              <RefreshCw className="w-4 h-4 mr-1.5" />
              Resend verification email
            </Button>
            <Button
              onClick={handleCheckAgain}
              disabled={checking || !user}
              variant="outline"
              className="w-full h-10 text-sm"
            >
              I&apos;ve verified — check again
            </Button>
            <Button
              onClick={async () => {
                await signOut()
                navigate('/login')
              }}
              variant="ghost"
              className="w-full h-10 text-sm text-slate-500"
            >
              <LogOut className="w-4 h-4 mr-1.5" />
              Sign in with a different account
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
