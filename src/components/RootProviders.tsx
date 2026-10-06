import type { ReactNode } from 'react'
import { Outlet } from 'react-router'
import { ToastProvider } from '@/components/ui/Toast'
import QueryProvider from '@/components/providers/QueryProvider'
import { SessionProvider } from '@/components/providers/SessionProvider'

/**
 * Root provider stack for the whole SPA:
 * Toast → Query → Session. (The reference app split this between the (auth)
 * Toast-only layout and the (app) full stack; a single root stack is
 * behavior-identical — the auth pages run no queries.)
 */
export default function RootProviders({ children }: { children?: ReactNode }) {
  return (
    <ToastProvider>
      <QueryProvider>
        <SessionProvider>{children ?? <Outlet />}</SessionProvider>
      </QueryProvider>
    </ToastProvider>
  )
}
