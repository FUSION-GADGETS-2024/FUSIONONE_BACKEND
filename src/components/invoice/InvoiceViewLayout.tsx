'use client';

/**
 * InvoiceViewLayout — the Invoice View's stable document shell.
 *
 * The layout establishes the scrolling context for the whole Invoice View:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Global App Header            (app shell)     │  stationary
 *   ├──────────────────────────────────────────────┤
 *   │ Page header (shared PageHeader, header slot) │  stationary — never
 *   ├──────────────────────────────────────────────┤  collapses, never
 *   │ banners (cancellation / warnings, optional)  │  scrolls
 *   ├───────────────────────────┬──────────────────┤
 *   │                           │                  │
 *   │   PDF viewport            │   Action sidebar │  sidebar stationary;
 *   │   ↑ the ONLY vertical     │   internal scroll│  PDF column owns the
 *   │     scroller              │   only if needed │  single vertical
 *   │                           │                  │  scroll container
 *   └───────────────────────────┴──────────────────┘
 *
 * All three regions (header, banners, workspace) are aligned to the SAME
 * horizontal boundary — one max-w-7xl column with the same gutters — so
 * the page header, the banners and the document share one consistent
 * horizontal rhythm, exactly like every other FUSION ONE page.
 *
 * No sticky positioning and no scroll-driven behavior is used anywhere: the
 * header and banners are plain flex-none rows, the workspace is a flex-1
 * min-h-0 region, and only the PDF column (and, when its content physically
 * exceeds the space, the sidebar column) scrolls — inside the workspace,
 * never the page.
 *
 * The loading skeleton reuses this exact layout, so the skeleton reserves
 * the finished geometry and the load transition causes no layout shift.
 */
import type { ReactNode } from 'react';

export interface InvoiceViewLayoutProps {
  /** The page header (the shared PageHeader, or its skeleton). */
  header: ReactNode;
  /** Stable banner rows (cancellation notice, action-required warnings). */
  banners?: ReactNode;
  /** The action sidebar panel (InvoiceSidebar, or its skeleton). */
  sidebar?: ReactNode;
  /** The document area (InvoicePdfViewer, or its skeleton / error state). */
  children: ReactNode;
}

export function InvoiceViewLayout({ header, banners, sidebar, children }: InvoiceViewLayoutProps) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* Page header — the shared PageHeader pattern, aligned to the same
          horizontal boundary as the workspace below (the Party Detail page
          rhythm: one column, one set of gutters, space-y-5 vertical gaps). */}
      <div className="flex-none w-full max-w-7xl mx-auto px-4 sm:px-6 pt-5">
        {header}
      </div>

      {/* Banners — part of the stable shell above the workspace */}
      {banners ? (
        <div className="flex-none px-4 sm:px-6 pt-5 space-y-3 max-w-7xl w-full mx-auto">
          {banners}
        </div>
      ) : null}

      {/* Workspace — fills the remaining viewport. On mobile it stacks
          (document first, actions below); on desktop it is a two-column
          grid whose cells each own their overflow. */}
      <div className="flex-1 min-h-0 w-full max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-5 flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_264px] lg:gap-5">
        {/* Document column — the ONLY vertical scroll region of the page.
            The viewer itself is the scroll container (h-full + own
            overflow-y-auto); this cell just gives it a definite height. */}
        <div className="min-w-0 min-h-0 flex-1">{children}</div>

        {/* Action sidebar — stationary beside the document. Scrolls
            internally only when its content exceeds the available height
            (mobile keeps it below the document, capped so the PDF stays
            the dominant scrollable area). */}
        {sidebar ? (
          <aside className="min-h-0 flex-none max-h-[45%] lg:flex-none lg:max-h-none mt-4 lg:mt-0 overflow-y-auto overscroll-contain">
            {sidebar}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
