import { useNavigate } from 'react-router'
import { useSession } from '@/components/providers/SessionProvider'
import { Button } from '@/components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card'
import { Ban, LogOut } from 'lucide-react'

/**
 * BLOCKED — a terminal account-access state.
 *
 * The visitor is authenticated (and verified, and provisioned) but their
 * account was blocked by the store owner (public.users.status = 'blocked').
 * This is NOT onboarding, NOT a store-setup problem and NOT "no access" —
 * only this screen and sign out. The block is enforced in parallel by the
 * backend authorization layer and RLS, so an existing session cannot bypass
 * it; only the owner can unblock the account.
 */
export default function BlockedPage() {
  const { signOut } = useSession()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <Card className="w-full max-w-md relative z-10 p-2 shadow-xl border-slate-100">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto w-14 h-14 mb-3 rounded-2xl bg-rose-50 flex items-center justify-center">
            <Ban className="w-7 h-7 text-rose-500" />
          </div>
          <CardTitle className="text-xl font-bold text-slate-900 tracking-tight">
            Account blocked
          </CardTitle>
          <CardDescription className="text-slate-500 text-sm mt-2">
            Your FUSION ONE account has been blocked by the store owner.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-slate-500 leading-relaxed text-center">
            If you believe this is a mistake, contact the store owner. Only they can restore your
            access.
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
