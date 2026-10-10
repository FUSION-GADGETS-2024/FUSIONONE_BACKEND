'use client';

import { useState } from 'react';
import { useStore } from '@/features/settings/api';
import { useSession } from '@/components/providers/SessionProvider';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import type { FinancialYear } from '@/features/types';
import { useToast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Check, Lock, Plus, ArrowRightLeft } from 'lucide-react';

import { DataTable, RowActions } from '@/components/ui/tables';
import type { DataTableColumn } from '@/components/ui/tables';
import { createFinancialYear, setActiveFinancialYear, closeFinancialYear } from '@/features/financial-year/mutations';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';

export default function FinancialYearPage() {
  const { financialYears, selectedYear, setSelectedYearId, isReadOnly, refresh } = useFinancialYear();

  const { error, success } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Close confirmation — the app's modal pattern (never native confirm()).
  // Presentation only: confirming runs the exact same close logic that ran
  // behind the old confirm(); Cancel leaves everything untouched.
  const [closeTarget, setCloseTarget] = useState<FinancialYear | null>(null);
  const { data: storeData } = useStore();
  const { isOwner } = useSession();
  const activeSystemYearId = storeData?.active_financial_year_id ?? null;
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Create → validate all + focus first invalid).
  const fieldErrors = useFieldErrors();

  const handleCreate = async () => {
    // Inline field errors — show every error, focus the first invalid field.
    fieldErrors.beginSubmit();
    if (!startDate || !endDate || new Date(startDate) >= new Date(endDate)) { focusFirstInvalid(); return; }
    setIsLoading(true);
    try {
      await createFinancialYear(startDate, endDate, financialYears);
      success('Success', 'Financial year created');
      setIsModalOpen(false); setStartDate(''); setEndDate('');
      fieldErrors.reset();
      await refresh();
    } catch (err: any) { error('Error', err.message); } finally { setIsLoading(false); }
  };

  const handleSetActive = async (fyId: string) => {
    if (!storeData?.id) return;
    setIsLoading(true);
    try {
      await setActiveFinancialYear(fyId, storeData.id);
      success('Success', 'Default year updated'); await refresh();
    } catch (err: any) { error('Error', err.message); } finally { setIsLoading(false); }
  };

  const handleSwitchTo = (fyId: string) => {
    setSelectedYearId(fyId);
    success('Switched', 'Working financial year changed');
  };

  const handleClose = (fy: FinancialYear) => {
    if (fy.status === 'closed') return;
    setCloseTarget(fy);
  };

  const handleConfirmClose = async () => {
    if (!closeTarget) return;
    setIsLoading(true);
    try {
      // One transactional RPC: close + next-FY find-or-create + stock
      // carry-forward (copy semantics) + idempotent opening balances.
      const result = await closeFinancialYear(closeTarget);
      success('Success', `Year closed. ${result.items_carried} items carried forward. ${result.accounts_carried} account balance(s) carried forward.`); await refresh();
      setCloseTarget(null);
    } catch (err: any) { error('Error', err.message); } finally { setIsLoading(false); }
  };

  function fyLabel(startDate: string, endDate: string) {
    const s = new Date(startDate).getFullYear();
    const e = new Date(endDate).getFullYear();
    return `FY ${s}–${e}`;
  }

  const columns: Array<DataTableColumn<FinancialYear>> = [
    {
      id: 'period',
      header: 'Period',
      mobile: 'identity',
      render: fy => {
        const isSelected = selectedYear?.id === fy.id;
        return (
          <span className="text-xs font-semibold text-slate-900 tabular-nums">
            {fy.start_date} → {fy.end_date}
            {isSelected && <span className="ml-2 text-[10px] font-bold text-indigo-600 uppercase">● Current</span>}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      mobile: 'meta',
      render: fy => fy.status === 'active'
        ? <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">Active</span>
        : <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200"><Lock className="h-2.5 w-2.5" />Closed</span>,
    },
    {
      id: 'default',
      header: 'Default',
      mobile: 'secondary',
      render: fy => {
        const isDefault = activeSystemYearId === fy.id;
        return isDefault
          ? <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><Check className="h-3.5 w-3.5" />Default</span>
          : isOwner
            ? <button onClick={() => handleSetActive(fy.id)} disabled={isLoading} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50 transition-colors">Set default</button>
            : <span className="text-[10px] text-slate-400">—</span>;
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      mobile: 'actions',
      render: fy => {
        const isSelected = selectedYear?.id === fy.id;
        return (
          <RowActions>
            <div className="flex items-center gap-2">
              {!isSelected && (
                <button onClick={() => handleSwitchTo(fy.id)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors">
                  Switch to
                </button>
              )}
              {fy.status === 'active' && (
                <button onClick={() => handleClose(fy)} disabled={isLoading} className="text-xs font-semibold text-rose-600 hover:text-rose-800 disabled:opacity-50 transition-colors">Close Year</button>
              )}
            </div>
          </RowActions>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Financial Years</h1>
          <p className="text-[11px] text-slate-400 mt-1">Manage financial periods, switch working year, and carry forward stock</p>
        </div>
        <Button size="sm" onClick={() => setIsModalOpen(true)} className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
          <Plus className="h-3.5 w-3.5" /> Create Year
        </Button>
      </div>

      {/* Current working year indicator */}
      {selectedYear && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-indigo-50 border border-indigo-100 rounded-lg">
          <ArrowRightLeft className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
          <span className="text-xs font-medium text-indigo-700">
            Working year: <span className="font-bold">{fyLabel(selectedYear.start_date, selectedYear.end_date)}</span>
          </span>
          {isReadOnly && (
            <span className="ml-2 flex items-center gap-1 bg-rose-50 text-rose-600 px-2 py-0.5 rounded-full text-[10px] font-bold border border-rose-100">
              <Lock className="h-2.5 w-2.5" /> Read Only
            </span>
          )}
        </div>
      )}

      {/* Data arrives synchronously from the provider — no loading skeleton
          and no toolbar on this list. */}
      <DataTable
        columns={columns}
        rows={financialYears}
        rowKey={fy => fy.id}
        emptyMessage="No financial years found."
        rowClassName={fy => (selectedYear?.id === fy.id ? 'bg-indigo-50/30' : undefined)}
      />

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Create Financial Year"
      hideClose
        footer={<><Button variant="outline" onClick={() => setIsModalOpen(false)}>Cancel</Button><Button onClick={handleCreate} isLoading={isLoading} disabled={!startDate || !endDate}>Create</Button></>}>
        <div className="space-y-3">
          <div className="space-y-1"><label className="text-xs font-medium text-slate-600">Start Date</label><Input type="date" value={startDate} onBlur={() => fieldErrors.touch('fyStart')} onChange={e => setStartDate(e.target.value)} error={!!fieldErrors.show('fyStart', startDate ? null : 'Start date is required.')} className="text-xs" />
          {fieldErrors.show('fyStart', startDate ? null : 'Start date is required.') && (
            <p role="alert" className="text-[10px] font-medium text-rose-600">Start date is required.</p>
          )}</div>
          <div className="space-y-1"><label className="text-xs font-medium text-slate-600">End Date</label><Input type="date" value={endDate} onBlur={() => fieldErrors.touch('fyEnd')} onChange={e => setEndDate(e.target.value)} error={!!fieldErrors.show('fyEnd', endDate && new Date(startDate) < new Date(endDate) ? null : 'End date must be after the start date.')} className="text-xs" />
          {fieldErrors.show('fyEnd', endDate && new Date(startDate) < new Date(endDate) ? null : 'End date must be after the start date.') && (
            <p role="alert" className="text-[10px] font-medium text-rose-600">End date must be after the start date.</p>
          )}</div>
        </div>
      </Modal>

      {/* Close confirmation — same facts the close RPC acts on (freeze,
          carry-forward, next-FY find-or-create, irreversibility), stated
          with values already in hand. No FY calculations are duplicated. */}
      <Modal
        isOpen={!!closeTarget}
        onClose={() => !isLoading && setCloseTarget(null)}
        hideClose
        title="Close Financial Year"
        footer={
          <>
            <Button variant="outline" onClick={() => setCloseTarget(null)} disabled={isLoading}>Cancel</Button>
            <Button variant="danger" onClick={handleConfirmClose} isLoading={isLoading}>Close Financial Year</Button>
          </>
        }
      >
        {closeTarget && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-900">
              Close FY {closeTarget.start_date} → {closeTarget.end_date}?
            </p>
            <ul className="space-y-1.5 text-xs text-slate-600">
              <li>All records in this financial year will become read-only.</li>
              <li>Unsold stock will carry forward to the next financial year.</li>
              <li>Account balances will carry forward as opening balances.</li>
              <li>A new financial year will be created if one doesn&apos;t already exist.</li>
            </ul>
            <p className="text-xs font-medium text-rose-600">This action cannot be reversed.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
