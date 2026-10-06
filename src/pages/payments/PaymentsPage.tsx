'use client';

import { useState, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/platform/supabase/client';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useSearchParams, useNavigate, useLocation } from 'react-router';
import { Receipt } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { SegmentedTabs } from '@/components/ui/SegmentedTabs';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { DataTable, ListHeaderSkeleton, TableSearchInput } from '@/components/ui/tables';
import type { DataTableColumn } from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { staticPagination } from '@/components/list-page/use-list-pagination';
import { PartyCombobox } from '@/components/parties/PartyCombobox';
import { useToast } from '@/components/ui/Toast';
import { postSendReceipt } from '@/platform/whatsapp/http';
import { messageJobsKeys } from '@/features/messages/jobs';

/** Shared column geometry — identical widths on both tabs so switching never
 *  shifts column boundaries. The last column carries the Send Receipt action
 *  (wide enough for the full action label at the table's minimum width). */
const COLUMN_WIDTHS = ['w-[13%]', 'w-[22%]', 'w-[19%]', 'w-[15%]', 'w-[15%]', 'w-[16%]'] as const

function PaymentsContent() {
  const navigate = useNavigate(); const pathname = useLocation().pathname; const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<'in' | 'out'>(searchParams.get('tab') === 'out' ? 'out' : 'in');
  const { selectedYear, isLoading: fyLoading } = useFinancialYear();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPartyId, setSelectedPartyId] = useState('');
  const { success, error, toast } = useToast();
  const queryClient = useQueryClient();

  // The payment whose receipt is currently being sent (row-level loading
  // state; the backend's one-job-per-payment guard makes double-clicks
  // harmless).
  const [sendingReceiptId, setSendingReceiptId] = useState<string | null>(null);

  const handleTabChange = (tab: 'in' | 'out') => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    navigate(`${pathname}?${params.toString()}`, { replace: true });
  };

  const paymentsQuery = useQuery({
    queryKey: ['payments-page', selectedYear?.id],
    enabled: !fyLoading && !!selectedYear,
    queryFn: async () => {
      if (!selectedYear) return { paymentsIn: [], paymentsOut: [] };

        const [pinRes, poutRes] = await Promise.all([
          supabase.from('payments_in').select('id, amount, date, sale_id, parties (id, name), bank_accounts (name), payment_modes (name), sales (bill_number)').eq('financial_year_id', selectedYear.id).order('date', { ascending: false }),
          supabase.from('payments_out').select('id, amount, date, purchase_id, parties (id, name), bank_accounts (name), payment_modes (name), purchases (bill_number)').eq('financial_year_id', selectedYear.id).order('date', { ascending: false }),
        ]);
        if (pinRes.error) throw pinRes.error; if (poutRes.error) throw poutRes.error;
        return { paymentsIn: pinRes.data || [], paymentsOut: poutRes.data || [] };
    },
  });

  const { paymentsIn = [], paymentsOut = [] } = paymentsQuery.data || {}

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(fyLoading || paymentsQuery.isLoading)

  const filterFn = (list: any[], billKey: string) => list.filter(p => {
    if (selectedPartyId && p.parties?.id !== selectedPartyId) return false;
    if (searchQuery) { const q = searchQuery.toLowerCase(); const name = p.parties?.name?.toLowerCase() || ''; const bill = p[billKey]?.bill_number?.toLowerCase() || ''; if (!name.includes(q) && !bill.includes(q)) return false; }
    return true;
  });

  const filteredIn = filterFn(paymentsIn, 'sales');
  const filteredOut = filterFn(paymentsOut, 'purchases');

  const isIn = activeTab === 'in';
  const tabData = isIn ? filteredIn : filteredOut;

  // ── Send Receipt (manual only — never automatic after payment creation).
  // The backend resolves the authoritative payment data, renders the receipt
  // PDF, and sends it on WhatsApp; a send failure NEVER affects the
  // recorded payment itself.
  const handleSendReceipt = async (paymentId: string) => {
    if (sendingReceiptId) return;
    setSendingReceiptId(paymentId);
    try {
      const result = await postSendReceipt({ paymentId, direction: isIn ? 'in' : 'out' });
      if (result.success) {
        success('Receipt sent', 'The payment receipt was sent on WhatsApp.');
      } else if (result.status === 'pending') {
        toast({
          type: 'warning',
          title: 'Receipt retrying',
          message: 'WhatsApp is unavailable right now — the receipt will be retried automatically.',
        });
      } else if (result.status === 'processing') {
        toast({ type: 'info', title: 'Already sending', message: 'A receipt for this payment is already being delivered.' });
      } else {
        error('Receipt failed', result.error || 'The receipt could not be sent.');
      }
      await queryClient.invalidateQueries({ queryKey: messageJobsKeys.jobs(isIn ? 'payment_in' : 'payment_out', paymentId) });
    } catch (cause) {
      error('Receipt failed', cause instanceof Error ? cause.message : 'Unable to send the receipt.');
    } finally {
      setSendingReceiptId(null);
    }
  };

  // ── Toolbar — text search + party filter (server-searched picker, never
  //    the whole parties table in the client).
  const toolbar = (
    <>
      <TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search by party or bill number" />
      <PartyCombobox size="sm" allowClear value={selectedPartyId} onChange={v => setSelectedPartyId(v)} placeholder="All Parties" className="w-full sm:w-48" aria-label="Filter by party" />
    </>
  );

  // Skeleton reserve matching the Send Receipt button (single h-7 button).
  const actionReserve = <div className="h-7 w-24 bg-slate-100 rounded-md" />;

  const columns: Array<DataTableColumn<any>> = [
    {
      id: 'date',
      header: 'Date',
      width: COLUMN_WIDTHS[0],
      mobile: 'meta',
      render: p => <span className="text-xs leading-5 text-slate-500 tabular-nums whitespace-nowrap">{p.date}</span>,
    },
    {
      id: 'party',
      header: 'Party',
      width: COLUMN_WIDTHS[1],
      cellClassName: 'max-w-[220px]',
      mobile: 'identity',
      skeletonLines: 2,
      render: p => (
        <span className="block truncate text-xs leading-5 font-medium text-slate-900" title={p.parties?.name || undefined}>
          {p.parties?.name || '—'}
        </span>
      ),
    },
    {
      id: 'bill',
      header: isIn ? 'Sale Bill' : 'Purchase Bill',
      width: COLUMN_WIDTHS[2],
      mobile: 'secondary',
      render: p => (isIn ? p.sales?.bill_number : p.purchases?.bill_number) ? (
        <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border leading-4', isIn ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-indigo-50 text-indigo-700 border-indigo-200')}>
          {isIn ? p.sales.bill_number : p.purchases.bill_number}
        </span>
      ) : <span className="text-slate-300">—</span>,
    },
    {
      id: 'amount',
      header: isIn ? 'Received' : 'Paid',
      align: 'right',
      width: COLUMN_WIDTHS[3],
      cellClassName: 'text-right',
      mobile: 'amount',
      mobileLabel: isIn ? 'Received' : 'Paid',
      render: p => (
        <span className={cn('text-xs leading-5 font-semibold tabular-nums whitespace-nowrap', isIn ? 'text-emerald-700' : 'text-rose-600')}>
          {isIn ? '+' : '-'}{Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        </span>
      ),
    },
    {
      id: 'account',
      header: 'Account / Mode',
      width: COLUMN_WIDTHS[4],
      mobile: 'secondary',
      skeletonLines: 2,
      render: p => (
        <div className="min-w-0">
          <div className="text-xs leading-5 font-medium text-slate-700 truncate" title={p.bank_accounts?.name || undefined}>{p.bank_accounts?.name || '—'}</div>
          {/* Reserved mode line — every row keeps the same height on both
              tabs even when the mode is not set. */}
          <div className="text-[11px] leading-4 text-slate-400 truncate" title={p.payment_modes?.name || undefined}>{p.payment_modes?.name || '\u00A0'}</div>
        </div>
      ),
    },
    {
      id: 'receipt',
      align: 'center',
      width: COLUMN_WIDTHS[5],
      cellClassName: 'text-center',
      mobile: 'actions',
      render: p => (
        <button
          type="button"
          onClick={() => handleSendReceipt(p.id)}
          disabled={sendingReceiptId !== null}
          title="Send this payment's receipt on WhatsApp"
          aria-label={`Send receipt for ${p.parties?.name ?? 'payment'}`}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-slate-300 bg-white text-[10px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sendingReceiptId === p.id
            ? <span className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-slate-500 border-t-transparent animate-spin" aria-hidden />
            : <Receipt className="h-3 w-3 shrink-0" aria-hidden />}
          Send Receipt
        </button>
      ),
    },
  ];

  if (fyLoading || paymentsQuery.isLoading) {
    return (
      <ListPage
        header={<ListHeaderSkeleton subtitleWidth="w-60" actionWidth={null} pulsing={skeletonPulsing} />}
      >
        {/* SegmentedTabs row skeleton */}
        <div className={cn('shrink-0', skeletonPulsing && 'animate-pulse')}>
          <div className="h-8 w-56 bg-slate-100 rounded-lg" />
        </div>
        <DataTable
          columns={columns}
          rows={[]}
          rowKey={p => p.id}
          loading
          skeletonRows={6}
          fixed
          minWidth="min-w-[880px]"
          toolbar={toolbar}
          actionReserve={actionReserve}
          fill
        />
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div>
          <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Payments</h1>
          <p className="text-[11px] text-slate-400 mt-1">Received and made payments for this FY</p>
        </div>
      }
    >
      {/* Payments In / Out — the application's ONE segmented tab selector
          (the shared primitive, same visual language used by Settings). */}
      <SegmentedTabs
        className="shrink-0"
        tabs={[
          { value: 'in' as const, label: 'Payments In' },
          { value: 'out' as const, label: 'Payments Out' },
        ]}
        value={activeTab}
        onChange={handleTabChange}
        aria-label="Payment direction"
      />

      {/* fixed + shared column widths: the Payments In and Payments Out tabs
          render with identical geometry (auto layout resized every column per
          tab data, shifting the list on each switch). */}
      <DataTable
        columns={columns}
        rows={tabData}
        rowKey={p => p.id}
        fixed
        minWidth="min-w-[880px]"
        toolbar={toolbar}
        emptyMessage={`No ${activeTab === 'in' ? 'received' : 'made'} payments found.`}
        actionReserve={actionReserve}
        fill
        pagination={staticPagination(paymentsQuery)}
      />
    </ListPage>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={
      <div className="space-y-5 animate-pulse">
        <div className="space-y-1.5"><div className="h-4 w-20 bg-slate-100 rounded" /><div className="h-3 w-52 bg-slate-100 rounded" /></div>
        <div className="h-8 w-56 bg-slate-100 rounded-lg" />
        <div className="bg-white rounded-xl border border-slate-200 h-80" />
      </div>
    }>
      <PaymentsContent />
    </Suspense>
  );
}
