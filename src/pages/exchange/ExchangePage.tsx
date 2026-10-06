'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/platform/supabase/client';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { FileText, ExternalLink } from 'lucide-react';
import { Link } from 'react-router';

import { useSkeletonDelay } from '@/components/ui/Skeleton';
import {
  CellLines,
  DataTable,
  type DataTableColumn,
  ListHeaderSkeleton,
  TableSearchInput,
} from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { staticPagination } from '@/components/list-page/use-list-pagination';

const statusBadge = (status: string | undefined) => {
  if (status === 'in_stock') return <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">In Stock</span>;
  if (status === 'sold') return <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">Sold</span>;
  return <span className="text-slate-300 text-xs">—</span>;
};

export default function ExchangePage() {
  const { selectedYear, isLoading: fyLoading } = useFinancialYear();
  const [searchQuery, setSearchQuery] = useState('');

  const exchangeQuery = useQuery({
    queryKey: ['exchange-page', selectedYear?.id],
    enabled: !fyLoading && !!selectedYear,
    queryFn: async () => {
      if (!selectedYear) return [];

        // Device identity is resolved through the Inventory relationship
        // (the single authoritative source) — trade_ins holds only the
        // transactional facts.
        const { data, error: tErr } = await supabase.from('trade_ins').select('id, sale_id, inventory_item_id, credit_value, mrp, document_url, sales!inner (id, bill_number, financial_year_id), inventory_items (id, status, brand, model, imei, ram_rom, color)').eq('sales.financial_year_id', selectedYear.id).order('id', { ascending: false });
        if (tErr) throw tErr;
        return (data || []).map((t: any) => ({
          ...t,
          sales: Array.isArray(t.sales) ? t.sales[0] ?? null : t.sales,
        }));
    },
  });

  const tradeIns = exchangeQuery.data || [];

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(fyLoading || exchangeQuery.isLoading);

  const filtered = tradeIns.filter(t => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const inv = t.inventory_items ?? {};
    return (inv.brand?.toLowerCase() || '').includes(q) || (inv.model?.toLowerCase() || '').includes(q) || (inv.imei?.toLowerCase() || '').includes(q) || (t.sales?.bill_number?.toLowerCase() || '').includes(q);
  });

  const columns: DataTableColumn<any>[] = [
    {
      id: 'device',
      header: 'Device',
      render: t => <CellLines primary={`${t.inventory_items?.brand ?? '—'} ${t.inventory_items?.model ?? ''}`} secondary={[t.inventory_items?.ram_rom, t.inventory_items?.color].filter(Boolean).join(' · ')} />,
      mobile: 'identity',
      skeletonLines: 2,
    },
    {
      id: 'imei',
      header: 'IMEI',
      render: t => <span className="text-xs font-mono text-slate-500">{t.inventory_items?.imei}</span>,
      mobile: 'secondary',
    },
    {
      id: 'credit',
      header: 'Credit',
      align: 'right',
      cellClassName: 'text-right',
      render: t => <span className="text-xs font-semibold text-emerald-700 tabular-nums">{Number(t.credit_value).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>,
      mobile: 'amount',
      mobileLabel: 'Credit',
    },
    {
      id: 'mrp',
      header: 'MRP',
      align: 'right',
      cellClassName: 'text-right',
      render: t => <span className="text-xs text-slate-500 tabular-nums">{t.mrp ? `${Number(t.mrp).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.` : '—'}</span>,
      mobile: false,
    },
    {
      id: 'discount',
      header: 'Discount',
      align: 'right',
      cellClassName: 'text-right',
      render: t => {
        const disc = Number(t.mrp || 0) > Number(t.credit_value) ? Number(t.mrp) - Number(t.credit_value) : 0;
        return (
          <span className="text-xs font-medium tabular-nums">
            {disc > 0 ? <span className="text-rose-600">{disc.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span> : <span className="text-slate-300">—</span>}
          </span>
        );
      },
      mobile: 'amount',
      mobileLabel: 'Disc',
    },
    {
      id: 'linked-sale',
      header: 'Linked Sale',
      render: t => t.sales?.bill_number
        ? <Link to={`/sales/${t.sales.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800">{t.sales.bill_number}<ExternalLink className="h-3 w-3" /></Link>
        : <span className="text-slate-300 text-xs">—</span>,
      mobile: 'meta',
    },
    {
      id: 'doc',
      header: 'Doc',
      render: t => t.document_url
        ? <a href={t.document_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded-md transition-colors"><FileText className="h-3 w-3" />View</a>
        : <span className="text-slate-300 text-xs">—</span>,
      mobile: 'meta',
    },
    {
      id: 'status',
      header: 'Status',
      render: t => statusBadge(t.inventory_items?.status),
      mobile: 'meta',
    },
  ];

  const toolbar = <TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Brand, model, IMEI or bill no…" />;

  if (fyLoading || exchangeQuery.isLoading) {
    return (
      <ListPage header={<ListHeaderSkeleton pulsing={skeletonPulsing} titleWidth="w-20" subtitleWidth="w-60" actionWidth={null} />}>
        <DataTable columns={columns} rows={[]} rowKey={t => t.id} loading skeletonRows={5} fill toolbar={toolbar} emptyMessage="No trade-in transactions found." />
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div>
          <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Exchange</h1>
          <p className="text-[11px] text-slate-400 mt-1">All trade-in transactions for this FY</p>
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={t => t.id}
        toolbar={toolbar}
        emptyMessage="No trade-in transactions found."
        fill
        pagination={staticPagination(exchangeQuery)}
      />
    </ListPage>
  );
}
