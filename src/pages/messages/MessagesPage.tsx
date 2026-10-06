'use client';

/**
 * MessagesPage — the user-facing view over the EXISTING durable message
 * system (route /messages, page name "Messages").
 *
 *   Messages
 *   Scheduled and sent WhatsApp messages
 *
 *   [ Recent Messages ] [ Scheduled Reminders ]     (Payments-style tabs)
 *   [ Pending ] [ Sent today ] [ Needs attention ]  (one aggregate call)
 *   ── Recent messages ─────────────────────────
 *   ✓ Payment receipt sent
 *     Rahul Test Customer · ₹1,000
 *     Today, 2:42 PM
 *
 * Architecture (a VIEW, not a monitor — see features/messages/api.ts):
 *   - Recent Messages is the default tab; Scheduled Reminders loads
 *     lazily on first open, then both lists are cached (staleTime).
 *   - Both lists are keyset-paginated with scroll-to-load (the same
 *     IntersectionObserver sentinel pattern as the party invoice lists).
 *   - Live updates ride the EXISTING SSE MESSAGE_JOB_RESULT stream
 *     (useMessageJobEvents patches the caches — no polling).
 *   - Deliberately ABSENT: WhatsApp connection state (the root app owns
 *     it), scheduler diagnostics, and the test-only fast-forward tool —
 *     technical job metadata appears only in a per-row details dialog.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  BellRing, FileText, Receipt, ScrollText, Send,
} from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { Modal } from '@/components/ui/Modal';
import { SegmentedTabs } from '@/components/ui/SegmentedTabs';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { ListPage } from '@/components/list-page/ListPage';
import { ListViewport } from '@/components/list-page/ListViewport';
import { ListFirstLoadError, ListStatusTail } from '@/components/list-page/ListStatusTail';
import { useInfiniteListPagination } from '@/components/list-page/use-list-pagination';
import {
  useMessagesOverview,
  useRecentMessages,
  useScheduledReminders,
  type MessageJobRow,
  type ScheduledReminderRow,
} from '@/features/messages/api';

// ─── Presentation model (labels, icons, formatting) ─────────────────────────

/** Document vocabulary — the same words the rest of the app uses for
 *  these WhatsApp documents (Settings → WhatsApp, Payments). The raw
 *  job_type strings are internal identifiers and never shown. */
const JOB_TYPE_META: Record<string, { label: string; rowLabel: string; icon: typeof Send }> = {
  invoice_send: { label: 'Invoice', rowLabel: 'Invoice', icon: Send },
  reminder: { label: 'Reminder', rowLabel: 'Reminder', icon: BellRing },
  receipt: { label: 'Payment Receipt', rowLabel: 'Payment receipt', icon: Receipt },
  statement: { label: 'Payment Statement', rowLabel: 'Payment statement', icon: ScrollText },
};

/** User-facing status for one job (Sent / Pending / Retrying / Failed /
 *  Cancelled — never the raw queue vocabulary). */
interface MessageStatus {
  /** The status word used in the row title ("Payment receipt sent"). */
  word: string;
  /** The formal status label for the details dialog ("Sent"). */
  label: string;
  tone: 'ok' | 'busy' | 'bad' | 'off';
}

function messageStatus(job: MessageJobRow): MessageStatus {
  switch (job.status) {
    case 'succeeded':
      return { word: 'sent', label: 'Sent', tone: 'ok' };
    case 'processing':
      return { word: 'sending', label: 'Sending', tone: 'busy' };
    case 'failed':
      return { word: 'failed', label: 'Failed', tone: 'bad' };
    case 'cancelled':
      return { word: 'cancelled', label: 'Cancelled', tone: 'off' };
    case 'pending':
      // A pending reminder with no attempts yet is a SCHEDULED future
      // send; any pending job that already attempted once is retrying.
      return job.attempts > 0
        ? { word: 'retrying', label: 'Retrying', tone: 'busy' }
        : job.job_type === 'reminder'
          ? { word: 'scheduled', label: 'Scheduled', tone: 'busy' }
          : { word: 'pending', label: 'Pending', tone: 'busy' };
  }
}

const TONE_TILE: Record<MessageStatus['tone'] | 'info', string> = {
  ok: 'bg-emerald-50 text-emerald-600',
  busy: 'bg-amber-50 text-amber-600',
  bad: 'bg-rose-50 text-rose-600',
  off: 'bg-slate-100 text-slate-400',
  info: 'bg-indigo-50 text-indigo-600',
};

const TONE_BADGE: Record<MessageStatus['tone'], string> = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  busy: 'bg-amber-50 text-amber-700 border-amber-200',
  bad: 'bg-rose-50 text-rose-700 border-rose-200',
  off: 'bg-slate-100 text-slate-500 border-slate-200',
};

/** The row title: action/result — "Payment receipt sent". */
function messageTitle(job: MessageJobRow): string {
  const meta = JOB_TYPE_META[job.job_type] ?? { label: 'Message', rowLabel: 'Message', icon: FileText };
  const status = messageStatus(job);
  if (job.status === 'processing') return `${meta.rowLabel} ${status.word}…`;
  return `${meta.rowLabel} ${status.word}`;
}

/** The customer + business reference for the context line — payments
 *  show the amount, invoices/statements/reminders show the bill number. */
function messageContext(job: MessageJobRow): string {
  const amount = (v: string | number) =>
    `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  if (job.payments_in) {
    const party = job.payments_in.parties?.name;
    const value = amount(job.payments_in.amount);
    return party ? `${party} · ${value}` : value;
  }
  if (job.payments_out) {
    const party = job.payments_out.parties?.name;
    const value = amount(job.payments_out.amount);
    return party ? `${party} · ${value}` : value;
  }
  const ref = job.sales ?? job.purchases ?? job.proforma_invoices;
  if (ref) {
    const party = ref.parties?.name;
    return party ? `${party} · ${ref.bill_number}` : ref.bill_number;
  }
  return '—';
}

/** The customer name alone (details dialog). */
function messageCustomer(job: MessageJobRow): string | null {
  return (
    job.payments_in?.parties?.name ??
    job.payments_out?.parties?.name ??
    job.sales?.parties?.name ??
    job.purchases?.parties?.name ??
    job.proforma_invoices?.parties?.name ??
    null
  );
}

// ─── Date/time formatting (compact, en-IN — the app's locale) ───────────────

/** "Today, 2:42 PM" / "4 Oct, 2:42 PM" / "4 Oct 2025, 2:42 PM". */
function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (sameDay) return `Today, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${day}, ${time}`;
}

/** The row's timestamp line: when it settled, or when it is scheduled. */
function messageTime(job: MessageJobRow): string {
  if (job.status === 'processing') return 'Sending…';
  if (job.status === 'pending') return `Scheduled ${formatWhen(job.run_at)}`;
  return formatWhen(job.finished_at ?? job.created_at);
}

/** A short future date for the Scheduled Reminders list: "11 Oct" (year
 *  only when it differs from the current one). */
function formatDay(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// ─── Shared list pieces ──────────────────────────────────────────────────────

/** The icon tile that leads every message/reminder row (FUSION ONE's
 *  rounded icon-tile language — type icon, status tone). */
function RowIcon({
  icon: Icon, tone,
}: { icon: typeof Send; tone: MessageStatus['tone'] | 'info' }) {
  return (
    <div className={cn('h-8 w-8 rounded-lg flex items-center justify-center shrink-0', TONE_TILE[tone])}>
      <Icon className="h-4 w-4" />
    </div>
  );
}

/** One definition row of the details dialog. */
function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="text-xs text-slate-400 shrink-0">{label}</dt>
      <dd className="text-xs text-slate-900 text-right min-w-0 break-words">{children}</dd>
    </div>
  );
}

// ─── Recent Messages tab ─────────────────────────────────────────────────────

function SummaryCard({
  label, value, tone,
}: { label: string; value: number | null; tone: 'busy' | 'ok' | 'bad' }) {
  const color =
    value === null
      ? 'text-slate-300'
      : tone === 'bad'
        ? value > 0 ? 'text-rose-600' : 'text-slate-900'
        : tone === 'busy'
          ? value > 0 ? 'text-amber-600' : 'text-slate-900'
          : 'text-slate-900';
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums leading-none', color)}>
        {value === null ? '—' : value.toLocaleString('en-IN')}
      </p>
    </div>
  );
}

/** One message row's skeleton — the exact geometry of a loaded row. */
function MessageRowSkeleton({ withTimestamp = true }: { withTimestamp?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="h-8 w-8 rounded-lg bg-slate-100 shrink-0" />
      <div className="flex-1 min-w-0 space-y-2 py-0.5">
        <div className="h-3.5 w-44 bg-slate-100 rounded" />
        <div className="h-3 w-64 max-w-full bg-slate-100 rounded" />
        <div className="h-3 w-24 bg-slate-100 rounded sm:hidden" />
      </div>
      {withTimestamp && <div className="hidden sm:block h-3 w-24 bg-slate-100 rounded mt-1.5" />}
    </div>
  );
}

function RecentMessagesTab({
  onOpenDetails,
}: { onOpenDetails: (job: MessageJobRow) => void }) {
  const overviewQuery = useMessagesOverview(true);
  const overview = overviewQuery.data ?? null;

  const listQuery = useRecentMessages();
  const rows = useMemo(
    () => (listQuery.data?.pages ?? []).flatMap((page) => page.rows),
    [listQuery.data],
  );

  // The ONE consolidated scroll-to-load state (guards, silent fetching,
  // end detection, retry) — shared with every list in the app.
  const pagination = useInfiniteListPagination(listQuery);

  const summaryPulsing = useSkeletonDelay(overviewQuery.isLoading);
  const listPulsing = useSkeletonDelay(pagination.isLoadingFirst);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Summary — three practical counts, ONE aggregate call. */}
      <div className={cn('grid shrink-0 grid-cols-3 gap-3 sm:gap-4', summaryPulsing && 'animate-pulse')}>
        <SummaryCard label="Pending" value={overview?.pending ?? null} tone="busy" />
        <SummaryCard label="Sent today" value={overview?.sentToday ?? null} tone="ok" />
        <SummaryCard label="Needs attention" value={overview?.needsAttention ?? null} tone="bad" />
      </div>

      {/* Recent messages — the list card: fixed section header, the rows
          viewport is the page's single scroll container (early silent
          prefetch appends the next keyset page before the user arrives). */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="shrink-0 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Recent messages</h2>
          <p className="text-[11px] text-slate-400">
            WhatsApp messages sent from FUSION ONE — newest first
          </p>
        </div>

        <ListViewport restoreKey="recent">
          <div className="flex min-h-full flex-col">
            {pagination.isLoadingFirst ? (
              // First-page skeleton — same geometry as the loaded rows.
              <div className={cn('divide-y divide-slate-50', listPulsing && 'animate-pulse')}>
                {[...Array(6)].map((_, i) => <MessageRowSkeleton key={i} />)}
              </div>
            ) : pagination.initialFailed ? (
              <ListFirstLoadError
                message="Unable to load messages"
                onRetry={pagination.retryInitial}
              />
            ) : rows.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center">
                <Send className="h-6 w-6 text-slate-300 mx-auto mb-2" />
                <p className="text-xs font-semibold text-slate-500">No messages yet</p>
                <p className="text-xs text-slate-400 mt-1">
                  Messages sent from FUSION ONE will appear here.
                </p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-slate-50">
                  {rows.map((job) => {
                    const meta =
                      JOB_TYPE_META[job.job_type] ?? { label: 'Message', rowLabel: 'Message', icon: FileText };
                    const status = messageStatus(job);
                    return (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => onOpenDetails(job)}
                        className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-slate-50/60 transition-colors"
                      >
                        <RowIcon icon={meta.icon} tone={status.tone} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-slate-900 leading-5 truncate">
                            {messageTitle(job)}
                          </p>
                          <p className="text-xs text-slate-500 leading-5 truncate">{messageContext(job)}</p>
                          <p className="text-xs text-slate-400 leading-5 sm:hidden">{messageTime(job)}</p>
                        </div>
                        <p className="hidden sm:block text-xs text-slate-400 whitespace-nowrap mt-1.5">
                          {messageTime(job)}
                        </p>
                      </button>
                    );
                  })}
                </div>
                {/* Prefetch sentinel + Loading more… / retry (an
                    exhausted list renders nothing — it simply ends) */}
                <ListStatusTail pagination={pagination} hasRows />
              </>
            )}
          </div>
        </ListViewport>
      </section>
    </div>
  );
}

// ─── Scheduled Reminders tab// ─── Scheduled Reminders tab ─────────────────────────────────────────────────

function ScheduledReminderRowView({ row }: { row: ScheduledReminderRow }) {
  const sale = row.sales;
  const party = sale?.parties?.name ?? null;
  const due = sale ? Number(sale.due ?? 0) : null;
  const progress = sale?.reminder_settings ?? null;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <RowIcon icon={BellRing} tone="info" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-slate-900 leading-5 truncate">{party ?? 'Reminder'}</p>
        <p className="text-xs text-slate-500 leading-5 truncate">
          {sale ? (
            <>
              {sale.bill_number}
              {due !== null && (
                <>
                  {' · '}
                  <span className="font-medium text-slate-700">
                    ₹{due.toLocaleString('en-IN', { maximumFractionDigits: 2 })} due
                  </span>
                </>
              )}
              {progress && (
                <>
                  {' · '}
                  <span className="text-slate-400">
                    {progress.reminders_sent} of {progress.max_reminders} sent
                  </span>
                </>
              )}
            </>
          ) : (
            '—'
          )}
        </p>
        {/* Mobile: the next-reminder date stacks under the context line. */}
        <p className="text-xs text-slate-400 leading-5 md:hidden">
          Next reminder {formatDay(row.run_at)}
        </p>
      </div>
      <div className="hidden md:block text-right shrink-0 pt-0.5">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Next reminder</p>
        <p className="text-xs font-semibold text-slate-900 tabular-nums mt-0.5">
          {formatDay(row.run_at)}
        </p>
      </div>
    </div>
  );
}

/** One scheduled-reminder row's skeleton — the loaded row's geometry. */
function ReminderRowSkeleton() {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="h-8 w-8 rounded-lg bg-slate-100 shrink-0" />
      <div className="flex-1 min-w-0 space-y-2 py-0.5">
        <div className="h-3.5 w-40 bg-slate-100 rounded" />
        <div className="h-3 w-64 max-w-full bg-slate-100 rounded" />
        <div className="h-3 w-28 bg-slate-100 rounded md:hidden" />
      </div>
      <div className="hidden md:block text-right space-y-1.5 pt-0.5">
        <div className="h-2.5 w-20 bg-slate-100 rounded ml-auto" />
        <div className="h-3.5 w-14 bg-slate-100 rounded ml-auto" />
      </div>
    </div>
  );
}

function ScheduledRemindersTab() {
  // Lazy by construction: this component only mounts when the tab is
  // active, so the query below runs its FIRST request exactly then.
  const listQuery = useScheduledReminders(true);
  const rows = useMemo(
    () => (listQuery.data?.pages ?? []).flatMap((page) => page.rows),
    [listQuery.data],
  );

  const pagination = useInfiniteListPagination(listQuery);
  const listPulsing = useSkeletonDelay(pagination.isLoadingFirst);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="shrink-0 border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Scheduled reminders</h2>
        <p className="text-[11px] text-slate-400">
          Payment reminders scheduled for outstanding invoices — next reminder first
        </p>
      </div>

      <ListViewport restoreKey="scheduled">
        <div className="flex min-h-full flex-col">
          {pagination.isLoadingFirst ? (
            <div className={cn('divide-y divide-slate-50', listPulsing && 'animate-pulse')}>
              {[...Array(3)].map((_, i) => <ReminderRowSkeleton key={i} />)}
            </div>
          ) : pagination.initialFailed ? (
            <ListFirstLoadError
              message="Unable to load scheduled reminders"
              onRetry={pagination.retryInitial}
            />
          ) : rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center">
              <BellRing className="h-6 w-6 text-slate-300 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-500">No scheduled reminders</p>
              <p className="text-xs text-slate-400 mt-1">
                Reminder schedules for outstanding invoices will appear here.
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-50">
                {rows.map((row) => (
                  <ScheduledReminderRowView key={row.id} row={row} />
                ))}
              </div>
              {/* Prefetch sentinel + Loading more… / retry (an
                  exhausted list renders nothing — it simply ends) */}
              <ListStatusTail pagination={pagination} hasRows />
            </>
          )}
        </div>
      </ListViewport>
    </section>
  );
}

// ─── Message details dialog// ─── Message details dialog (secondary surface, on-list data only) ──────────

function MessageDetailDialog({
  job, onClose,
}: { job: MessageJobRow | null; onClose: () => void }) {
  const meta = job
    ? JOB_TYPE_META[job.job_type] ?? { label: 'Message', rowLabel: 'Message', icon: FileText }
    : null;
  const status = job ? messageStatus(job) : null;

  return (
    <Modal
      isOpen={!!job}
      onClose={onClose}
      title={meta?.label ?? ''}
    >
      {job && status && (
        <dl className="divide-y divide-slate-50">
          <DetailField label="Customer">{messageCustomer(job) ?? '—'}</DetailField>
          <DetailField label="Status">
            <span
              className={cn(
                'inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold',
                TONE_BADGE[status.tone],
              )}
            >
              {status.label}
            </span>
          </DetailField>
          {job.status === 'succeeded' ? (
            <DetailField label="Sent at">{formatWhen(job.finished_at ?? job.created_at)}</DetailField>
          ) : job.status === 'pending' || job.status === 'processing' ? (
            <DetailField label="Scheduled for">{formatWhen(job.run_at)}</DetailField>
          ) : (
            <DetailField label="Finished at">{formatWhen(job.finished_at ?? job.created_at)}</DetailField>
          )}
          <DetailField label="Attempts">
            {job.attempts} of {job.max_attempts}
          </DetailField>
          {job.last_error && (
            <DetailField label="Last error">
              <span className="text-rose-500">{job.last_error}</span>
            </DetailField>
          )}
          <DetailField label="Delivery ID">
            <span className="font-mono text-[10px] text-slate-500 break-all">{job.id}</span>
          </DetailField>
        </dl>
      )}
    </Modal>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

type MessagesTab = 'recent' | 'scheduled';

export default function MessagesPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const [activeTab, setActiveTab] = useState<MessagesTab>(
    searchParams.get('tab') === 'reminders' ? 'scheduled' : 'recent',
  );
  const [detailsJob, setDetailsJob] = useState<MessageJobRow | null>(null);

  const handleTabChange = (tab: MessagesTab) => {
    setActiveTab(tab);
    // Same URL-sync convention as the Payments page (?tab=…), so a
    // refresh reopens the tab the user was on.
    const params = new URLSearchParams(searchParams);
    if (tab === 'scheduled') params.set('tab', 'reminders');
    else params.delete('tab');
    const qs = params.toString();
    navigate(`${pathname}${qs ? `?${qs}` : ''}`, { replace: true });
  };

  return (
    <ListPage
      header={
        <div>
          <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Messages</h1>
          <p className="text-[11px] text-slate-400 mt-1">Scheduled and sent WhatsApp messages</p>
        </div>
      }
    >
      {/* Tabs — the application's ONE segmented tab selector (the Payments
          page's exact visual language). */}
      <SegmentedTabs
        className="shrink-0"
        tabs={[
          { value: 'recent' as const, label: 'Recent Messages' },
          { value: 'scheduled' as const, label: 'Scheduled Reminders' },
        ]}
        value={activeTab}
        onChange={handleTabChange}
        aria-label="Messages views"
      />

      {/* ONLY the active tab renders (and therefore only its query runs):
          lazy Scheduled Reminders, cached tab switches. The active tab's
          rows viewport is the page's single scroll container. */}
      {activeTab === 'recent' ? (
        <RecentMessagesTab onOpenDetails={setDetailsJob} />
      ) : (
        <ScheduledRemindersTab />
      )}

      <MessageDetailDialog job={detailsJob} onClose={() => setDetailsJob(null)} />
    </ListPage>
  );
}
