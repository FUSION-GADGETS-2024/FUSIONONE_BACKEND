'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateSales, invalidateInventory, invalidateParties } from '@/features/invalidate';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { ImeiInput } from '@/components/ui/ImeiInput';
import { RamRomInput } from '@/components/ui/RamRomInput';
import { Field, FormError, SectionCard, SummaryLine } from '@/components/ui/form';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PartyCombobox } from '@/components/parties/PartyCombobox';
import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { PartyFormModal } from '@/components/parties/PartyFormModal';
import { Plus, Trash2, RefreshCw, Pencil } from 'lucide-react';
import { StockSearchField } from '@/components/inventory/StockSearchField';
import type { InventorySearchRow } from '@/features/inventory/search';
import { useBankAccounts, usePaymentModes } from '@/features/accounts/api';
import { createSale } from '@/features/sales/mutations';
import { validateTradeInDeviceFields, imeiProgress, type TradeInDeviceErrors } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';
import { useWhatsAppMessageSettings } from '@/features/whatsapp/useWhatsAppMessageSettings';
import { postAutoSend } from '@/platform/whatsapp/http';

interface SelectedSaleItem {
  id: string;
  brand: string;
  model: string;
  imei: string;
  ram_rom: string;
  color: string;
  sold_price: string;
  base_selling_price: string;
}

interface TradeInItem {
  id: string;
  brand: string;
  model: string;
  imei: string;
  ram_rom: string;
  color: string;
  credit_value: string;
  mrp: string;
}

export default function NewSalePage() {
  const navigate = useNavigate();
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const { error, success } = useToast();
  const queryClient = useQueryClient();
  const { settings: messageSettings } = useWhatsAppMessageSettings();

  const [isSaving, setIsSaving] = useState(false);

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Save → validate all + focus first invalid).
  const fieldErrors = useFieldErrors();
  const stockSearchRef = useRef<HTMLInputElement>(null);

  // Form Data
  const [date, setDate] = useState('');
  const [partyId, setPartyId] = useState('');
  const [discount, setDiscount] = useState('');
  const [selectedItems, setSelectedItems] = useState<SelectedSaleItem[]>([]);
  const [tradeIns, setTradeIns] = useState<TradeInItem[]>([]);

  const [bankAccountId, setBankAccountId] = useState('');
  const [paymentModeId, setPaymentModeId] = useState('');
  const [paid, setPaid] = useState('');

  // Dropdown data from the SHARED cached queries — the party directory is no
  // longer loaded up front: the customer combobox fetches its own first page
  // on open, so the form never waits for (or loads) the parties table.
  // Stock search is likewise server-side (the stock picker searches the
  // database per keystroke-pause — the in-stock table is never downloaded).
  const bankQuery = useBankAccounts();
  const modeQuery = usePaymentModes();
  const bankAccounts = bankQuery.data ?? [];
  const paymentModes = modeQuery.data ?? [];

  // Default selections applied DURING RENDER (not in a post-render effect) so
  // the first PAINTED frame of the already-loaded form already carries them —
  // the effects below keep their original role (re-defaulting when the
  // financial year changes) and simply re-apply the same values on mount.
  if (bankAccounts.length > 0 && !bankAccountId) {
    setBankAccountId(bankAccounts[0].id);
  }
  if (!date && !fyLoading && selectedYear) {
    const today = new Date().toISOString().split('T')[0];
    setDate(
      today < selectedYear.start_date ? selectedYear.start_date
      : today > selectedYear.end_date ? selectedYear.end_date
      : today,
    );
  }

  // Stock search — the ONE canonical ranked search (StockSearchField),
  // debounced + server-side. No full-table fetch, no client-side filter.

  // Modals
  const [isPartyModalOpen, setIsPartyModalOpen] = useState(false);
  const [isTradeInModalOpen, setIsTradeInModalOpen] = useState(false);

  const [tradeInForm, setTradeInForm] = useState<TradeInItem>({
    id: '', brand: '', model: '', imei: '', ram_rom: '', color: '', credit_value: '', mrp: ''
  });
  // Trade-in modal field errors (fresh cycle each time it opens) + the
  // duplicate-IMEI business check outcome (shown under the IMEI field).
  const tradeInFieldErrors = useFieldErrors<keyof TradeInDeviceErrors>();
  const [tradeInDup, setTradeInDup] = useState(false);

  // Set default date and bank account
  useEffect(() => {
    if (fyLoading || !selectedYear) return;
    if (isReadOnly) { error('Access Denied', 'Cannot create sale in a closed financial year.'); navigate('/home', { replace: true }); return; }
    const today = new Date().toISOString().split('T')[0];
    if (today < selectedYear.start_date) setDate(selectedYear.start_date);
    else if (today > selectedYear.end_date) setDate(selectedYear.end_date);
    else setDate(today);
  }, [selectedYear, fyLoading, isReadOnly, error, navigate]);

  const isLoading = fyLoading || bankQuery.isLoading || modeQuery.isLoading;
  // Loading threshold: skeleton geometry renders immediately, shimmer only
  // starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(isLoading);

  const fetchInStockItems = () => {
    queryClient.invalidateQueries({ queryKey: ['inventory-search'] });
  };

  const addSearchedItem = (item: InventorySearchRow) => {
    if (!selectedItems.find(i => i.id === item.id)) {
      setSelectedItems([
        ...selectedItems,
        {
          id: item.id,
          brand: item.brand,
          model: item.model,
          imei: item.imei,
          ram_rom: item.ram_rom ?? '',
          color: item.color ?? '',
          sold_price: String(item.base_selling_price),
          base_selling_price: String(item.base_selling_price),
        },
      ]);
    }
  };

  // Totals Calculation
  const subtotal = useMemo(() => {
    return selectedItems.reduce((acc, item) => acc + (Number(item.sold_price) || 0), 0);
  }, [selectedItems]);

  const totalTradeInCredit = useMemo(() => {
    return tradeIns.reduce((acc, ti) => acc + (Number(ti.credit_value) || 0), 0);
  }, [tradeIns]);

  const totalMrpGap = useMemo(() => {
    return tradeIns.reduce((acc, ti) => {
      const g = (Number(ti.mrp) || 0) - (Number(ti.credit_value) || 0);
      return acc + (g > 0 ? g : 0);
    }, 0);
  }, [tradeIns]);

  const finalTotal = useMemo(() => {
    return Math.max(0, subtotal - (Number(discount) || 0) - totalTradeInCredit);
  }, [subtotal, discount, totalTradeInCredit]);

  const due = useMemo(() => {
    return Math.max(0, finalTotal - (Number(paid) || 0));
  }, [finalTotal, paid]);

  // The selected account's payment modes (computed before the validation
  // memo so the empty-modes guidance is part of the same render truth).
  const selectedBank = bankAccounts.find(b => b.id === bankAccountId);
  const applicableModes = paymentModes.filter(m => m.bank_account_id === bankAccountId);
  // A non-cash account with NO configured payment modes: the required mode
  // dropdown would otherwise have nothing to select — guide the user to add
  // one (the guidance is also the submit error, never "Select a payment
  // mode." with an empty list).
  const noModesAvailable = !!selectedBank && !selectedBank.is_cash && applicableModes.length === 0;

  // Handlers
  const handleRemoveItem = (id: string) => {
    setSelectedItems(selectedItems.filter(i => i.id !== id));
  };

  const handleUpdateItemPrice = (id: string, price: string) => {
    setSelectedItems(selectedItems.map(i => i.id === id ? { ...i, sold_price: price } : i));
  };

  // ── Validation (per field, canonical rules; the create_sale RPC stays
  // the authoritative transaction-layer check) ──
  const errors = useMemo(() => {
    const nPaid = Number(paid) || 0;
    return {
      customer: partyId ? null : 'Select a customer.',
      date: !date
        ? 'Date is required.'
        : (selectedYear && (date < selectedYear.start_date || date > selectedYear.end_date))
          ? `Date must be within the financial year (${selectedYear.start_date} to ${selectedYear.end_date}).`
          : null,
      // A sale needs at least one product (₹0 totals are legitimate — a
      // full discount or trade-in credit can bring the payable to zero).
      items: selectedItems.length === 0 ? 'Add at least one product before saving the sale.' : null,
      paid: nPaid > finalTotal ? 'Paid amount cannot be greater than the invoice total.' : null,
      account: (() => {
        if (nPaid <= 0) return null;
        if (!bankAccountId) return 'Select an account for the payment.';
        const bk = bankAccounts.find(b => b.id === bankAccountId);
        if (!bk?.is_cash && !paymentModeId) {
          return applicableModes.length === 0 ? 'Add a payment mode to this account first.' : 'Select a payment mode.';
        }
        return null;
      })(),
    };
  }, [partyId, date, selectedYear, selectedItems.length, paid, finalTotal, bankAccountId, paymentModeId, bankAccounts, applicableModes.length]);

  const hasErrors = Object.values(errors).some(Boolean);

  const handleTradeInSave = () => {
    // The ONE shared trade-in device validator, per field — inline errors.
    const tiErrors = validateTradeInDeviceFields(tradeInForm);
    tradeInFieldErrors.beginSubmit();
    setTradeInDup(false);
    if (Object.values(tiErrors).some(Boolean)) { focusFirstInvalid(); return; }

    const tImei = tradeInForm.imei.trim();

    // Only check duplicates if it's a new item or if the IMEI changed
    const duplicate = tradeIns.find(t => t.imei === tImei && t.id !== tradeInForm.id);
    if (duplicate) {
      tradeInFieldErrors.touch('imei');
      setTradeInDup(true);
      return;
    }

    if (tradeInForm.id) {
      // Edit Mode
      setTradeIns(tradeIns.map(t => t.id === tradeInForm.id ? { ...tradeInForm, imei: tImei } : t));
    } else {
      // Add Mode
      setTradeIns([...tradeIns, { ...tradeInForm, id: Math.random().toString(), imei: tImei }]);
    }
    setIsTradeInModalOpen(false);
  };

  const handleRemoveTradeIn = (id: string) => {
    setTradeIns(tradeIns.filter(t => t.id !== id));
  };

  const handleSaveSale = async () => {
    if (!selectedYear) return;

    // Validate the complete form: show every error inline, focus the first
    // invalid field (the stock search when the empty product list is the
    // only problem — it has no field to mark invalid).
    fieldErrors.beginSubmit();
    if (hasErrors) {
      const fieldLevelError = errors.customer ?? errors.date ?? errors.paid ?? errors.account;
      if (fieldLevelError) focusFirstInvalid();
      else stockSearchRef.current?.focus();
      return;
    }

    const nPaid = Number(paid) || 0;

    setIsSaving(true);
    try {
      const { saleId, billNumber } = await createSale({
        partyId,
        date,
        selectedItems,
        tradeIns,
        discount: Number(discount) || 0,
        paid: nPaid,
        bankAccountId,
        paymentModeId,
        financialYear: selectedYear,
      });

      success('Success', `Sale ${billNumber} recorded!`);
      // Durable server-side auto-send: the backend creates + executes the
      // message job itself (browser-independent, restart-safe). Fire-and-
      // forget — the SSE job-result event reports the outcome.
      if (messageSettings.sale.autoSend) void postAutoSend({ invoiceId: saleId, invoiceType: 'sale' });

      // Centralized semantic invalidation.
      await Promise.all([
        invalidateSales(selectedYear.id),
        invalidateInventory(selectedYear.id),
      ]);

      // Successful save replaces the editor entry with the resulting
      // invoice — Back from the detail returns to where the editor was
      // entered from (Sales, …), never to the completed editor. A failed
      // save falls through to the catch below and stays on this page.
      navigate(`/sales/${saleId}`, { replace: true });

    } catch (err: unknown) {
      setIsSaving(false);
      error('Error', err instanceof Error ? err.message : 'Failed to save sale.');
    }
  };

  if (isLoading) {
    return (
      <div className={cn('space-y-5', skeletonPulsing && 'animate-pulse')}>
        <div className="flex items-center justify-between">
          <div className="space-y-1.5"><div className="h-4 w-28 bg-slate-100 rounded" /><div className="h-3 w-56 bg-slate-100 rounded" /></div>
          <div className="h-8 w-28 bg-slate-100 rounded-md" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
          <div className="min-w-0 space-y-5">
            <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="grid grid-cols-2 gap-4"><div className="space-y-1.5"><div className="h-3 w-10 bg-slate-100 rounded" /><div className="h-10 bg-slate-100 rounded-md" /></div><div className="space-y-1.5"><div className="h-3 w-20 bg-slate-100 rounded" /><div className="h-10 bg-slate-100 rounded-md" /></div></div></div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"><div className="h-4 w-36 bg-slate-100 rounded" /><div className="h-10 w-full bg-slate-100 rounded-md" /><div className="space-y-3">{[...Array(2)].map((_,i) => <div key={i} className="h-14 w-full bg-slate-50 border border-slate-100 rounded-lg" />)}</div></div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"><div className="h-4 w-32 bg-slate-100 rounded" /><div className="h-14 w-full bg-slate-50 rounded-lg" /></div>
          </div>
          <div className="min-w-0"><div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"><div className="h-4 w-28 bg-slate-100 rounded" /><div className="space-y-3">{[...Array(4)].map((_,i) => <div key={i} className="h-4 w-full bg-slate-100 rounded" />)}</div><div className="h-24 w-full bg-slate-100 rounded-lg mt-2" /><div className="h-10 w-full bg-slate-100 rounded-md mt-2" /></div></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="New Sale"
        subtitle="Record a sale, trade-ins, and generate invoice."
        backTo="/sales"
        backLabel="Back to Sales"
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
        <div className="min-w-0 space-y-5">

          {/* Transaction header — date + customer */}
          <SectionCard>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Date" required error={fieldErrors.show('date', errors.date)}>
                <Input type="date" value={date} onChange={e => setDate(e.target.value)} onBlur={() => fieldErrors.touch('date')} min={selectedYear?.start_date} max={selectedYear?.end_date} />
              </Field>
              <Field label="Customer" required error={fieldErrors.show('customer', errors.customer)}>
                <PartyCombobox
                  value={partyId}
                  onChange={v => setPartyId(v)}
                  onNew={() => setIsPartyModalOpen(true)}
                  placeholder="Search customer…"
                />
              </Field>
            </div>
          </SectionCard>

          {/* Sale items */}
          <SectionCard
            title="Sale Items"
            action={
              <button
                onClick={fetchInStockItems}
                title="Refresh stock"
                aria-label="Refresh stock"
                className="h-7 w-7 flex items-center justify-center rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            }
          >
            <div className="mb-4">
              <StockSearchField
                fyId={selectedYear?.id}
                onSelect={addSearchedItem}
                excludeIds={selectedItems.map(i => i.id)}
                placeholder="Search available stock by IMEI, brand or model…"
                inputRef={stockSearchRef}
              />
            </div>

            <div className="space-y-2">
              {selectedItems.map((item) => (
                <div key={item.id} className="flex items-center gap-3 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-slate-900 truncate">{item.brand} {item.model}</p>
                    <p className="text-[11px] text-slate-400 font-mono truncate">{item.imei} • {item.ram_rom} • {item.color}</p>
                  </div>
                  <MoneyInput
                    value={item.sold_price}
                    onChange={v => handleUpdateItemPrice(item.id, v)}
                    aria-label={`Sold price for ${item.brand} ${item.model}`}
                    className="w-28 h-9 text-xs shrink-0"
                  />
                  <button
                    onClick={() => handleRemoveItem(item.id)}
                    title="Remove item"
                    aria-label={`Remove ${item.brand} ${item.model}`}
                    className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {selectedItems.length === 0 && (
                <div className="text-center py-5 text-xs text-slate-400 border-2 border-dashed border-slate-200 rounded-lg">
                  No items selected yet. Search above to add phones to this sale.
                </div>
              )}
              {/* Form-level business rule: a sale needs at least one product
                  (shown after a submission attempt; ₹0 totals stay valid). */}
              <FormError className="text-center">{fieldErrors.show('items', errors.items)}</FormError>
            </div>
          </SectionCard>

          {/* Trade-ins */}
          <SectionCard
            title="Trade-Ins"
            icon={<RefreshCw className="h-3.5 w-3.5 text-emerald-600" />}
            action={
              <Button
                onClick={() => {
                  setTradeInForm({ id: '', brand: '', model: '', imei: '', ram_rom: '', color: '', credit_value: '', mrp: '' });
                  tradeInFieldErrors.reset();
                  setTradeInDup(false);
                  setIsTradeInModalOpen(true);
                }}
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
              >
                <Plus className="h-3 w-3" /> Add
              </Button>
            }
          >
            <div className="space-y-2">
              {tradeIns.map((ti) => (
                <div key={ti.id} className="flex items-center gap-3 p-2.5 border border-emerald-100 bg-emerald-50/50 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-emerald-900 truncate">{ti.brand || 'Exchange'} {ti.model}</p>
                    <p className="text-[11px] text-emerald-700/80 font-mono truncate">
                      {ti.imei ? ti.imei : <span className="text-rose-500 font-semibold not-italic">Missing IMEI / Details (Edit)</span>}
                      {ti.ram_rom ? ` • ${ti.ram_rom}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold text-emerald-700 tabular-nums">-{Number(ti.credit_value).toFixed(2)} Rs.</p>
                    <p className="text-[10px] uppercase font-bold text-emerald-600/70">Credit</p>
                  </div>
                  <button
                    onClick={() => {
                      setTradeInForm(ti);
                      tradeInFieldErrors.reset();
                      setTradeInDup(false);
                      setIsTradeInModalOpen(true);
                    }}
                    title="Edit trade-in"
                    aria-label="Edit trade-in"
                    className="p-1.5 text-emerald-700/50 hover:text-emerald-600 transition-colors shrink-0"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleRemoveTradeIn(ti.id)}
                    title="Remove trade-in"
                    aria-label="Remove trade-in"
                    className="p-1.5 text-emerald-700/50 hover:text-rose-600 transition-colors shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {tradeIns.length === 0 && (
                <div className="text-xs text-slate-400 italic">No trade-ins associated.</div>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Totals & Payment sidebar — stable fixed track; the main column
            absorbs the viewport width (the InvoiceViewLayout grid pattern) */}
        <div className="min-w-0">
          <SectionCard title="Payment & Totals" className="sticky top-6">
            <div className="space-y-3">
              <SummaryLine label="Subtotal" value={`${subtotal.toFixed(2)} Rs.`} valueClassName="font-medium" />
              {totalTradeInCredit > 0 && (
                <SummaryLine
                  label="Trade-In"
                  value={`- ${totalTradeInCredit.toFixed(2)} Rs.`}
                  labelClassName="text-emerald-700"
                  valueClassName="font-medium text-emerald-700"
                />
              )}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-600">Additional Discount</label>
                <MoneyInput placeholder="0.00" value={discount} onChange={setDiscount} />
              </div>
              {totalMrpGap > 0 && (
                <SummaryLine
                  label="★ Exchange Bonus Value"
                  value={`${totalMrpGap.toFixed(2)} Rs.`}
                  labelClassName="text-indigo-600"
                  valueClassName="font-medium text-indigo-600"
                />
              )}
              <SummaryLine
                label="Final Total"
                value={`${finalTotal.toFixed(2)} Rs.`}
                className="pt-3 border-t border-slate-200"
                labelClassName="text-sm font-bold text-slate-900"
                valueClassName="text-lg font-bold text-indigo-700"
              />
            </div>

            {/* Payment inputs — one soft inset panel, the editor's payment surface */}
            <div className="mt-4 space-y-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
              <Field label="Paid Now" error={fieldErrors.show('paid', errors.paid)}>
                <MoneyInput placeholder="0.00" value={paid} onBlur={() => fieldErrors.touch('paid')} onChange={setPaid} />
              </Field>
              <Field label="Deposit Account" required error={fieldErrors.show('account', errors.account)}>
                <Select
                  value={bankAccountId}
                  onChange={v => {
                    setBankAccountId(v);
                    setPaymentModeId('');
                  }}
                  options={[{ value: '', label: 'Select Account' }, ...bankAccounts.map(b => ({ value: b.id, label: `${b.name}${b.is_cash ? ' (Cash)' : ''}` }))]}
                />
              </Field>
              {selectedBank && !selectedBank.is_cash && (
                <Field
                  label="Payment Mode"
                  required
                  hint={noModesAvailable ? 'Add a payment mode to this account first.' : undefined}
                  error={fieldErrors.show('mode', errors.account)}
                >
                  <Select
                    value={paymentModeId}
                    onChange={v => setPaymentModeId(v)}
                    options={[{ value: '', label: 'Select' }, ...applicableModes.map(m => ({ value: m.id, label: m.name }))]}
                  />
                </Field>
              )}
            </div>

            <SummaryLine
              label="Balance Due"
              value={`${due.toFixed(2)} Rs.`}
              className="mt-4"
              labelClassName="font-bold text-slate-700"
              valueClassName={cn('text-lg font-bold', due > 0 ? 'text-rose-600' : 'text-slate-400')}
            />

            <Button onClick={handleSaveSale} isLoading={isSaving} className="w-full mt-4 h-10 font-semibold">
              Complete Sale
            </Button>
          </SectionCard>
        </div>
      </div>

      {/* Party Modal (the combobox "+ New Party" workflow) */}
      <PartyFormModal
        isOpen={isPartyModalOpen}
        onClose={() => setIsPartyModalOpen(false)}
        onSuccess={(party) => {
          void invalidateParties();
          setPartyId(party.id);
        }}
      />

      {/* Trade In Modal */}
      <Modal
        isOpen={isTradeInModalOpen}
        onClose={() => setIsTradeInModalOpen(false)}
        title={tradeInForm.id ? 'Edit Trade-In Device' : 'Add Trade-In Device'}
        hideClose
        footer={
          <>
            <Button variant="outline" onClick={() => setIsTradeInModalOpen(false)}>Cancel</Button>
            <Button onClick={handleTradeInSave}>{tradeInForm.id ? 'Save Trade-In' : 'Add Trade-In'}</Button>
          </>
        }
      >
        {(() => {
          // The ONE trade-in validator, per field — inline errors in the modal.
          const tiErrors = validateTradeInDeviceFields(tradeInForm);
          const TE = (field: keyof TradeInDeviceErrors) => tradeInFieldErrors.show(field, tiErrors[field]);
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Brand" required error={TE('brand')}>
                <Input value={tradeInForm.brand} onBlur={() => tradeInFieldErrors.touch('brand')} onChange={e => setTradeInForm({...tradeInForm, brand: e.target.value})} placeholder="e.g. Samsung" />
              </Field>
              <Field label="Model" required error={TE('model')}>
                <Input value={tradeInForm.model} onBlur={() => tradeInFieldErrors.touch('model')} onChange={e => setTradeInForm({...tradeInForm, model: e.target.value})} placeholder="e.g. Galaxy S21" />
              </Field>
              <Field label="IMEI (15 digits)" required className="sm:col-span-2"
                error={TE('imei') ?? (tradeInDup ? 'This IMEI is already in the list.' : null)}
                hint={imeiProgress(tradeInForm.imei)}>
                <ImeiInput value={tradeInForm.imei} onBlur={() => tradeInFieldErrors.touch('imei')}
                  onChange={v => { setTradeInForm({...tradeInForm, imei: v}); if (tradeInDup) setTradeInDup(false); }}
                  placeholder="15 digit IMEI" className="font-mono" />
              </Field>
              <Field label="RAM / ROM" required error={TE('ram_rom')} hint="Example: 12/256">
                <RamRomInput value={tradeInForm.ram_rom} onBlur={() => tradeInFieldErrors.touch('ram_rom')}
                  onChange={v => setTradeInForm({...tradeInForm, ram_rom: v})} placeholder="12/256" />
              </Field>
              <Field label="Color" required error={TE('color')}>
                <Input value={tradeInForm.color} onBlur={() => tradeInFieldErrors.touch('color')} onChange={e => setTradeInForm({...tradeInForm, color: e.target.value})} placeholder="e.g. Phantom Gray" />
              </Field>
              <Field label="Credit Value" required hint="Amount reduced from bill" error={TE('credit_value')}>
                <MoneyInput value={tradeInForm.credit_value} onBlur={() => tradeInFieldErrors.touch('credit_value')} onChange={v => setTradeInForm({...tradeInForm, credit_value: v})} placeholder="0.00" />
              </Field>
              <Field label="Original MRP" hint="For showing exchange bonus to customer" error={TE('mrp')}>
                <MoneyInput value={tradeInForm.mrp} onBlur={() => tradeInFieldErrors.touch('mrp')} onChange={v => setTradeInForm({...tradeInForm, mrp: v})} placeholder="0.00" />
              </Field>
            </div>
          );
        })()}
      </Modal>

    </div>
  );
}
