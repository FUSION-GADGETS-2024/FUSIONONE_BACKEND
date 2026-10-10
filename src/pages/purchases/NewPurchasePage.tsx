'use client';

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { invalidatePurchases, invalidateInventory, invalidateParties } from '@/features/invalidate';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { ImeiInput } from '@/components/ui/ImeiInput';
import { RamRomInput } from '@/components/ui/RamRomInput';
import { Field, SectionCard, SummaryLine } from '@/components/ui/form';
import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { PartyFormModal } from '@/components/parties/PartyFormModal';
import { PartyCombobox } from '@/components/parties/PartyCombobox';
import { PageHeader } from '@/components/PageHeader';
import { Plus, Trash2 } from 'lucide-react';
import { useBankAccounts, usePaymentModes } from '@/features/accounts/api';
import { createPurchase } from '@/features/purchases/mutations';
import { imeiProgress } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';
import { validateInventoryForm, isInventoryFormValid, type InventoryFormErrors } from '@/features/inventory/api';
import { useWhatsAppMessageSettings } from '@/features/whatsapp/useWhatsAppMessageSettings';
import { postAutoSend } from '@/platform/whatsapp/http';

interface PhoneItem {
  id: string; // temp id for UI list
  brand: string;
  model: string;
  imei: string;
  ram_rom: string;
  color: string;
  purchase_price: string;
  base_selling_price: string;
}

const emptyItem = (): PhoneItem => ({
  id: Math.random().toString(),
  brand: '', model: '', imei: '', ram_rom: '', color: '', purchase_price: '', base_selling_price: '',
});

export default function NewPurchasePage() {
  const navigate = useNavigate();
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const { error, success } = useToast();
  const { settings: messageSettings } = useWhatsAppMessageSettings();

  const bankQuery = useBankAccounts();
  const modeQuery = usePaymentModes();
  const bankAccounts = bankQuery.data ?? [];
  const paymentModes = modeQuery.data ?? [];

  const isLoading = fyLoading || bankQuery.isLoading || modeQuery.isLoading;
  // Loading threshold: skeleton geometry renders immediately, shimmer only
  // starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(isLoading);

  const [isSaving, setIsSaving] = useState(false);

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Save → validate all + focus first invalid).
  const fieldErrors = useFieldErrors();

  const [date, setDate] = useState('');
  const [partyId, setPartyId] = useState('');
  const [items, setItems] = useState<PhoneItem[]>([emptyItem()]);
  const [bankAccountId, setBankAccountId] = useState('');
  const [paymentModeId, setPaymentModeId] = useState('');
  const [paid, setPaid] = useState('');

  // Party Modal
  const [isPartyModalOpen, setIsPartyModalOpen] = useState(false);

  useEffect(() => {
    if (fyLoading || !selectedYear) return;
    if (isReadOnly) { error('Access Denied', 'Cannot create purchase in a closed financial year.'); navigate('/purchases', { replace: true }); return; }
    const today = new Date().toISOString().split('T')[0];
    if (today < selectedYear.start_date) setDate(selectedYear.start_date);
    else if (today > selectedYear.end_date) setDate(selectedYear.end_date);
    else setDate(today);
  }, [selectedYear, fyLoading, isReadOnly, error, navigate]);

  const total = useMemo(() => {
    return items.reduce((sum, item) => sum + (Number(item.purchase_price) || 0), 0);
  }, [items]);

  const due = useMemo(() => {
    return Math.max(0, total - (Number(paid) || 0));
  }, [total, paid]);

  // The selected account's payment modes (computed before the validation
  // memo so the empty-modes guidance is part of the same render truth).
  const selectedBank = bankAccounts.find(b => b.id === bankAccountId);
  const applicableModes = paymentModes.filter(m => m.bank_account_id === bankAccountId);
  // A non-cash account with NO configured payment modes: the required mode
  // dropdown would otherwise have nothing to select — guide the user to add
  // one (the guidance is also the submit error, never "Select a payment
  // mode." with an empty list).
  const noModesAvailable = !!selectedBank && !selectedBank.is_cash && applicableModes.length === 0;

  const handleAddItem = () => {
    setItems([...items, emptyItem()]);
  };

  const handleRemoveItem = (id: string) => {
    if (items.length === 1) return;
    setItems(items.filter(item => item.id !== id));
  };

  const handleItemChange = (id: string, field: keyof PhoneItem, value: string) => {
    setItems(items.map(item => item.id === id ? { ...item, [field]: value } : item));
  };

  // ── Validation (per field, computed each render; canonical validators) ──
  // A phone row has exactly the inventory form's field set — the ONE
  // shared per-field validator (canonical IMEI/RAM-ROM/money contracts).
  const rowErrors = useMemo(() => {
    const map = new Map<string, InventoryFormErrors & { duplicate: string | null }>();
    const seen = new Map<string, number>();
    items.forEach((item, index) => {
      const base = validateInventoryForm(item);
      const trimmed = item.imei.trim();
      const firstIndex = seen.get(trimmed);
      const duplicate = trimmed && firstIndex !== undefined && firstIndex !== index
        ? 'This IMEI is already in the list.'
        : null;
      if (trimmed && firstIndex === undefined) seen.set(trimmed, index);
      map.set(item.id, { ...base, duplicate });
    });
    return map;
  }, [items]);

  const headerErrors = useMemo(() => ({
    date: !date
      ? 'Date is required.'
      : (selectedYear && (date < selectedYear.start_date || date > selectedYear.end_date))
        ? `Date must be within the financial year (${selectedYear.start_date} to ${selectedYear.end_date}).`
        : null,
    party: partyId ? null : 'Select a supplier.',
    paid: (() => {
      const nPaid = Number(paid) || 0;
      if (nPaid < 0) return 'Paid amount cannot be negative.';
      if (nPaid > total) return 'Paid amount cannot be greater than the invoice total.';
      return null;
    })(),
    account: (() => {
      const nPaid = Number(paid) || 0;
      if (nPaid <= 0) return null;
      if (!bankAccountId) return 'Select an account for the payment.';
      const bk = bankAccounts.find(b => b.id === bankAccountId);
      if (!bk?.is_cash && !paymentModeId) {
        return applicableModes.length === 0 ? 'Add a payment mode to this account first.' : 'Select a payment mode.';
      }
      return null;
    })(),
  }), [date, partyId, paid, total, bankAccountId, paymentModeId, bankAccounts, selectedYear, applicableModes.length]);

  const hasErrors =
    Object.values(headerErrors).some(Boolean) ||
    [...rowErrors.values()].some(e => !isInventoryFormValid(e) || e.duplicate);

  const handleSave = async () => {
    if (!selectedYear) return;

    // Validate the complete form; show every field's error inline and focus
    // the first invalid field — no validation toast.
    fieldErrors.beginSubmit();
    if (hasErrors) { focusFirstInvalid(); return; }

    const nPaid = Number(paid) || 0;

    setIsSaving(true);
    try {
        const { purchaseId, billNumber } = await createPurchase({
          partyId,
          date,
          items,
          total,
          paid: nPaid,
          due,
          bankAccountId: bankAccountId || bankAccounts[0].id,
          paymentModeId,
          financialYear: selectedYear,
        });

        success('Success', `Purchase ${billNumber} created!`);
        // Durable server-side auto-send (backend-owned job; SSE reports the outcome).
        if (messageSettings.purchase.autoSend) void postAutoSend({ invoiceId: purchaseId, invoiceType: 'purchase' });
        await Promise.all([
          invalidatePurchases(selectedYear.id),
          invalidateInventory(selectedYear.id),
        ]);

        // Successful save replaces the editor entry with the resulting
        // bill — Back from the detail returns to where the editor was
        // entered from (Purchases, …), never to the completed editor.
        navigate(`/purchases/${purchaseId}`, { replace: true });

    } catch (err: unknown) {
        setIsSaving(false);
        error('Error', err instanceof Error ? err.message : 'Failed to save purchase.');
    }
  };

  if (isLoading) {
    return (
      <div className={cn('space-y-5', skeletonPulsing && 'animate-pulse')}>
        <div className="flex items-center justify-between">
          <div className="space-y-1.5"><div className="h-4 w-32 bg-slate-100 rounded" /><div className="h-3 w-60 bg-slate-100 rounded" /></div>
          <div className="h-8 w-28 bg-slate-100 rounded-md" />
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="h-4 w-24 bg-slate-100 rounded mb-4" />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5"><div className="h-3 w-10 bg-slate-100 rounded" /><div className="h-10 bg-slate-100 rounded-md" /></div>
            <div className="space-y-1.5"><div className="h-3 w-20 bg-slate-100 rounded" /><div className="h-10 bg-slate-100 rounded-md" /></div>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-5">
          <div className="h-4 w-28 bg-slate-100 rounded" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="space-y-1.5"><div className="h-3 w-14 bg-slate-100 rounded" /><div className="h-10 bg-slate-100 rounded-md" /></div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
          <div className="h-4 w-32 bg-slate-100 rounded mb-2" />
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-3"><div className="h-10 w-36 bg-slate-100 rounded-md" /></div>
            <div className="h-28 rounded-lg bg-slate-50 border border-slate-100" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="New Purchase"
        subtitle="Add phones to inventory via purchase bill."
        backTo="/purchases"
        backLabel="Back to Purchases"
      />

      <div className="space-y-5">
        {/* Bill header */}
        <SectionCard title="Bill Details">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Date" required error={fieldErrors.show('date', headerErrors.date)}>
              <Input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                onBlur={() => fieldErrors.touch('date')}
                min={selectedYear?.start_date}
                max={selectedYear?.end_date}
              />
            </Field>
            <Field label="Supplier" required error={fieldErrors.show('party', headerErrors.party)}>
              <PartyCombobox
                value={partyId}
                onChange={v => setPartyId(v)}
                onNew={() => setIsPartyModalOpen(true)}
                placeholder="Search supplier…"
              />
            </Field>
          </div>
        </SectionCard>

        {/* Items — ONE section, blocks separated by quiet dividers. Row
            fields validate inline (same contracts as the inventory form). */}
        <SectionCard title="Phones Received">
          <div className="divide-y divide-slate-100">
            {items.map((item, index) => {
              const err = rowErrors.get(item.id)!;
              const E = (field: keyof InventoryFormErrors | 'duplicate') =>
                fieldErrors.show(`${field}-${item.id}`, err[field]);
              return (
              <div key={item.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-bold flex items-center justify-center">{index + 1}</span>
                  <span className="text-xs font-medium text-slate-700 truncate">
                    {item.brand.trim() ? `${item.brand} ${item.model}`.trim() : `Phone ${index + 1}`}
                  </span>
                  {items.length > 1 && (
                    <button
                      onClick={() => handleRemoveItem(item.id)}
                      title="Remove this phone"
                      aria-label={`Remove phone ${index + 1}`}
                      className="ml-auto inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Field label="Brand" required error={E('brand')}>
                    <Input placeholder="Apple" value={item.brand} onBlur={() => fieldErrors.touch(`brand-${item.id}`)} onChange={e => handleItemChange(item.id, 'brand', e.target.value)} />
                  </Field>
                  <Field label="Model" required error={E('model')}>
                    <Input placeholder="iPhone 15" value={item.model} onBlur={() => fieldErrors.touch(`model-${item.id}`)} onChange={e => handleItemChange(item.id, 'model', e.target.value)} />
                  </Field>
                  <Field label="IMEI (15 digits)" required className="col-span-2"
                    error={E('imei') ?? E('duplicate')} hint={imeiProgress(item.imei)}>
                    <ImeiInput placeholder="123456789012345" value={item.imei} onBlur={() => fieldErrors.touch(`imei-${item.id}`)}
                      onChange={v => handleItemChange(item.id, 'imei', v)} className="font-mono" />
                  </Field>
                  <Field label="RAM / ROM" required error={E('ram_rom')} hint="Example: 12/256">
                    <RamRomInput placeholder="12/256" value={item.ram_rom} onBlur={() => fieldErrors.touch(`ram_rom-${item.id}`)}
                      onChange={v => handleItemChange(item.id, 'ram_rom', v)} />
                  </Field>
                  <Field label="Color" required error={E('color')}>
                    <Input placeholder="Black" value={item.color} onBlur={() => fieldErrors.touch(`color-${item.id}`)} onChange={e => handleItemChange(item.id, 'color', e.target.value)} />
                  </Field>
                  <Field label="Purchase Price" required error={E('purchase_price')}>
                    <MoneyInput placeholder="0.00" value={item.purchase_price} onBlur={() => fieldErrors.touch(`purchase_price-${item.id}`)} onChange={v => handleItemChange(item.id, 'purchase_price', v)} />
                  </Field>
                  <Field label="Selling Price / MRP" required error={E('base_selling_price')}>
                    <MoneyInput placeholder="0.00" value={item.base_selling_price} onBlur={() => fieldErrors.touch(`base_selling_price-${item.id}`)} onChange={v => handleItemChange(item.id, 'base_selling_price', v)} />
                  </Field>
                </div>
              </div>
              );
            })}
          </div>

          <Button variant="outline" onClick={handleAddItem} className="mt-4 w-full border-dashed text-indigo-600 bg-indigo-50/30 hover:bg-indigo-50">
            <Plus className="h-4 w-4" /> Add Another Phone
          </Button>
        </SectionCard>

        {/* Payment & Summary — the same field system and totals rhythm as the
            sale editor's sidebar, laid out for this full-width page */}
        <SectionCard title="Payment & Summary">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Payment details */}
            <div className="space-y-3">
              <Field label="Paid Now" className="max-w-[220px]" error={fieldErrors.show('paid', headerErrors.paid)}>
                <MoneyInput placeholder="0.00" value={paid} onBlur={() => fieldErrors.touch('paid')} onChange={setPaid} />
              </Field>
              {Number(paid) > 0 && (
                <div className="space-y-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <Field label="From Account" required error={fieldErrors.show('account', headerErrors.account)}>
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
                      error={fieldErrors.show('mode', headerErrors.account)}
                    >
                      <Select
                        value={paymentModeId}
                        onChange={v => setPaymentModeId(v)}
                        options={[{ value: '', label: 'Select' }, ...applicableModes.map(m => ({ value: m.id, label: m.name }))]}
                      />
                    </Field>
                  )}
                </div>
              )}
            </div>

            {/* Totals — the soft inset panel (the sale sidebar's surface) */}
            <div className="space-y-3 rounded-lg border border-slate-100 bg-slate-50 p-3 md:self-start">
              <SummaryLine label="Items" value={items.length} valueClassName="font-medium" />
              <SummaryLine label="Paid" value={`- ${(Number(paid) || 0).toFixed(2)} Rs.`} labelClassName="text-emerald-700" valueClassName="font-medium text-emerald-700" />
              <SummaryLine
                label="Total"
                value={`${total.toFixed(2)} Rs.`}
                className="pt-2.5 border-t border-slate-200"
                labelClassName="text-sm font-bold text-slate-900"
                valueClassName="text-lg font-bold"
              />
              <SummaryLine
                label="Balance Due"
                value={`${due.toFixed(2)} Rs.`}
                labelClassName="font-bold text-slate-700"
                valueClassName={cn('text-lg font-bold', due > 0 ? 'text-rose-600' : 'text-slate-400')}
              />
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex justify-end gap-3">
            <Button variant="outline" onClick={() => navigate('/purchases')} disabled={isSaving}>Cancel</Button>
            <Button onClick={handleSave} isLoading={isSaving} className="min-w-[140px] font-semibold">Save Purchase</Button>
          </div>
        </SectionCard>
      </div>

      <PartyFormModal
        isOpen={isPartyModalOpen}
        onClose={() => setIsPartyModalOpen(false)}
        onSuccess={(party) => {
          void invalidateParties();
          setPartyId(party.id);
        }}
      />
    </div>
  );
}
