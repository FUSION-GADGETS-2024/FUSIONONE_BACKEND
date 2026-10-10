'use client';

import { cn } from '@/components/ui/utils';

/**
 * Amount — the app's ONE money display primitive.
 *
 * Splits the en-IN formatted number and the "Rs." suffix into separate
 * spans so each carries its own weight/color (tabular-nums prevents reflow
 * on number changes). Extracted from the dashboard page so the Analytics
 * workspace renders money in the exact same typographic language.
 */
export function Amount({
  value,
  size = 'md',
  dim = false,
  suffix = 'Rs.',
}: {
  value: number;
  size?: 'sm' | 'md' | 'lg';
  dim?: boolean;
  suffix?: string;
}) {
  const formatted = value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const dotIdx = formatted.lastIndexOf('.');
  const whole = formatted.slice(0, dotIdx);
  const dec = formatted.slice(dotIdx + 1);

  const sz = {
    sm: { symbol: 'text-[11px]', whole: 'text-sm', dec: 'text-[11px]' },
    md: { symbol: 'text-sm', whole: 'text-xl', dec: 'text-sm' },
    lg: { symbol: 'text-[15px]', whole: 'text-[26px] leading-none', dec: 'text-[15px]' },
  }[size];

  return (
    <span className={cn('inline-flex items-baseline gap-[1px] tabular-nums select-none', dim ? 'opacity-35' : '')}>
      <span className={cn(sz.whole, 'font-semibold text-slate-900 tracking-tight')}>{whole}</span>
      <span className={cn(sz.dec, 'font-normal text-slate-400')}>
        <span className="text-slate-300">.</span>{dec}
      </span>
      <span className={cn(sz.symbol, 'font-normal text-slate-500 ml-px')}>{suffix}</span>
    </span>
  );
}
