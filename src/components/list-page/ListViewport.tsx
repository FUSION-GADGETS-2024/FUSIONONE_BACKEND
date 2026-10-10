'use client';

/**
 * ListViewport — the ONE scrollable region of a list card.
 *
 * The list-page architecture locks everything except the rows: the page
 * header, toolbar band and table header stay fixed while THIS element
 * scrolls. It wraps the raw scroller with the two behaviors every list
 * viewport shares:
 *
 *   - the adaptive soft bottom edge — a subtle white gradient that hints
 *     content continues below, shown only while the viewport can actually
 *     scroll and is not at its end (never a hard shadow, never
 *     obstructing: pointer-events none, and it fades out at the bottom);
 *   - scroll restoration — list → detail → Back returns to the exact
 *     browsing position (in-memory, pathname-scoped; `discriminator`
 *     separates sibling viewports of one page).
 *
 * Descendants (the status tail, custom lists) reach the scroller through
 * the viewport context — the IntersectionObserver root for the prefetch
 * sentinel is always the real scroll container.
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { cn } from '@/components/ui/utils';
import { useViewportScrollRestore } from './use-list-pagination';

// ── Viewport context ────────────────────────────────────────────────────────

const ListViewportContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** The enclosing list viewport's scroller (the sentinel's scroll root). */
export function useListViewport(): RefObject<HTMLDivElement | null> | null {
  return useContext(ListViewportContext);
}

// ── Adaptive bottom fade ────────────────────────────────────────────────────

/**
 * Whether the soft bottom edge should show: only while the viewport can
 * scroll AND the user is not at its end — at the end (or with no
 * overflow) the hint would misleadingly suggest more content exists.
 * Re-measured on scroll, viewport resize and content growth.
 */
function useBottomFade(viewportRef: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const update = () => {
      const canScroll = el.scrollHeight - el.clientHeight > 4;
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
      const next = canScroll && !atEnd;
      setShown(prev => (prev === next ? prev : next));
    };

    update();
    el.addEventListener('scroll', update, { passive: true });
    // Content growth (appended pages) and viewport resizes both change
    // whether the edge applies — observe both, when available.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [viewportRef]);

  return shown;
}

// ── ListViewport ────────────────────────────────────────────────────────────

export interface ListViewportProps {
  children: ReactNode;
  /** Sibling-viewport discriminator for scroll restoration (optional). */
  restoreKey?: string;
  /** Accessible name for the scroll region (optional). */
  'aria-label'?: string;
  className?: string;
}

export function ListViewport({ children, restoreKey, className, ...aria }: ListViewportProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fadeShown = useBottomFade(viewportRef);
  useViewportScrollRestore(viewportRef, restoreKey);

  return (
    <ListViewportContext.Provider value={viewportRef}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewportRef}
          role={aria['aria-label'] ? 'region' : undefined}
          aria-label={aria['aria-label']}
          className={cn('absolute inset-0 overflow-auto', className)}
        >
          {children}
        </div>
        {/* Soft bottom edge — a quiet continuation hint that belongs to
            the viewport (never to the page), retiring at the list's end. */}
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-white via-white/60 to-transparent transition-opacity duration-150',
            fadeShown ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </ListViewportContext.Provider>
  );
}
