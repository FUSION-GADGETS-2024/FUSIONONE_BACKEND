'use client';

/**
 * useAnchoredOverlay — the app's ONE overlay-positioning mechanism.
 *
 * Renders an overlay (dropdown list, quick-action menu, combobox results) in
 * a fixed-position layer anchored to its trigger element. Because the layer
 * lives outside every dialog/scroll container (the consumer portals it to
 * document.body), it can never be clipped by dialog boundaries or scrolling
 * ancestors — the exact failure the old `absolute top-full` dropdowns had
 * inside overflow-clipped modal shells.
 *
 * Behavior:
 *  - positioned relative to its trigger (below by default);
 *  - flips ABOVE the trigger when the viewport has more room there;
 *  - stays glued to the trigger while any ancestor scrolls (capture-phase
 *    scroll listener) or the window resizes;
 *  - re-measures from scratch on every open (no stale coordinates);
 *  - clamped to the viewport with a small padding margin.
 *
 * There are deliberately no timeouts, no hardcoded coordinates, and no
 * per-consumer positioning code — one mechanism for every overlay.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

export interface UseAnchoredOverlayOptions {
  /** Whether the overlay is currently open. */
  open: boolean;
  /** Which edge of the trigger the overlay aligns to. Default 'left'. */
  align?: 'left' | 'right';
  /** The overlay's width tracks the trigger's width (select-style lists). */
  matchWidth?: boolean;
  /** Space between trigger and overlay in px. Default 4. */
  gap?: number;
  /** Minimum distance kept from the viewport edges in px. Default 8. */
  viewportPadding?: number;
}

export interface AnchoredOverlay<TTrigger extends HTMLElement, TOverlay extends HTMLElement> {
  /** Attach to the trigger element. */
  triggerRef: RefObject<TTrigger | null>;
  /** Attach to the portal layer's root element (must mount while open). */
  overlayRef: RefObject<TOverlay | null>;
  /**
   * Fixed-viewport style for the portal layer — null until positioned.
   * Render the layer with `visibility: hidden` (class `invisible`) while
   * null; the first measurement happens in the same pre-paint commit.
   */
  style: CSSProperties | null;
}

// Height/width assumptions used only if the layer somehow isn't mounted yet
// during the first pass (it normally is — see the layout effect ordering).
const FALLBACK_HEIGHT = 180;
const FALLBACK_WIDTH = 176;

export function useAnchoredOverlay<TTrigger extends HTMLElement, TOverlay extends HTMLElement>(
  options: UseAnchoredOverlayOptions,
): AnchoredOverlay<TTrigger, TOverlay> {
  const { open, align = 'left', matchWidth = false, gap = 4, viewportPadding = 8 } = options;
  const triggerRef = useRef<TTrigger | null>(null);
  const overlayRef = useRef<TOverlay | null>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const overlay = overlayRef.current;
    const overlayH = overlay?.offsetHeight ?? 0;
    const overlayW = overlay?.offsetWidth ?? 0;
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;

    // Vertical placement — prefer below; flip above when there is more room.
    const spaceBelow = viewH - viewportPadding - rect.bottom - gap;
    const spaceAbove = rect.top - viewportPadding - gap;
    const fits = (s: number) => (overlayH > 0 ? s >= overlayH : s >= FALLBACK_HEIGHT);
    const below = fits(spaceBelow) ? true : fits(spaceAbove) ? false : spaceBelow >= spaceAbove;

    const shownH = overlayH > 0 ? overlayH : Math.min(below ? spaceBelow : spaceAbove, FALLBACK_HEIGHT);
    const top = below
      ? rect.bottom + gap
      : Math.max(rect.top - gap - shownH, viewportPadding);

    // Horizontal placement — aligned to the chosen trigger edge, clamped in.
    const width = matchWidth ? rect.width : (overlayW || undefined);
    const anchorW = width ?? (overlayW || FALLBACK_WIDTH);
    const rawLeft = align === 'right' ? rect.right - anchorW : rect.left;
    const left = Math.min(Math.max(rawLeft, viewportPadding), Math.max(viewW - viewportPadding - anchorW, viewportPadding));

    setStyle({
      position: 'fixed',
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      ...(width !== undefined ? { width: `${Math.round(width)}px` } : {}),
    });
  }, [align, matchWidth, gap, viewportPadding]);

  // Drop any stale position when closed so the next open re-measures fresh.
  useLayoutEffect(() => {
    if (!open) setStyle(null);
  }, [open]);

  // Position on open, then keep following the trigger. `scroll` does not
  // bubble, but the capture listener on window receives scrolls from EVERY
  // scrollable ancestor — including modal content and the app <main>.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return { triggerRef, overlayRef, style };
}
