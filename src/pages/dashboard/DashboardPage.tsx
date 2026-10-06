'use client';

import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useDashboardData, RECENT_ACTIVITY_LIMIT } from '@/features/dashboard/api';
import type { DashboardActivity } from '@/features/dashboard/api';
import { Link } from 'react-router';
import {
  TrendingUp,
  Package,
  PlusCircle,
  ShoppingCart,
  ArrowDownToLine,
  ArrowUpFromLine,
  Smartphone,
  History,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';



// Splits number and Rs. suffix into separate spans so each can carry its own
// weight/color. tabular-nums prevents reflow on number changes.

function Amount({
  value,
  size = 'md',
  dim = false,
}: {
  value: number;
  size?: 'sm' | 'md' | 'lg';
  dim?: boolean;
}) {
  const formatted = value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const dotIdx = formatted.lastIndexOf('.');
  const whole = formatted.slice(0, dotIdx);
  const dec = formatted.slice(dotIdx + 1);

  const sz = {
    sm: { symbol: 'text-[11px]', whole: 'text-sm',  dec: 'text-[11px]' },
    md: { symbol: 'text-sm',     whole: 'text-xl',  dec: 'text-sm'     },
    lg: { symbol: 'text-[15px]', whole: 'text-[26px] leading-none', dec: 'text-[15px]' },
  }[size];

  return (
    <span className={cn('inline-flex items-baseline gap-[1px] tabular-nums select-none', dim ? 'opacity-35' : '')}>
      <span className={cn(sz.whole, 'font-semibold text-slate-900 tracking-tight')}>{whole}</span>
      <span className={cn(sz.dec, 'font-normal text-slate-400')}>
        <span className="text-slate-300">.</span>{dec}
      </span>
      <span className={cn(sz.symbol, 'font-normal text-slate-500 ml-px')}>Rs.</span>
    </span>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({
  label,
  primary,
  secondary,
  secondaryLabel,
  iconBg,
  icon: Icon,
}: {
  label: string;
  primary: number;
  secondary?: number;
  secondaryLabel?: string;
  iconBg: string;
  icon: React.ElementType;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400 leading-none">
          {label}
        </span>
        <div className={cn('w-6 h-6 rounded-md flex items-center justify-center shrink-0', iconBg)}>
          <Icon className="w-3 h-3" />
        </div>
      </div>

      <div className="flex flex-col gap-px">
        <Amount value={primary} size="lg" />
        <span className="text-[10px] text-slate-400 font-medium">This month</span>
      </div>

      {secondary !== undefined && secondaryLabel && (
        <div className="flex items-center justify-between pt-2 mt-auto border-t border-slate-100">
          <span className="text-[10px] text-slate-400">{secondaryLabel}</span>
          <Amount value={secondary} size="sm" dim={secondary === 0} />
        </div>
      )}
    </div>
  );
}

// ─── Stock Overview ───────────────────────────────────────────────────────────

/** One compact metric tile (the inventory card's tile language). */
function StockTile({
  label,
  value,
  caption,
  valueClassName = 'text-slate-900',
}: {
  label: string;
  value: string;
  caption: string;
  valueClassName?: string;
}) {
  return (
    <div className="bg-slate-50 rounded-lg px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums leading-none', valueClassName)}>
        {value} <span className="text-[11px] font-normal text-slate-500">Rs.</span>
      </p>
      <p className="text-[10px] text-slate-400 mt-0.5">{caption}</p>
    </div>
  );
}

/** Compact money format for the stock tiles (whole rupees, en-IN grouping). */
function fmtMoney(value: number): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/**
 * STOCK OVERVIEW — the useful version of the old two-tile inventory card:
 * the same authoritative in-stock rows the inventory page lists, folded
 * into units, cost value, selling value and the potential margin between
 * them. Fixed size regardless of how many units exist.
 */
function StockOverview({
  metrics,
  isReadOnly,
}: {
  metrics: {
    inStockCount: number;
    totalStockValue: number;
    totalStockSellingValue: number;
    stockPotentialMargin: number;
  };
  isReadOnly: boolean;
}) {
  const margin =
    metrics.stockPotentialMargin > 0
      ? 'text-emerald-600'
      : metrics.stockPotentialMargin < 0
        ? 'text-rose-600'
        : 'text-slate-400';

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-3 lg:col-span-2">
      <div className="flex items-center gap-1.5">
        <Smartphone className="w-3 h-3 text-slate-400" />
        <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Stock Overview</span>
      </div>
      <div className="grid grid-cols-2 gap-2 flex-1 content-center">
        <div className="bg-slate-50 rounded-lg px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">In Stock</p>
          <p className="text-lg font-semibold text-slate-900 tabular-nums leading-none">
            {metrics.inStockCount.toLocaleString('en-IN')}
          </p>
          <p className="text-[10px] text-slate-400 mt-0.5">units</p>
        </div>
        <StockTile label="Cost Value" value={fmtMoney(metrics.totalStockValue)} caption="at purchase price" />
        <StockTile label="Selling Value" value={fmtMoney(metrics.totalStockSellingValue)} caption="at selling price" />
        <StockTile label="Potential Margin" value={fmtMoney(metrics.stockPotentialMargin)} caption="if sold at listed price" valueClassName={margin} />
      </div>
      {!isReadOnly && (
        <Link to="/inventory" className="mt-auto">
          <p className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800 transition-colors text-center">
            Manage inventory →
          </p>
        </Link>
      )}
    </div>
  );
}

// ─── Recent Activity ──────────────────────────────────────────────────────────

/** The type chip of one activity row — the app's existing color language. */
const ACTIVITY_TYPES: Record<
  DashboardActivity['kind'],
  { label: string; chip: string; primary: string }
> = {
  sale:        { label: 'Sale',        chip: 'bg-emerald-50 text-emerald-700',  primary: 'text-emerald-700' },
  purchase:    { label: 'Purchase',    chip: 'bg-indigo-50 text-indigo-700',    primary: 'text-indigo-700' },
  payment_in:  { label: 'Payment In',  chip: 'bg-sky-50 text-sky-700',          primary: 'text-sky-700' },
  payment_out: { label: 'Payment Out', chip: 'bg-rose-50 text-rose-600',        primary: 'text-rose-600' },
};

/**
 * RECENT ACTIVITY — a fixed-size preview of the latest business events
 * (sales, purchases, payments), derived from the same transaction data
 * the dashboard already folds. Purely a preview: no "view all" action,
 * no internal scrolling — at most RECENT_ACTIVITY_LIMIT rows.
 */
function RecentActivity({ activity }: { activity: DashboardActivity[] }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 flex flex-col min-h-0 lg:col-span-3">
      <div className="flex items-center gap-1.5 px-4 pt-4 pb-3 border-b border-slate-100">
        <History className="w-3 h-3 text-slate-400" />
        <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Recent Activity</span>
        <span className="ml-auto text-[10px] text-slate-400">This FY</span>
      </div>
      {activity.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-8 text-xs text-slate-400">
          No activity in this financial year yet.
        </div>
      ) : (
        <div className="flex-1 divide-y divide-slate-50">
          {activity.map((event, i) => {
            const type = ACTIVITY_TYPES[event.kind];
            // Invoices identify the event; payments identify the party.
            const primary = event.billNumber ?? event.partyName ?? '—';
            const secondary = event.billNumber ? (event.partyName ?? '—') : null;
            return (
              <div key={`${event.kind}-${event.billNumber ?? event.partyName ?? 'x'}-${event.date}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                <span className={cn('shrink-0 rounded px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider leading-none', type.chip)}>
                  {type.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-xs font-semibold tabular-nums leading-tight', type.primary)}>{primary}</p>
                  {secondary && <p className="truncate text-[10px] text-slate-400 leading-tight mt-0.5">{secondary}</p>}
                </div>
                <div className="shrink-0 flex flex-col items-end">
                  <Amount value={event.amount} size="sm" dim={event.amount === 0} />
                  <p className="text-[10px] text-slate-400 tabular-nums leading-tight mt-0.5">{event.date}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
// Only shown on a genuine first load for the working year's query key (no
// usable data yet — e.g. app boot or a year SWITCH, where showing the
// previous year's numbers would be wrong). A cached remount renders the real
// dashboard immediately; a same-key background revalidation keeps the page
// visible with the subtle opacity dim below (never the skeleton).
// Geometry mirrors the finished page (header row, 4 metric cards at their
// real height, the 2-card lower row); motion is a single threshold-gated
// pulse on the whole region.

function Skeleton({ pulsing }: { pulsing: boolean }) {
  return (
    <div className={cn('space-y-5 select-none', pulsing && 'animate-pulse')}>
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <div className="h-4 w-20 bg-slate-100 rounded" />
          <div className="h-3 w-36 bg-slate-100 rounded" />
        </div>
        <div className="flex gap-2">
          <div className="h-8 w-24 bg-slate-100 rounded-md" />
          <div className="h-8 w-28 bg-slate-100 rounded-md" />
          <div className="h-8 w-24 bg-slate-100 rounded-md" />
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => <div key={i} className="h-[106px] bg-slate-100 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        <div className="lg:col-span-2 h-[220px] bg-slate-100 rounded-xl" />
        <div className="lg:col-span-3 h-[220px] bg-slate-100 rounded-xl" />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();

  const dashboardQuery = useDashboardData(selectedYear, isReadOnly, fyLoading);

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(fyLoading || (dashboardQuery.isLoading && !dashboardQuery.data));

  // Show skeleton on first load only (no cached data yet)
  if (fyLoading || (dashboardQuery.isLoading && !dashboardQuery.data)) return <Skeleton pulsing={skeletonPulsing} />;

  const data = dashboardQuery.data;
  const metrics = data?.metrics ?? {
    inStockCount: 0,
    totalStockValue: 0,
    totalStockSellingValue: 0,
    stockPotentialMargin: 0,
    todaySales: 0,
    thisMonthSales: 0,
    todayPurchases: 0,
    thisMonthPurchases: 0,
    totalDuesToReceive: 0,
    totalPayables: 0,
  };
  const recentActivity = (data?.recentActivity ?? []).slice(0, RECENT_ACTIVITY_LIMIT);

  const fyLabel = selectedYear ? `${selectedYear.start_date} – ${selectedYear.end_date}` : '—';
  // Dim slightly while a background revalidation is running (short opacity
  // transition only — the layout never moves).
  const dimming = dashboardQuery.isFetching && !!dashboardQuery.data ? 'opacity-70 pointer-events-none' : '';

  return (
    <div className={cn('space-y-5 transition-opacity duration-150', dimming)}>

      {/* ── header row ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Overview</h1>
          <p className="text-[11px] text-slate-400 mt-1">
            FY {fyLabel}{isReadOnly ? ' · Read only' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isReadOnly ? (
            <>
              <Button disabled size="sm" variant="outline" className="gap-1.5 text-xs h-8">
                <PlusCircle className="h-3.5 w-3.5" /> New Sale
              </Button>
              <Button disabled size="sm" variant="outline" className="gap-1.5 text-xs h-8">
                <ShoppingCart className="h-3.5 w-3.5" /> New Purchase
              </Button>
            </>
          ) : (
            <>
              <Link to="/sales/new">
                <Button size="sm" className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
                  <PlusCircle className="h-3.5 w-3.5" /> New Sale
                </Button>
              </Link>
              <Link to="/purchases/new">
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-8">
                  <ShoppingCart className="h-3.5 w-3.5" /> New Purchase
                </Button>
              </Link>
              <Link to="/inventory">
                <Button size="sm" variant="outline" className="gap-1.5 text-xs h-8">
                  <Package className="h-3.5 w-3.5" /> Add Stock
                </Button>
              </Link>
            </>
          )}
        </div>
      </div>

      {/* ── metric cards ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Sales"      primary={metrics.thisMonthSales}     secondary={metrics.todaySales}     secondaryLabel="Today" iconBg="bg-indigo-50 text-indigo-500"  icon={TrendingUp}      />
        <MetricCard label="Purchases"  primary={metrics.thisMonthPurchases} secondary={metrics.todayPurchases} secondaryLabel="Today" iconBg="bg-violet-50 text-violet-500"  icon={ShoppingCart}    />
        <MetricCard label="To Receive" primary={metrics.totalDuesToReceive}                                                           iconBg="bg-emerald-50 text-emerald-500" icon={ArrowDownToLine}  />
        <MetricCard label="To Pay"     primary={metrics.totalPayables}                                                                iconBg="bg-rose-50 text-rose-500"     icon={ArrowUpFromLine}  />
      </div>

      {/* ── lower row: stock overview (compact) | recent activity (wider) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 items-stretch">
        <StockOverview metrics={metrics} isReadOnly={isReadOnly} />
        <RecentActivity activity={recentActivity} />
      </div>
    </div>
  );
}
