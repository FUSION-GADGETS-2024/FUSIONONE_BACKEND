'use client';

/**
 * MoneyInput — the application's ONE numeric/money input.
 *
 * A text-based decimal field with the standard FUSION ONE input styling:
 *   - no native number spinners (it is never `type="number"`);
 *   - `inputMode="decimal"` / `"numeric"` keeps the mobile numeric keyboard;
 *   - right-aligned, tabular-nums digits — easy to scan columns of amounts
 *     without switching the control to a monospace font;
 *   - sanitization keeps digits, one decimal separator, and an optional
 *     leading minus (off by default — business amounts are non-negative).
 *
 * The value stays a string in the caller's state; existing parse/validate
 * logic (`Number(value)`, min/max checks, payment limits) is unchanged.
 */
import React from 'react';
import { cn } from '@/components/ui/utils';
import { useFieldError } from '@/components/ui/form';

export interface MoneyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'inputMode'> {
  value: string;
  onChange: (value: string) => void;
  error?: boolean;
  /** Maximum decimal places. Default 2 (money); 0 = whole numbers (qty). */
  decimals?: number;
  /** Allow a leading minus sign (default false). */
  allowNegative?: boolean;
}

/** Keep digits, the first '.', bounded decimals, and an optional leading '-'. */
function sanitize(raw: string, decimals: number, allowNegative: boolean): string {
  let s = raw.replace(/[^\d.-]/g, '');
  const negative = allowNegative && s.includes('-');
  s = s.replace(/-/g, '');
  const sign = (digits: string) => (digits === '' ? '' : negative ? `-${digits}` : digits);
  const dot = s.indexOf('.');
  if (dot !== -1) {
    const int = s.slice(0, dot).replace(/\./g, '');
    const frac = s.slice(dot + 1).replace(/\./g, '');
    if (decimals === 0) return sign(int);
    return `${sign(int || '0')}.${frac.slice(0, decimals)}`;
  }
  return sign(s);
}

export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ className, error, decimals = 2, allowNegative = false, value, onChange, 'aria-describedby': describedByProp, 'aria-invalid': ariaInvalidProp, ...props }, ref) => {
    // Inside a Field with an error, self-wire the a11y contract (Input's).
    const fieldError = useFieldError();
    const invalid = error || !!fieldError || ariaInvalidProp === true;
    const describedBy = fieldError
      ? [describedByProp, fieldError.errorId].filter(Boolean).join(' ') || undefined
      : describedByProp;
    return (
      <input
        ref={ref}
        type="text"
        inputMode={decimals === 0 ? 'numeric' : 'decimal'}
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        {...props}
        value={value}
        onChange={e => onChange(sanitize(e.target.value, decimals, allowNegative))}
        className={cn(
          'flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 text-right tabular-nums placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 transition-colors shadow-sm',
          invalid && 'border-rose-500 focus:ring-rose-500',
          className,
        )}
      />
    );
  },
);
MoneyInput.displayName = 'MoneyInput';
