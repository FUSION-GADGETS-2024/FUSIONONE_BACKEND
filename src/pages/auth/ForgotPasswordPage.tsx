import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { supabase } from '@/platform/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card'
import { useToast } from '@/components/ui/Toast'
import { Mail, ArrowLeft, KeyRound } from 'lucide-react'

/**
 * Password-reset initiation — public page.
 *
 * Uses Supabase Auth natively (resetPasswordForEmail); no custom tokens, no
 * backend involvement, no passwords handled outside Supabase. The email
 * lands the user on /set-password to choose a new password, after which a
 * normal login is required.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { success, error } = useToast()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setIsLoading(true)
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/set-password`,
      })
      if (resetError) throw resetError
      success('Email sent', 'Check your inbox for the password reset link.')
      navigate('/login')
    } catch (err) {
      error('Could not send email', err instanceof Error ? err.message : 'Please try again later.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 relative overflow-hidden font-sans">
      <div className="absolute top-[-10rem] left-[-10rem] w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10rem] right-[-10rem] w-96 h-96 bg-violet-500/10 rounded-full blur-3xl pointer-events-none" />

      <Card className="w-full max-w-md relative z-10 p-2 shadow-xl border-slate-100">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-14 h-14 mb-3 rounded-2xl bg-indigo-50 flex items-center justify-center">
            <KeyRound className="w-7 h-7 text-indigo-600" />
          </div>
          <CardTitle className="text-xl font-bold text-slate-900 tracking-tight">Reset password</CardTitle>
          <CardDescription className="text-slate-500 text-sm mt-2">
            Enter your account email and we&apos;ll send you a reset link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4 pt-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider pl-1">
                Email Address
              </label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                icon={<Mail className="h-4 w-4" />}
                className="h-11"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 text-base bg-indigo-600 hover:bg-indigo-700 mt-2"
              isLoading={isLoading}
            >
              Send reset link
            </Button>
          </form>
          <Link
            to="/login"
            className="flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 mt-5"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
