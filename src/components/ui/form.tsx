'use client';

/**
 * form.tsx — the shared form composition primitives.
 *
 * `Field` standardizes the label / control / hint rhythm used by every form
 * (editors and dialogs): one label row (label + optional inline action like
 * "+ New"), the control, and an optional helper line.
 *
 * ERROR UX (the app-wide contract): pass `error` (a plain-business-language
 * message) and Field renders it directly under the control in the message
 * rhythm — replacing the hint while showing — and provides the error id to
 * the control through FieldErrorContext, so Input/MoneyInput/… inside the
 * field self-wire `aria-invalid` + `aria-describedby` automatically. The
 * control's red border comes from the same context. One prop at the call
 * site, complete field-error UX.
 *
 * `FormError` is the same message rhythm for form-level business rules that
 * belong to no single field (e.g. "Add at least one product before saving
 * the sale.").
 *
 * `SectionCard` standardizes editor section surfaces: a Card with the
 * application's quiet micro-uppercase section label, an optional inline
 * action, and the compact p-4 content rhythm.
 */
import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '@/components/ui/utils';
import { Card, CardContent } from '@/components/ui/Card';

/** What a control inside a Field needs to self-wire its error state. */
const FieldErrorContext = createContext<{ errorId: string; hasError: boolean } | null>(null);

/** Read the owning Field's error state (controls call this internally). */
export function useFieldError() {
  return useContext(FieldErrorContext);
}

export interface FieldProps {
  label: ReactNode;
  /** Inline action on the label row's right (e.g. the "+ New" link). */
  action?: ReactNode;
  /** Helper text under the control (hidden while an error is showing). */
  hint?: ReactNode;
  /** Field error message — rendered under the control, plain business language. */
  error?: ReactNode;
  /** Renders the required marker next to the label. */
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}

export function Field({ label, action, hint, error, required, children, htmlFor, className }: FieldProps) {
  const errorId = useId();
  const hasError = error != null && error !== false && error !== '';
  return (
    <FieldErrorContext.Provider value={hasError ? { errorId, hasError: true } : null}>
      <div className={cn('space-y-1', className)}>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={htmlFor} className="text-xs font-medium text-slate-600">
            {label}
            {required && <span className="text-rose-500 ml-0.5" aria-hidden="true">*</span>}
          </label>
          {action}
        </div>
        {children}
        {hasError ? (
          <p id={errorId} role="alert" className="text-[10px] font-medium text-rose-600 leading-snug">
            {error}
          </p>
        ) : (
          hint && <p className="text-[10px] text-slate-400 leading-snug">{hint}</p>
        )}
      </div>
    </FieldErrorContext.Provider>
  );
}

/**
 * FormError — a form-level business-rule message (belongs to no single
 * field). Same message rhythm as a field error; placed next to the section
 * or action it concerns.
 */
export function FormError({ children, className }: { children: ReactNode; className?: string }) {
  if (children == null || children === false) return null;
  return (
    <p role="alert" className={cn('text-xs font-medium text-rose-600 leading-snug', className)}>
      {children}
    </p>
  );
}

export interface SectionCardProps {
  /** Quiet micro-uppercase section label; omit for untitled sections. */
  title?: ReactNode;
  /** Optional leading icon on the title row. */
  icon?: ReactNode;
  /** Inline action on the title row's right (e.g. an Add button). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function SectionCard({ title, icon, action, children, className, contentClassName }: SectionCardProps) {
  return (
    <Card className={cn('shadow-sm', className)}>
      <CardContent className={cn('p-4', contentClassName)}>
        {title !== undefined && (
          <div className="flex items-center justify-between gap-2 mb-4 border-b border-slate-100 pb-2.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 flex items-center gap-2">
              {icon}
              {title}
            </h3>
            {action}
          </div>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * SummaryLine — the ONE totals-row rhythm for editor sidebars and payment
 * panels: label left, tabular-nums value right. Semantic weight/color comes
 * from `labelClassName` / `valueClassName`.
 */
export function SummaryLine({
  label,
  value,
  className,
  labelClassName,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 text-xs', className)}>
      <span className={cn('text-slate-600', labelClassName)}>{label}</span>
      <span className={cn('tabular-nums text-slate-900', valueClassName)}>{value}</span>
    </div>
  );
}
