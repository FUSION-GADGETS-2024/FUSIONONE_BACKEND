import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { setQueryClient } from '@/features/invalidate'

export default function QueryProvider({ children }: { children: ReactNode }) {
  // Pure initializer (no side effects): React StrictMode double-invokes
  // useState initializers in dev and KEEPS ONLY ONE of the two results —
  // registering the module-scope client here used to bind the semantic
  // invalidation helpers to the DISCARDED duplicate, so every invalidate*()
  // call targeted an orphaned QueryClient and no list ever refreshed after a
  // mutation. Registration now happens in the committed effect below, which
  // runs exactly once per real mounted provider (StrictMode remount effects
  // fire with the same stable client instance, so it is idempotent).
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            gcTime: 30 * 60 * 1000,
            // refetchOnMount defaults to true — refetches ONLY if data is stale.
            // This is critical: invalidated queries (stale) refetch when their
            // component mounts. Non-stale queries within staleTime are served
            // from cache instantly without a network request.
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 5 * 60 * 1000,
          },
        },
      }),
  )

  // Expose the REAL mounted client to the semantic-invalidation helpers.
  useEffect(() => {
    setQueryClient(queryClient)
  }, [queryClient])

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
