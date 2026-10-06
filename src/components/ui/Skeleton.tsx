'use client';

/**
 * Skeleton — the ONE shared loading primitive (motion + loading UX rules).
 *
 * Two exports:
 *
 *   `Skeleton`            a static placeholder bar. It never animates by
 *                          itself — motion is applied once per LOGICAL REGION
 *                          by putting `animate-pulse` (conditionally) on the
 *                          region's wrapper, so a loading page runs one
 *                          subtle animation per region instead of dozens of
 *                          per-bar shimmers.
 *
 *   `useSkeletonDelay`    the loading threshold gate. It delays ONLY the
 *                          visual skeleton treatment (its pulse/indicator),
 *                          never the request and never the content: requests
 *                          that resolve inside the grace period swap straight
 *                          to content without a skeleton flash, and a slow
 *                          request only starts showing motion after the grace
 *                          period. It contains no artificial delay on data.
 *
 * Usage:
 *   const pulsing = useSkeletonDelay(isLoading);
 *   <div className={cn('space-y-5', pulsing && 'animate-pulse')}>
 *     …static <Skeleton> bars matching the finished UI's geometry…
 *   </div>
 */
import { useEffect, useState } from 'react';
import { cn } from '@/components/ui/utils';

/**
 * Visual-only loading threshold.
 *
 * Returns false while `active` has been true for less than `delayMs`, and
 * true afterwards. Returns false immediately whenever `active` is false
 * (and resets), so a resolved request can never show a delayed skeleton.
 */
export function useSkeletonDelay(active: boolean, delayMs = 150): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const t = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(t);
  }, [active, delayMs]);

  return active && elapsed;
}

/**
 * A static placeholder bar. Geometry comes entirely from `className`
 * (height/width/rounded) so each skeleton can match the exact geometry of
 * the real UI it replaces (height, spacing, button sizes, action groups).
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('rounded bg-slate-100', className)} />;
}
