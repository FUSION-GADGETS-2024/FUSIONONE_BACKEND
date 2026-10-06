'use client';

/**
 * PageHeader — the application's standard page header (the Party Detail
 * pattern): title (with an optional inline badge — e.g. the invoice status
 * pill, a primary document-level attribute that belongs beside the invoice
 * identity) and subtitle on the left, the contextual back button on the
 * right. The editor pages share this one component so their header
 * hierarchy can never drift apart from the rest of the application.
 */
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAppBack } from '@/components/useAppBack';

export interface PageHeaderProps {
  title: ReactNode;
  /** Inline document-level badge rendered next to the title (e.g. the
   *  invoice status pill). Wraps below the title on very narrow widths. */
  badge?: ReactNode;
  subtitle?: ReactNode;
  /** Fallback route for direct entry — browser history back is preferred. */
  backTo: string;
  /** Contextual label, e.g. "Back to Sales". */
  backLabel: string;
}

export function PageHeader({ title, badge, subtitle, backTo, backLabel }: PageHeaderProps) {
  const goBack = useAppBack(backTo);
  return (
    // Stacks below sm — the app's fixed mobile sidebar leaves too little
    // width for title and back button side by side.
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        {/* Hierarchy: document identity → status badge → descriptive
            context (the badge sits ON the title line, the subtitle below). */}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-base font-semibold text-slate-900 tracking-tight leading-none">{title}</h1>
          {badge}
        </div>
        {subtitle ? <p className="text-[11px] text-slate-400 mt-1.5">{subtitle}</p> : null}
      </div>
      <Button size="sm" variant="outline" onClick={goBack} className="gap-1.5 shrink-0">
        <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
      </Button>
    </div>
  );
}
