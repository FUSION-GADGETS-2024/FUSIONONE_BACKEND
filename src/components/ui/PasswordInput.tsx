import React, { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/components/ui/utils'

/**
 * PasswordInput — the ONE reusable password field (spec: every password
 * input gets an independent show/hide toggle, with identical icon size,
 * placement, padding, hover/focus behavior and aria labels everywhere).
 *
 * Implementation contract:
 *   * visibility is PER-INSTANCE state (new password visible + confirm
 *     hidden at the same time is possible; no shared/global toggle)
 *   * the toggle is a real <button type="button"> — keyboard accessible,
 *     never submits the surrounding form, never alters the value
 *   * only the input TYPE flips between "password" and "text" —
 *     password-manager semantics (autocomplete hints, value) are
 *     untouched; pass autoComplete="current-password"/"new-password"
 *     through props as appropriate
 *   * the right slot (pr-10) is always reserved — toggling never shifts
 *     the layout
 */
export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  error?: boolean
  icon?: React.ReactNode
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, error, icon, ...props }, ref) => {
    const [visible, setVisible] = useState(false)

    return (
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
            {icon}
          </div>
        )}
        <input
          type={visible ? 'text' : 'password'}
          className={cn(
            'flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 transition-colors shadow-sm',
            icon && 'pl-10',
            'pr-10',
            error && 'border-rose-500 focus:ring-rose-500',
            className,
          )}
          ref={ref}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 focus:outline-none focus:text-slate-600 transition-colors"
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'
