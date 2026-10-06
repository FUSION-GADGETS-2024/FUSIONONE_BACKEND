import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { matchPath, Outlet, useLocation, useNavigationType } from 'react-router'
import Sidebar from './Sidebar'
import Header from './Header'
import { warmInvoicePdfViewer } from './invoice/InvoicePdfViewer'
import { FinancialYearProvider } from '@/components/providers/FinancialYearProvider'
import { WhatsAppPlatformProvider } from '@/features/whatsapp/WhatsAppPlatformContext'
import { useMessageJobEvents } from '@/features/messages/useMessageJobEvents'
import { WhatsAppPairingDialog } from '@/components/whatsapp/WhatsAppPairingDialog'

/**
 * AppShell wraps all authenticated application pages with the full layout.
 *
 * Access gating lives in the ROUTER GUARD (RequireAppAccess — the resolved
 * application access state), not here: by the time this shell mounts, the
 * visitor is a verified, provisioned FUSION ONE user (owner or user, both
 * sharing the one store). Only the app-specific providers remain here,
 * above the locked-viewport layout (Header + Sidebar + the page's scrolling
 * context).
 */
/**
 * Invoice detail routes render a DOCUMENT view (the invoice PDF workspace).
 *
 * These routes need a scroll-free application shell: the global header, the
 * invoice header and the action sidebar must stay stationary while ONLY the
 * PDF viewport scrolls. The shell therefore swaps its normal scrollable
 * <main> (page-level scrolling, padded, max-width column) for a full-bleed
 * non-scrolling <main> whose content owns the whole remaining viewport —
 * the page then establishes the single PDF scroll container itself.
 *
 * Every other route keeps the exact original scrollable shell.
 */
function useIsInvoiceDocumentView(): boolean {
  const { pathname } = useLocation()
  return ['/sales/:id', '/purchases/:id', '/proformas/:id'].some((pattern) => {
    // '/sales/new' (and friends) also match ':id' — they are form pages,
    // not document views, so they keep the normal scrolling shell.
    const match = matchPath(pattern, pathname)
    return !!match && match.params.id !== 'new'
  })
}

/**
 * List pages render the FIXED-PAGE layout (ListPage + DataTable fill).
 *
 * These routes need the same scroll-free shell as document views, but for
 * the list architecture: the page header, search/filter toolbar and table
 * header must stay stationary while ONLY the rows viewport scrolls. The
 * shell provides the full-bleed non-scrolling <main>; the page (ListPage)
 * re-establishes the standard padded max-width column and locks its own
 * vertical flow, with the rows viewport as the single scroll container.
 *
 * Bounded, non-list pages (dashboard, forms, financial years, settings,
 * profile) keep the normal scrolling shell.
 */
const LIST_PAGE_ROUTES = [
  '/sales',
  '/purchases',
  '/proformas',
  '/payments',
  '/parties',
  '/parties/:id',
  '/accounts',
  '/exchange',
  '/inventory',
  '/messages',
] as const

function useIsListPageView(): boolean {
  const { pathname } = useLocation()
  return LIST_PAGE_ROUTES.some((pattern) => !!matchPath(pattern, pathname))
}

/**
 * Minimal scroll restoration for the shell's <main> scroller.
 *
 * Normal pages scroll inside <main> (the window never scrolls), so
 * browser-native window scroll restoration cannot apply. This remembers
 * each visited page's <main> scroll offset and restores it when the user
 * returns to that page with browser Back (POP) — covering the
 * list → detail → Back flow. Forward navigations start at the top, as
 * usual. (List pages own their rows viewport and restore it themselves —
 * useViewportScrollRestore; for those pages <main> never scrolls and this
 * restoration is a harmless no-op.)
 *
 * Deliberately tiny and shell-scoped: an in-memory per-pathname map (no
 * persistence, no URL state), consumed on the return navigation only.
 */
function useMainScrollRestoration(mainRef: RefObject<HTMLElement | null>) {
  const location = useLocation()
  const navigationType = useNavigationType()

  const lastScrollRef = useRef(0)
  const memoryRef = useRef(new Map<string, number>())
  const lastPathRef = useRef(location.pathname)

  // Track the scroller continuously (passive) — this value is the only
  // reliable copy of the leaving page's position, because the DOM swap on
  // navigation would clamp <main> before it could be read back.
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    const onScroll = () => {
      lastScrollRef.current = main.scrollTop
    }
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => main.removeEventListener('scroll', onScroll)
  }, [mainRef])

  useLayoutEffect(() => {
    const memory = memoryRef.current
    if (lastPathRef.current === location.pathname) {
      // Same page (e.g. a ?tab= switch) — nothing to restore, nothing to save.
      return
    }

    // Leaving a page — remember where it was scrolled.
    memory.set(lastPathRef.current, lastScrollRef.current)
    if (memory.size > 60) {
      const oldest = memory.keys().next().value
      if (typeof oldest === 'string') memory.delete(oldest)
    }
    lastPathRef.current = location.pathname
    lastScrollRef.current = mainRef.current?.scrollTop ?? 0

    // Returning to a page (browser Back) — restore its remembered position
    // once the new content has rendered (cached queries render
    // synchronously, so the page height is already final in that rAF).
    if (navigationType === 'POP') {
      const restoreTo = memory.get(location.pathname)
      memory.delete(location.pathname)
      if (restoreTo != null && restoreTo > 0) {
        requestAnimationFrame(() => {
          const main = mainRef.current
          if (!main) return
          const maxScroll = main.scrollHeight - main.clientHeight
          // Only restore into a page tall enough to hold the position — a
          // still-loading (short) page simply starts at the top.
          if (restoreTo <= maxScroll) main.scrollTop = restoreTo
        })
      }
    }
  }, [location.pathname, navigationType, mainRef])
}

/**
 * AppShell wraps all authenticated pages with the full layout.
 *
 * Toast / Query / Session providers live ONCE in RootProviders (they wrap
 * the whole router, including the auth pages). The reference app had this
 * stack in its (app) layout only because it had no root stack — recreating
 * it here produced a SECOND, separate QueryClient for the app pages, which
 * broke the module-scope semantic invalidation (helpers bound to a client
 * the pages did not use). Only the app-specific providers remain here,
 * above the locked-viewport layout (Header + Sidebar + the page's scrolling
 * context).
 */
export default function AppShell({ children }: { children?: ReactNode }) {
  const isDocumentView = useIsInvoiceDocumentView()
  const isListPage = useIsListPageView()
  // Document views AND list pages own their scroll: the shell hands them a
  // full-bleed non-scrolling <main> (the PDF viewport / the list rows
  // viewport is the single scroll container). Every other page keeps the
  // shell's own scrolling <main>.
  const pageOwnsScroll = isDocumentView || isListPage
  const mainRef = useRef<HTMLElement | null>(null)
  useMainScrollRestoration(mainRef)
  // Durable message job outcomes (auto-send / reminder / receipt) arrive on
  // the app-scope SSE connection; this is the ONE subscription that reacts
  // (query refresh + auto-send toasts).
  useMessageJobEvents()

  // Prewarm the invoice viewer's pdf.js module + worker once the app is
  // idle: the FIRST invoice open of a session then skips the measured
  // ~200ms module/worker startup. Best-effort only — the viewer loads
  // pdf.js on demand exactly as before if this never ran, and pdf.js stays
  // out of the initial bundle.
  useEffect(() => {
    const warm = () => warmInvoicePdfViewer()
    let cancel: () => void
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(warm, { timeout: 4000 })
      cancel = () => window.cancelIdleCallback(handle)
    } else {
      const handle = window.setTimeout(warm, 2500)
      cancel = () => window.clearTimeout(handle)
    }
    return cancel
  }, [])

  return (
    <FinancialYearProvider>
      {/* The ONE global WhatsApp/SSE lifecycle observer — application
          scope, NOT panel scope. Client presence must mean "an
          authenticated FUSIONONE application client is open": the SSE
          connection opens when the authenticated app opens and closes
          only when it disappears, so ordinary route navigation never
          drops backend presence. NON-BLOCKING by construction: the
          provider renders children immediately and the observer starts
          asynchronously (the hook's effect, after first paint) — the app
          never waits for SSE/Redis/Baileys/WhatsApp. WhatsApp state
          updates re-render ONLY context consumers (panel, pairing
          dialog), never the application at large. */}
      <WhatsAppPlatformProvider>
        <div className="flex flex-col h-screen bg-slate-50 overflow-hidden font-sans">
          <Header />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            {pageOwnsScroll ? (
              // Document/list view: nothing scrolls at shell level — the
              // page fills this box and owns its single scroll container.
              <main ref={mainRef} className="flex-1 overflow-hidden">{children ?? <Outlet />}</main>
            ) : (
              // Normal pages: the shell's <main> is the page scroller.
              <main ref={mainRef} className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
                <div className="max-w-7xl mx-auto w-full">{children ?? <Outlet />}</div>
              </main>
            )}
          </div>
        </div>
        {/* The pairing dialog — a transient representation of BACKEND
            pairing state at the application level. It is NOT owned by the
            Settings WhatsApp panel: navigating away from Settings never
            cancels an active pairing, and the QR lives here (never inside
            the Connection card). Driven entirely by the shared SSE state;
            closes automatically when pairing ends. */}
        <WhatsAppPairingDialog />
      </WhatsAppPlatformProvider>
    </FinancialYearProvider>
  )
}
