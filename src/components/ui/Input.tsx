import React from 'react'
import { cn } from '@/components/ui/utils'
import { useFieldError } from '@/components/ui/form'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean
  icon?: React.ReactNode
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, icon, type, 'aria-describedby': describedByProp, 'aria-invalid': ariaInvalidProp, ...props }, ref) => {
    // Inside a Field with an error, self-wire the a11y contract: the red
    // border, aria-invalid and the link to the message rendered by Field.
    const fieldError = useFieldError()
    const invalid = error || !!fieldError || ariaInvalidProp === true
    const describedBy = fieldError
      ? [describedByProp, fieldError.errorId].filter(Boolean).join(' ') || undefined
      : describedByProp
    return (
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
            {icon}
          </div>
        )}
        <input
          type={type}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 transition-colors shadow-sm',
            icon && 'pl-10',
            invalid && 'border-rose-500 focus:ring-rose-500',
            className,
          )}
          ref={ref}
          {...props}
        />
      </div>
    )
  },
)
Input.displayName = 'Input'
