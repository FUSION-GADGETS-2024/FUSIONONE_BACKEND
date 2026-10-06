import React from 'react'
import { cn } from '@/components/ui/utils'
import { Loader2 } from 'lucide-react'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  isLoading?: boolean
}

/**
 * Button — the application's ONE button primitive, including its async
 * (isLoading) behavior.
 *
 * STABLE LOADING GEOMETRY (the core invariant): the button's externally
 * visible dimensions — width, height, padding, placement, and its footprint
 * in the surrounding layout — are IDENTICAL in the default, loading, and
 * returned states. Loading only changes the internal visual state; it can
 * never expand or shrink the control, move neighbors, or reflow a footer.
 *
 * How that is guaranteed, without fixed widths or measured widths:
 *
 *  1. Children ALWAYS stay mounted in the button's flex row. The wrapper span
 *     is `display: contents` (boxless), so children keep participating in the
 *     button's own flex layout exactly as before — gaps, wrapping, margins,
 *     and icon sizing all behave identically whether idle or busy.
 *
 *  2. While loading, the wrapper merely turns its inherited COLOR transparent
 *     (`text-transparent`). Color inherits through `display: contents`, so
 *     every text node and every currentColor icon becomes invisible WITHOUT
 *     giving up its box: the label keeps its exact footprint, and — because
 *     transparent text is still in the accessibility tree — the button keeps
 *     its accessible name while busy.
 *
 *  3. The busy spinner lives in an absolutely positioned overlay covering the
 *     button. It contributes NOTHING to the button's intrinsic size, and as a
 *     SIBLING of the transparent wrapper it re-inherits the button's own text
 *     color (white on primary/danger, slate on outline/ghost — including
 *     per-usage color overrides).
 *
 * Usage note: render leading icons UNCONDITIONALLY (never
 * `{!loading && <Icon/>}`) so the reserved footprint is the same in every
 * state — the wrapper makes them transparent automatically while busy.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading, children, disabled, ...props }, ref) => {
    const variants = {
      primary:
        'bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-500 shadow-sm border border-transparent',
      secondary:
        'bg-slate-100 text-slate-900 hover:bg-slate-200 focus-visible:ring-slate-500 border border-transparent',
      outline:
        'bg-white text-slate-700 hover:bg-slate-50 border-slate-300 focus-visible:ring-slate-500 shadow-sm hover:text-slate-900',
      ghost:
        'bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:ring-slate-500 hover:text-slate-900',
      danger:
        'bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-500 shadow-sm border border-transparent',
    }

    const sizes = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-10 px-4 py-2 text-sm',
      lg: 'h-12 px-6 py-3 text-base',
    }

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(
          'relative inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none',
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      >
        {/* Stable-geometry content wrapper — see the component docblock. */}
        <span className={cn('contents', isLoading && 'text-transparent')}>{children}</span>
        {isLoading && (
          <span
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            aria-hidden="true"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
          </span>
        )}
      </button>
    )
  },
)
Button.displayName = 'Button'
