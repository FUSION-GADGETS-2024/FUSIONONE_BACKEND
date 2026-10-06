import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { supabase } from '@/platform/supabase/client'
import { safeReturnTo } from '@/components/guards'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card'
import { useToast } from '@/components/ui/Toast'
import { Mail, Lock } from 'lucide-react'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { error } = useToast()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Sign-in only — there is NO public user-creation flow. Accounts are
  // provisioned exclusively through the owner-controlled invitation flow.
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (signInError) throw signInError
      // The router guard resolves application access from here (verified?
      // provisioned? profile complete? owner setup pending?) — /home is only
      // reached by an authorized user with a completed profile; every other
      // state is routed to its own page. The intended internal route (the
      // ?redirect= parameter the guard set when bouncing an unauthenticated
      // visitor) is preserved when safe.
      navigate(safeReturnTo(searchParams.get('redirect')) ?? '/home')
    } catch (err: any) {
      // Native Supabase gate: unconfirmed accounts cannot sign in — route
      // them to the verification state instead of a generic error.
      const message: string = err?.message ?? String(err)
      if (/email.*not.*confirmed/i.test(message) || /confirm.*email/i.test(message)) {
        navigate('/verify-email', { state: { email } })
        return
      }
      error('Authentication Error', message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 relative overflow-hidden font-sans">
      {/* Decorative background elements */}
      <div className="absolute top-[-10rem] left-[-10rem] w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute bottom-[-10rem] right-[-10rem] w-96 h-96 bg-violet-500/10 rounded-full blur-3xl pointer-events-none"></div>

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
          <CardDescription className="text-slate-500 text-sm mt-2">
            Sign in to access your business.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignIn} className="space-y-4 pt-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider pl-1">
                Email Address
              </label>
              <Input
                type="email"
                placeholder="owner@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                icon={<Mail className="h-4 w-4" />}
                className="h-11"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider pl-1">
                Password
              </label>
              <PasswordInput
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                icon={<Lock className="h-4 w-4" />}
                className="h-11"
              />
            </div>

            <Button
              type="submit"
              className="w-full h-11 text-base shadow-indigo-600/20 shadow-lg hover:shadow-indigo-600/30 transition-colors mt-6"
              isLoading={isLoading}
            >
              Sign In
            </Button>

            <Link
              to="/forgot-password"
              className="block text-center text-xs font-medium text-slate-500 hover:text-indigo-600 mt-4"
            >
              Forgot password?
            </Link>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
