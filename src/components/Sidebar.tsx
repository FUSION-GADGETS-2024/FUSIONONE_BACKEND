import { useState, useRef, useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import {
  Home, ShoppingCart, Package, Users, Wallet, FileText,
  RefreshCcw, Landmark, Calendar, Settings, Smartphone, LogOut,
  ChevronUp, Store, UserCircle, BarChart3,
} from 'lucide-react'
import { cn } from '@/components/ui/utils'
import { useSession } from '@/components/providers/SessionProvider'
import { useStore } from '@/features/settings/api'

const navigation = [
  // NOTE: main page route is /home — the platform preview proxy intercepts
  // the exact path /dashboard (301 → /dashboard/) causing a redirect loop,
  // so that path must be avoided (constraint preserved from the old app).
  // Messages (/messages) lives in the HEADER next to the FY selector, not
  // here — it is a messaging view, not a primary ledger module.
  { name: 'Dashboard', href: '/home', icon: Home },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Sales', href: '/sales', icon: ShoppingCart },
  { name: 'Purchases', href: '/purchases', icon: Package },
  { name: 'Inventory', href: '/inventory', icon: Smartphone },
  { name: 'Parties', href: '/parties', icon: Users },
  { name: 'Payments', href: '/payments', icon: Wallet },
  { name: 'Exchange', href: '/exchange', icon: RefreshCcw },
  { name: 'Accounts', href: '/accounts', icon: Landmark },
  { name: 'Proforma', href: '/proformas', icon: FileText },
  { name: 'Financial Year', href: '/financial-year', icon: Calendar },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = useLocation().pathname
  const { user, appUser, signOut } = useSession()

  // Shared cached store query — replaces the old always-refetched Sidebar
  // fetch (fixes audit D2: the store row now loads once per session and
  // stays fresh after settings saves).
  const { data: store } = useStore()
  const storeName = store?.name || null
  const logoUrl = store?.logo_url || null

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const displayName = storeName || user?.email || 'My Store'
  const initial = displayName[0]?.toUpperCase() || 'S'
  // The role label comes from the actual application authorization state
  // (public.users.user_type) — never a static string.
  const roleLabel = appUser?.userType === 'owner' ? 'Owner' : appUser?.userType === 'user' ? 'User' : ''

  return (
    <div className="flex flex-col w-14 md:w-48 bg-white border-r border-slate-200 shrink-0">
      {/* Nav — icon rail below md (labels hidden), full sidebar from md up */}
      <nav className="flex-1 overflow-y-auto py-3">
        <ul className="space-y-0.5 px-2.5 max-md:px-2 max-md:space-y-1">
          {navigation.map((item) => {
            const isActive = pathname.startsWith(item.href)
            return (
              <li key={item.name}>
                <Link
                  to={item.href}
                  title={item.name}
                  aria-label={item.name}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors max-md:justify-center max-md:px-0',
                    isActive
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50',
                  )}
                >
                  <item.icon
                    className={cn('h-4 w-4 shrink-0', isActive ? 'text-indigo-600' : 'text-slate-400')}
                  />
                  <span className="hidden md:inline">{item.name}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Profile dropdown */}
      <div className="relative px-2.5 py-3 border-t border-slate-200 max-md:px-2" ref={dropdownRef}>
        {/* Dropdown menu — renders above the trigger; on the icon rail it
            breaks out of the 56px rail as an absolutely positioned layer */}
        {dropdownOpen && (
          <div className="mb-1 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden menu-fade-in max-md:absolute max-md:bottom-full max-md:left-2 max-md:right-2 max-md:z-30 max-md:mb-2">
            <div className="px-4 py-3 border-b border-slate-100">
              <p className="text-xs font-semibold text-slate-900 truncate">{displayName}</p>
              <p className="text-[10px] text-slate-400 truncate mt-0.5">{user?.email}</p>
            </div>
            <Link
              to="/profile"
              onClick={() => setDropdownOpen(false)}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
            >
              <UserCircle className="h-3.5 w-3.5 shrink-0" />
              Profile
            </Link>
            <button
              onClick={() => {
                setDropdownOpen(false)
                signOut()
              }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <LogOut className="h-3.5 w-3.5 shrink-0" />
              Sign Out
            </button>
          </div>
        )}

        {/* Trigger row — avatar only on the icon rail */}
        <button
          onClick={() => setDropdownOpen((v) => !v)}
          title={displayName}
          aria-label="Account menu"
          className={cn(
            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors max-md:justify-center max-md:px-0',
            dropdownOpen ? 'bg-slate-100' : 'hover:bg-slate-50',
          )}
        >
          {/* Avatar / store logo */}
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={displayName}
              width={28}
              height={28}
              className="h-7 w-7 rounded-full object-cover shrink-0 border border-slate-200"
            />
          ) : (
            <div className="h-7 w-7 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-[11px] shrink-0 border border-indigo-200">
              {initial}
            </div>
          )}

          <div className="flex-1 min-w-0 text-left max-md:hidden">
            <p className="text-xs font-semibold text-slate-900 truncate">{displayName}</p>
            <p className="text-[10px] text-slate-400 flex items-center gap-1">
              <Store className="h-2.5 w-2.5 shrink-0" />
              {roleLabel || 'FUSION ONE'}
            </p>
          </div>

          <ChevronUp
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150 max-md:hidden',
              !dropdownOpen && 'rotate-180',
            )}
          />
        </button>
      </div>
    </div>
  )
}
