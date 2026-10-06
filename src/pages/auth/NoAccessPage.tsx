import { useNavigate } from 'react-router'
import { useSession } from '@/components/providers/SessionProvider'
import { Button } from '@/components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card'
import { ShieldX, LogOut } from 'lucide-react'

/**
 * NO_ACCESS — a terminal authorization state.
 *
 * The visitor is authenticated (and verified) but has no authorized FUSION
 * ONE application user: no public.users row, or user_type NULL/invalid.
 * No business data, no onboarding, no setup — only this screen and sign out.
 * (Application users are created exclusively through the owner-controlled
 * invitation flow.)
 */
export default function NoAccessPage() {
  const { signOut } = useSession()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <Card className="w-full max-w-md relative z-10 p-2 shadow-xl border-slate-100">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-14 h-14 mb-3 rounded-2xl bg-rose-50 flex items-center justify-center">
            <ShieldX className="w-7 h-7 text-rose-500" />
          </div>
          <CardTitle className="text-xl font-bold text-slate-900 tracking-tight">
            No access to FUSION ONE
          </CardTitle>
          <CardDescription className="text-slate-500 text-sm mt-2">
            You don&apos;t have access to FUSION ONE.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-slate-500 leading-relaxed text-center">
            Your account hasn&apos;t been given access to this application. If you believe this is a
            mistake, ask the store owner to invite you.
          </p>
          <Button
            onClick={async () => {
              await signOut()
              navigate('/login')
            }}
            variant="outline"
            className="w-full h-10 text-sm mt-5 text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
          >
            <LogOut className="w-4 h-4 mr-1.5" />
            Sign Out
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
