'use client';

/**
 * ListPage — the fixed-page layout every long-list page renders in.
 *
 * The shell gives list pages a full-bleed, non-scrolling <main>; this
 * layout re-establishes the standard page chrome (the exact padding and
 * max-width column every page uses) as a locked vertical flow:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ page header — title · description · actions │  fixed
 *   ├────────────────────────────────────────────┤
 *   │ flexible content area                      │
 *   │   fixed sections (tabs, summary cards, …)  │  fixed
 *   │   ┌──────────────────────────────────────┐ │
 *   │   │ list card — toolbar band (fixed)     │ │
 *   │   │            rows viewport (scrolls)   │ │  scrolls
 *   │   └──────────────────────────────────────┘ │
 *   └────────────────────────────────────────────┘
 *
 * Only the list viewport scrolls. The min-h-0/overflow chain is what lets
 * the card shrink to the available space and scroll internally instead of
 * forcing its parent — or the page — to grow, at any desktop viewport
 * height (no fixed pixel heights anywhere).
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';

export interface ListPageProps {
  /** The page's title/description/actions block (fixed above the content). */
  header?: ReactNode;
  /** Page content — fixed sections plus the flexible list card(s). */
  children: ReactNode;
  className?: string;
}

export function ListPage({ header, children, className }: ListPageProps) {
  return (
    <div
      className={cn(
        'mx-auto flex h-full w-full max-w-7xl flex-col gap-5 p-4 sm:p-6 md:p-8',
        className,
      )}
    >
      {header != null && <div className="shrink-0">{header}</div>}
      <div className="flex min-h-0 flex-1 flex-col gap-5">{children}</div>
    </div>
  );
}
