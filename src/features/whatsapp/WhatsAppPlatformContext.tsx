/**
 * WhatsApp Platform Context — application-scope ownership of the ONE
 * WhatsApp/SSE lifecycle.
 *
 * ARCHITECTURE (the client-presence regression fix):
 *
 *   Authenticated App Shell
 *       |
 *       +-- WhatsAppPlatformProvider  ← the ONE global WhatsApp/SSE
 *       |     (useWhatsAppPlatform)     lifecycle observer, mounted by the
 *       |                               app shell — NOT by the Settings
 *       |                               WhatsApp panel
 *       |
 *       +-- Dashboard / Sales / Purchases / Inventory / Settings
 *             |
 *             +-- WhatsApp panel (a pure CONSUMER of the shared state)
 *
 * Client presence must represent "an authenticated FUSIONONE application
 * client is open" — NOT "the WhatsApp settings panel is mounted". The SSE
 * connection therefore lives at the highest stable authenticated
 * application-shell level: it opens when the authenticated app opens and
 * closes only when the authenticated app client disappears. Ordinary route
 * navigation (Dashboard → Sales → Settings → WhatsApp → Dashboard) never
 * disconnects it — the backend keeps seeing ONE client throughout.
 *
 * NON-BLOCKING: the provider renders its children IMMEDIATELY. The SSE
 * connection and the initial status snapshot are started asynchronously by
 * the hook's effect (after the first paint) — the application never waits
 * for SSE, Redis, Baileys, or WhatsApp availability, and a failing
 * FUSION ONE backend cannot delay or break the main UI.
 *
 * RENDER ISOLATION: WhatsApp state updates flow through React context.
 * When the hook's state changes, ONLY components that consume this context
 * re-render (the provider's `children` element keeps its identity, so
 * React bails out on the non-consuming subtree):
 *
 *   WhatsApp event → WhatsApp state updates → WhatsApp consumers re-render
 *
 * There is exactly ONE SSE connection per application client (the hook is
 * instantiated exactly once, here) — no second connection, no WebSocket,
 * no polling, no heartbeat endpoint.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { useWhatsAppPlatform, type WhatsAppPlatformView } from './useWhatsAppPlatform'

const WhatsAppPlatformContext = createContext<WhatsAppPlatformView | null>(null)

/**
 * The ONE global WhatsApp lifecycle observer. Mount ONCE at the
 * authenticated application-shell level (AppShell). Everything else that
 * needs WhatsApp state consumes it via useWhatsAppPlatformContext().
 */
export function WhatsAppPlatformProvider({ children }: { children: ReactNode }) {
  const view = useWhatsAppPlatform()
  return (
    <WhatsAppPlatformContext.Provider value={view}>{children}</WhatsAppPlatformContext.Provider>
  )
}

/**
 * Consume the application-scope WhatsApp platform state (the panel, the
 * pairing dialog, and any other WhatsApp UI).
 *
 * Must be used inside <WhatsAppPlatformProvider> (the app shell mounts it
 * for every authenticated route) — a missing provider is a wiring bug.
 */
export function useWhatsAppPlatformContext(): WhatsAppPlatformView {
  const view = useContext(WhatsAppPlatformContext)
  if (view === null) {
    throw new Error(
      'useWhatsAppPlatformContext requires <WhatsAppPlatformProvider> — mount it at the authenticated app-shell level.',
    )
  }
  return view
}
