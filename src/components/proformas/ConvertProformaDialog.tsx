'use client';

/**
 * The Proforma → Sale conversion dialog. Conversion is ONE atomic business
 * operation (the create_sale RPC in proforma mode): the commercial terms
 * (party, quoted items, quoted prices, discount) come from the DATABASE;
 * this dialog collects only the conversion-time decisions — the device
 * fulfilling each legacy free-text line, the ACTUAL trade-in devices
 * received, and the payment. No sessionStorage, no browser-side status
 * updates: the RPC links the sale to the proforma and marks it converted
 * in the same transaction.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/platform/supabase/client';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { ImeiInput } from '@/components/ui/ImeiInput';
import { RamRomInput } from '@/components/ui/RamRomInput';
import { Field, SummaryLine } from '@/components/ui/form';
import { Select } from '@/components/ui/Select';
import { cn } from '@/components/ui/utils';
import { ShoppingCart, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useBankAccounts, usePaymentModes } from '@/features/accounts/api';
import { StockSearchField } from '@/components/inventory/StockSearchField';
import type { InventorySearchRow } from '@/features/inventory/search';
import { validateTradeInDeviceFields, imeiProgress, type TradeInDeviceErrors } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';
import type { ProformaDetail } from '@/features/proformas/api';
import { convertProforma } from '@/features/sales/mutations';
import type { CreateTradeIn } from '@/features/sales/mutations';
import { invalidateSales, invalidateProformas, invalidateInventory } from '@/features/invalidate';
import { useWhatsAppMessageSettings } from '@/features/whatsapp/useWhatsAppMessageSettings';
import { postAutoSend } from '@/platform/whatsapp/http';

/** One quoted line's fulfillment. Inventory-backed lines are locked to
 *  their device; legacy free-text lines are mapped by the user via the
 *  shared stock picker (the picked row is kept for display only). */
interface Fulfillment {
  proformaItemId: string;
  inventoryItemId: string | null;
  device?: InventorySearchRow | null;
}

interface ActualTradeIn extends CreateTradeIn {}

export function ConvertProformaDialog({
  open,
  onClose,
  detail,
}: {
  open: boolean;
  onClose: () => void;
  detail: ProformaDetail;
}) {
  const navigate = useNavigate();
  const { error, success } = useToast();
  const { selectedYear } = useFinancialYear();
  const { settings: messageSettings } = useWhatsAppMessageSettings();
  const proforma = detail.proforma!;

  const bankQuery = useBankAccounts();
  const modeQuery = usePaymentModes();
  const bankAccounts = bankQuery.data ?? [];
  const paymentModes = modeQuery.data ?? [];

  // The quotation's own financial year (conversion must happen inside it
  // while it is still open — enforced by the RPC too).
  const fyQuery = useQuery({
    queryKey: ['fy-bounds', proforma.financial_year_id],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('financial_years')
        .select('start_date, end_date, status')
        .eq('id', proforma.financial_year_id)
        .single();
      if (error) throw error;
      return data as { start_date: string; end_date: string; status: string };
    },
  });
  const fyBounds = fyQuery.data ?? null;

  const [date, setDate] = useState(() => {
    const today = new Date().toISOString().split('T')[0];
    if (!fyBounds) return today;
    if (today < fyBounds.start_date) return fyBounds.start_date;
    if (today > fyBounds.end_date) return fyBounds.end_date;
    return today;
  });

  // Line fulfillments — inventory-backed lines pre-locked to their device.
  const [fulfillments, setFulfillments] = useState<Fulfillment[]>(() =>
    detail.items.map((item) => ({
      proformaItemId: item.id,
      inventoryItemId: item.inventory_item_id ?? null,
    })),
  );

  // ACTUAL trade-ins received at conversion — prefilled from the
  // PROPOSED trade-ins (credit = proposed rate); the user confirms the
  // real device details. A proposed trade-in is not a received device.
  const [tradeIns, setTradeIns] = useState<ActualTradeIn[]>(() =>
    detail.tradeIns.map((ti) => ({
      id: Math.random().toString(),
      brand: '',
      model: ti.description,
      imei: '',
      ram_rom: '',
      color: '',
      credit_value: String(Number(ti.rate) || 0),
      mrp: '',
    })),
  );

  const [paid, setPaid] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [paymentModeId, setPaymentModeId] = useState('');
  const [isConverting, setIsConverting] = useState(false);

  // Default bank selection applied DURING RENDER once accounts load (the
  // same pattern as the sale editor — first painted frame carries it).
  if (bankAccounts.length > 0 && !bankAccountId) {
    setBankAccountId(bankAccounts[0].id);
  }

  const unmappedLines = detail.items.filter(
    (item) => !item.inventory_item_id && !fulfillments.find((f) => f.proformaItemId === item.id)?.inventoryItemId,
  );
  const missingAvailability = detail.items.filter((item) => {
    if (!item.inventory_item_id) return false;
    const inv = item.inventory_items;
    return !inv || inv.status !== 'in_stock';
  });

  const subtotal = useMemo(
    () => detail.items.reduce((acc, item) => acc + (Number(item.value) || 0), 0),
    [detail.items],
  );
  const totalTradeInCredit = useMemo(
    () => tradeIns.reduce((acc, ti) => acc + (Number(ti.credit_value) || 0), 0),
    [tradeIns],
  );
  const discount = Number(proforma.discount) || 0;
  const finalTotal = Math.max(0, subtotal - discount - totalTradeInCredit);
  const nPaid = Number(paid) || 0;
  const due = Math.max(0, finalTotal - nPaid);

  const selectedBank = bankAccounts.find((b) => b.id === bankAccountId);
  const applicableModes = paymentModes.filter((m) => m.bank_account_id === bankAccountId);
  // A non-cash account with NO configured payment modes: the required mode
  // dropdown would otherwise have nothing to select — guide the user to add
  // one (the guidance is also the submit error, never "Select a payment
  // mode." with an empty list).
  const noModesAvailable = !!selectedBank && !selectedBank.is_cash && applicableModes.length === 0;

  const pickFulfillment = (proformaItemId: string, row: InventorySearchRow) =>
    setFulfillments((prev) =>
      prev.map((f) => (f.proformaItemId === proformaItemId ? { ...f, inventoryItemId: row.id, device: row } : f)),
    );

  const updateTradeIn = (id: string, patch: Partial<ActualTradeIn>) =>
    setTradeIns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Complete Sale → validate all + focus).
  const fieldErrors = useFieldErrors();
  // Per-trade-in field errors + duplicate-IMEI outcome (under each row's IMEI).
  const tradeInErrors = useMemo(
    () => tradeIns.map((ti) => validateTradeInDeviceFields(ti)),
    [tradeIns],
  );
  const duplicateImeiIds = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const ti of tradeIns) {
      const key = ti.imei.trim();
      if (!key) continue;
      if (seen.has(key)) dups.add(ti.id);
      else seen.add(key);
    }
    return dups;
  }, [tradeIns]);

  const handleConvert = async () => {
    if (!selectedYear) return;
    if (missingAvailability.length > 0) {
      error(
        'Quoted Device Unavailable',
        `${missingAvailability[0].inventory_items?.brand ?? 'A quoted device'} is no longer in stock. Edit or void this quotation.`,
      );
      return;
    }
    if (unmappedLines.length > 0) {
      error('Mapping Required', 'Select the device being sold for every quoted line before converting.');
      return;
    }
    // Trade-in devices: show every field's error inline, focus the first
    // invalid field — no validation toast.
    fieldErrors.beginSubmit();
    const tradeInInvalid = tradeInErrors.some((e) => Object.values(e).some(Boolean)) || duplicateImeiIds.size > 0;
    const paidInvalid = nPaid > finalTotal;
    const accountInvalid = nPaid > 0 && (!bankAccountId || (!selectedBank?.is_cash && !paymentModeId));
    if (tradeInInvalid || paidInvalid || accountInvalid) {
      focusFirstInvalid();
      return;
    }

    setIsConverting(true);
    try {
      const { saleId, billNumber } = await convertProforma({
        proformaId: proforma.id,
        date,
        items: fulfillments,
        tradeIns,
        paid: nPaid,
        bankAccountId,
        paymentModeId: paymentModeId || null,
      });

      success('Converted', `Sale ${billNumber} created from ${proforma.bill_number}.`);
      if (messageSettings.sale.autoSend) void postAutoSend({ invoiceId: saleId, invoiceType: 'sale' });

      await Promise.all([
        invalidateSales(selectedYear.id),
        invalidateProformas(selectedYear.id),
        invalidateInventory(selectedYear.id),
      ]);

      onClose();
      navigate(`/sales/${saleId}`);
    } catch (err: any) {
      // Deterministic domain errors from the RPC — surfaced, never swallowed.
      error('Conversion Failed', err.message || 'The quotation could not be converted.');
    } finally {
      setIsConverting(false);
    }
  };

  const f = (n: number) => `${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.`;

  if (!open) return null;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={`Convert ${proforma.bill_number} to Sale`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isConverting}>
            Cancel
          </Button>
          <Button onClick={handleConvert} isLoading={isConverting} disabled={fyQuery.isSuccess && fyQuery.data?.status !== 'active'}>
            <ShoppingCart className="h-3.5 w-3.5" /> Complete Sale
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {fyQuery.data?.status !== 'active' && fyQuery.isSuccess && (
          <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 text-rose-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-bold text-rose-800">This quotation's financial year is closed</p>
              <p className="text-[11px] text-rose-700 mt-0.5">
                Quotations can only be converted while their financial year is open. This one remains as history.
              </p>
            </div>
          </div>
        )}

        {missingAvailability.length > 0 && (
          <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2.5">
            <AlertTriangle className="h-4 w-4 text-rose-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-bold text-rose-800">A quoted device is no longer available</p>
              <p className="text-[11px] text-rose-700 mt-0.5">
                {missingAvailability
                  .map((i) => `${i.inventory_items?.brand ?? ''} ${i.inventory_items?.model ?? ''}`.trim())
                  .join(', ')}{' '}
                was sold or removed after this quotation. Edit or void the quotation to proceed.
              </p>
            </div>
          </div>
        )}

        {/* Quotation terms — locked (they come from the database) */}
        <div className="space-y-2.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Quotation terms (locked)
          </p>
          {detail.items.map((item) => {
            const fulfillment = fulfillments.find((f) => f.proformaItemId === item.id);
            const locked = !!item.inventory_item_id;
            const device = item.inventory_items;
            return (
              <div
                key={item.id}
                className={cn(
                  'p-2.5 border rounded-lg',
                  locked ? 'bg-slate-50 border-slate-200' : 'bg-amber-50/60 border-amber-200',
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    {locked ? (
                      <>
                        <p className="text-xs font-medium text-slate-900 truncate">
                          {device?.brand} {device?.model}
                        </p>
                        <p className="text-[11px] text-slate-400 font-mono truncate">
                          {device?.imei} • {device?.ram_rom} • {device?.color}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs font-medium text-amber-900 truncate">
                          {item.description}
                        </p>
                        <p className="text-[11px] text-amber-700">
                          Legacy line — select the device being sold
                        </p>
                      </>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold text-slate-900 tabular-nums">
                      {Number(item.value).toFixed(2)} Rs.
                    </p>
                    <p className="text-[10px] uppercase font-bold text-slate-400">Quoted</p>
                  </div>
                </div>
                {!locked && (
                  <div className="mt-2">
                    <StockSearchField
                      fyId={proforma.financial_year_id}
                      onSelect={(row) => pickFulfillment(item.id, row)}
                      excludeIds={[
                        ...detail.items.flatMap((i) => (i.inventory_item_id ? [i.inventory_item_id] : [])),
                        ...fulfillments
                          .filter((fm) => fm.proformaItemId !== item.id && fm.inventoryItemId)
                          .map((fm) => fm.inventoryItemId!),
                      ]}
                      placeholder="Search stock to select the device being sold…"
                      aria-label={`Select the device being sold for ${item.description ?? 'quoted line'}`}
                    />
                    {fulfillment?.inventoryItemId && (
                      <p className="text-[10px] text-emerald-700 mt-1.5">
                        Selling {fulfillment.device?.brand} {fulfillment.device?.model} at the quoted{' '}
                        {Number(item.value).toFixed(2)} Rs.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {discount > 0 && (
            <SummaryLine label="Quoted Discount" value={`- ${f(discount)}`} valueClassName="font-medium" />
          )}
        </div>

        {/* ACTUAL trade-ins received at conversion */}
        <div className="space-y-2.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Trade-ins received now
          </p>
          {tradeIns.map((ti, tiIndex) => {
            const tiErr: TradeInDeviceErrors = tradeInErrors[tiIndex] ?? validateTradeInDeviceFields(ti);
            const TE = (field: keyof TradeInDeviceErrors) =>
              fieldErrors.show(`${field}-${ti.id}`, tiErr[field]);
            const dup = duplicateImeiIds.has(ti.id);
            return (
            <div key={ti.id} className="p-2.5 bg-emerald-50/40 border border-emerald-100 rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                  Device {tiIndex + 1}
                </p>
                <button
                  onClick={() => setTradeIns((prev) => prev.filter((t) => t.id !== ti.id))}
                  className="p-1 text-emerald-700/60 hover:text-rose-600 transition-colors"
                  aria-label="Remove this trade-in"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <Field label="Brand" required error={TE('brand')}>
                  <Input
                    value={ti.brand}
                    onBlur={() => fieldErrors.touch(`brand-${ti.id}`)}
                    onChange={(e) => updateTradeIn(ti.id, { brand: e.target.value })}
                    placeholder="e.g. Samsung"
                    className="h-9 text-xs"
                  />
                </Field>
                <Field label="Model" required error={TE('model')}>
                  <Input
                    value={ti.model}
                    onBlur={() => fieldErrors.touch(`model-${ti.id}`)}
                    onChange={(e) => updateTradeIn(ti.id, { model: e.target.value })}
                    placeholder="e.g. Galaxy S21"
                    className="h-9 text-xs"
                  />
                </Field>
                <Field label="IMEI (15 digits)" required className="sm:col-span-2"
                  error={TE('imei') ?? (dup ? 'This IMEI is already in the list.' : null)}
                  hint={imeiProgress(ti.imei)}>
                  <ImeiInput
                    value={ti.imei}
                    onBlur={() => fieldErrors.touch(`imei-${ti.id}`)}
                    onChange={(v) => updateTradeIn(ti.id, { imei: v })}
                    placeholder="15 digit IMEI"
                    className="font-mono h-9 text-xs"
                  />
                </Field>
                <Field label="RAM / ROM" required error={TE('ram_rom')} hint="Example: 12/256">
                  <RamRomInput
                    value={ti.ram_rom}
                    onBlur={() => fieldErrors.touch(`ram_rom-${ti.id}`)}
                    onChange={(v) => updateTradeIn(ti.id, { ram_rom: v })}
                    placeholder="12/256"
                    className="h-9 text-xs"
                  />
                </Field>
                <Field label="Color" required error={TE('color')}>
                  <Input
                    value={ti.color}
                    onBlur={() => fieldErrors.touch(`color-${ti.id}`)}
                    onChange={(e) => updateTradeIn(ti.id, { color: e.target.value })}
                    placeholder="e.g. Phantom Gray"
                    className="h-9 text-xs"
                  />
                </Field>
                <Field label="Credit Value" required error={TE('credit_value')}>
                  <MoneyInput
                    value={ti.credit_value}
                    onBlur={() => fieldErrors.touch(`credit_value-${ti.id}`)}
                    onChange={(v) => updateTradeIn(ti.id, { credit_value: v })}
                    className="h-9 text-xs"
                  />
                </Field>
                <Field label="Original MRP" error={TE('mrp')}>
                  <MoneyInput
                    value={ti.mrp}
                    onBlur={() => fieldErrors.touch(`mrp-${ti.id}`)}
                    onChange={(v) => updateTradeIn(ti.id, { mrp: v })}
                    className="h-9 text-xs"
                  />
                </Field>
              </div>
            </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setTradeIns((prev) => [
                ...prev,
                {
                  id: Math.random().toString(),
                  brand: '',
                  model: '',
                  imei: '',
                  ram_rom: '',
                  color: '',
                  credit_value: '',
                  mrp: '',
                },
              ])
            }
            className="w-full border-dashed border-emerald-200 hover:border-emerald-400 text-emerald-700 h-8 text-xs"
          >
            <Plus className="h-3.5 w-3.5" /> Add Received Trade-In
          </Button>
        </div>

        {/* Payment + totals */}
        <div className="space-y-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
          <Field label="Sale Date" required>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={fyBounds?.start_date}
              max={fyBounds?.end_date}
              className="h-9 text-xs"
            />
          </Field>
          <SummaryLine label="Subtotal (quoted)" value={f(subtotal)} valueClassName="font-medium" />
          {discount > 0 && (
            <SummaryLine label="Discount (quoted)" value={`- ${f(discount)}`} valueClassName="font-medium" />
          )}
          {totalTradeInCredit > 0 && (
            <SummaryLine
              label="Trade-In (actual)"
              value={`- ${f(totalTradeInCredit)}`}
              labelClassName="text-emerald-700"
              valueClassName="font-medium text-emerald-700"
            />
          )}
          <SummaryLine
            label="Final Total"
            value={f(finalTotal)}
            className="pt-2.5 border-t border-slate-200"
            labelClassName="text-sm font-bold text-slate-900"
            valueClassName="text-lg font-bold text-indigo-700"
          />
          <Field label="Paid Now" error={fieldErrors.show('paid', nPaid > finalTotal ? 'Paid amount cannot be greater than the invoice total.' : null)}>
            <MoneyInput placeholder="0.00" value={paid} onBlur={() => fieldErrors.touch('paid')} onChange={setPaid} className="h-9 text-xs" />
          </Field>
          <Field label="Deposit Account" required error={fieldErrors.show('account', nPaid > 0 && !bankAccountId ? 'Select an account for the payment.' : null)}>
            <Select
              value={bankAccountId}
              onChange={(v) => {
                setBankAccountId(v);
                setPaymentModeId('');
              }}
              options={[
                { value: '', label: 'Select Account' },
                ...bankAccounts.map((b) => ({
                  value: b.id,
                  label: `${b.name}${b.is_cash ? ' (Cash)' : ''}`,
                })),
              ]}
            />
          </Field>
          {selectedBank && !selectedBank.is_cash && (
            <Field
              label="Payment Mode"
              required
              hint={noModesAvailable ? 'Add a payment mode to this account first.' : undefined}
              error={fieldErrors.show('mode', nPaid > 0 && !paymentModeId
                ? (noModesAvailable ? 'Add a payment mode to this account first.' : 'Select a payment mode.')
                : null)}
            >
              <Select
                value={paymentModeId}
                onChange={setPaymentModeId}
                options={[
                  { value: '', label: 'Select' },
                  ...applicableModes.map((m) => ({ value: m.id, label: m.name })),
                ]}
              />
            </Field>
          )}
          <SummaryLine
            label="Balance Due"
            value={f(due)}
            className="pt-2.5 border-t border-slate-200"
            labelClassName="font-bold text-slate-700"
            valueClassName={cn('text-base font-bold', due > 0 ? 'text-rose-600' : 'text-slate-400')}
          />
        </div>

        <p className="text-[10px] text-slate-400 leading-relaxed">
          Conversion is atomic: the sale is created from the quotation's stored terms, the quoted devices are
          sold at their quoted prices, and the quotation is marked converted — all in one transaction. A
          quotation can only ever produce one sale.
        </p>
      </div>
    </Modal>
  );
}
