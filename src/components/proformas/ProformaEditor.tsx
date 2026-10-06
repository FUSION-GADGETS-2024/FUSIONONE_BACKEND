'use client';

/**
 * The Proforma editor — ONE implementation shared by the New and Edit
 * pages (a proper sibling of the Sale editor). It reuses the app's shared
 * transaction-editor primitives (PartyCombobox, SectionCard/Field/
 * SummaryLine, MoneyInput, the shared StockSearchField picker) and quotes
 * REAL in-stock Inventory Items at quoted prices (the price snapshot the
 * proforma preserves). Proposed trade-ins stay free-text proposals — no
 * inventory identity is fabricated before the device is actually
 * received at conversion.
 *
 * Validation is inline (field errors + form-level business messages);
 * onSubmit fires only when the whole form is valid.
 */
import { useState, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Input } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Field, FormError, SectionCard, SummaryLine } from '@/components/ui/form';
import { Button } from '@/components/ui/Button';
import { PartyCombobox } from '@/components/parties/PartyCombobox';
import { StockSearchField } from '@/components/inventory/StockSearchField';
import type { InventorySearchRow } from '@/features/inventory/search';
import { parseMoney } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';
import { cn } from '@/components/ui/utils';
import { Plus, Trash2, RefreshCw, MapPin } from 'lucide-react';
import type { FinancialYear } from '@/features/types';

/** A quoted line under construction. Legacy free-text lines (edit mode)
 *  start unmapped and require an explicit device selection. */
export interface QuotedItemDraft {
  key: string;
  inventory_item_id: string | null;
  brand: string;
  model: string;
  imei: string;
  ram_rom: string;
  color: string;
  base_selling_price: string;
  rate: string;
  /** Legacy free-text line being re-quoted (edit mode only). */
  legacyDescription?: string;
}

/** A proposed trade-in line (free-text commercial proposal). */
export interface ProposedTradeInDraft {
  key: string;
  description: string;
  qty: string;
  rate: string;
}

export interface ProformaEditorSubmit {
  partyId: string;
  date: string;
  discount: number;
  items: Array<{ inventory_item_id: string; rate: number }>;
  tradeIns: Array<{ description: string; qty: number | null; rate: number }>;
}

export interface ProformaEditorProps {
  mode: 'create' | 'edit';
  fy: FinancialYear;
  isSaving: boolean;
  submitLabel: string;
  /** Controlled party selection — the parent owns it so the "+ New Party"
   *  modal flow can set the freshly created party. */
  partyId: string;
  onPartyChange: (partyId: string) => void;
  initial?: {
    date: string;
    discount: string;
    items: QuotedItemDraft[];
    tradeIns: ProposedTradeInDraft[];
  };
  onSubmit: (value: ProformaEditorSubmit) => void;
  onPartyModalOpen: () => void;
}

const tradeInAmount = (ti: ProposedTradeInDraft) =>
  (ti.qty.trim() === '' ? 1 : Number(ti.qty) || 0) * (Number(ti.rate) || 0);

export function ProformaEditor({
  mode,
  fy,
  isSaving,
  submitLabel,
  partyId,
  onPartyChange,
  initial,
  onSubmit,
  onPartyModalOpen,
}: ProformaEditorProps) {
  const [date, setDate] = useState(initial?.date ?? '');
  const [discount, setDiscount] = useState(initial?.discount ?? '');
  const [items, setItems] = useState<QuotedItemDraft[]>(initial?.items ?? []);
  const [tradeIns, setTradeIns] = useState<ProposedTradeInDraft[]>(initial?.tradeIns ?? []);

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Save → validate all + focus first invalid).
  const fieldErrors = useFieldErrors();

  // Default date, clamped into the financial year.
  useEffect(() => {
    if (date) return;
    const today = new Date().toISOString().split('T')[0];
    if (today < fy.start_date) setDate(fy.start_date);
    else if (today > fy.end_date) setDate(fy.end_date);
    else setDate(today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fy]);

  const queryClient = useQueryClient();

  // Stock search — the ONE canonical ranked search (StockSearchField),
  // debounced + server-side. No full-table fetch, no client-side filter.
  const refreshStock = () => {
    queryClient.invalidateQueries({ queryKey: ['inventory-search'] });
  };

  const subtotal = useMemo(
    () => items.reduce((acc, item) => acc + (Number(item.rate) || 0), 0),
    [items],
  );
  const totalTradeInCredit = useMemo(
    () => tradeIns.reduce((acc, ti) => acc + tradeInAmount(ti), 0),
    [tradeIns],
  );
  const finalTotal = useMemo(
    () => Math.max(0, subtotal - (Number(discount) || 0) - totalTradeInCredit),
    [subtotal, discount, totalTradeInCredit],
  );

  const addItem = (item: InventorySearchRow) => {
    setItems((prev) => [
      ...prev,
      {
        key: Math.random().toString(),
        inventory_item_id: item.id,
        brand: item.brand,
        model: item.model,
        imei: item.imei,
        ram_rom: item.ram_rom ?? '',
        color: item.color ?? '',
        base_selling_price: String(item.base_selling_price),
        rate: String(item.base_selling_price),
      },
    ]);
  };

  const updateItem = (key: string, patch: Partial<QuotedItemDraft>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const removeItem = (key: string) => setItems((prev) => prev.filter((i) => i.key !== key));

  const updateTradeIn = (key: string, field: keyof ProposedTradeInDraft, value: string) =>
    setTradeIns((prev) => prev.map((t) => (t.key === key ? { ...t, [field]: value } : t)));

  const unmappedLegacy = items.filter((i) => !i.inventory_item_id);

  // ── Validation (per field; the create/update RPCs stay authoritative) ──
  const errors = useMemo(() => {
    const validItems = items.filter((i) => i.inventory_item_id);
    return {
      customer: partyId ? null : 'Select a customer.',
      items: validItems.length === 0 ? 'Add at least one product before saving the quotation.' : null,
      legacy: unmappedLegacy.length > 0 ? 'Select the device being quoted for every line before saving.' : null,
      date: !date
        ? 'Date is required.'
        : (date < fy.start_date || date > fy.end_date)
          ? `Date must be within the financial year (${fy.start_date} to ${fy.end_date}).`
          : null,
      discount: discount.trim() !== '' && parseMoney(discount) === null
        ? 'Enter a valid discount amount.'
        : null,
      tradeIns: tradeIns.map(t => ({
        qty: t.qty.trim() !== '' && parseMoney(t.qty, { integer: true, min: 1 }) === null
          ? 'Enter a whole number of at least 1.'
          : null,
        rate: t.rate.trim() !== '' && parseMoney(t.rate) === null
          ? 'Enter a valid credit amount.'
          : null,
      })),
    };
  }, [partyId, items, unmappedLegacy.length, date, fy.start_date, fy.end_date, discount, tradeIns]);

  const hasErrors =
    !!errors.customer || !!errors.items || !!errors.legacy || !!errors.date || !!errors.discount
    || errors.tradeIns.some(t => t.qty || t.rate);

  const handleSaveClick = () => {
    // Validate the complete form: show every error inline, focus the first
    // invalid field — no validation toast.
    fieldErrors.beginSubmit();
    if (hasErrors) { focusFirstInvalid(); return; }

    const validItems = items.filter((i) => i.inventory_item_id);
    const validTradeIns = tradeIns.filter((t) => t.description.trim() !== '');
    onSubmit({
      partyId,
      date,
      discount: Number(discount) || 0,
      items: validItems.map((i) => ({ inventory_item_id: i.inventory_item_id!, rate: Number(i.rate) || 0 })),
      tradeIns: validTradeIns.map((t) => ({
        description: t.description.trim(),
        qty: t.qty.trim() === '' ? null : Number(t.qty),
        rate: Number(t.rate) || 0,
      })),
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
      <div className="min-w-0 space-y-5">
        {/* Transaction header */}
        <SectionCard>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Date" required error={fieldErrors.show('date', errors.date)}>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                onBlur={() => fieldErrors.touch('date')}
                min={fy.start_date}
                max={fy.end_date}
              />
            </Field>
            <Field label="Customer" required error={fieldErrors.show('customer', errors.customer)}>
              <PartyCombobox
                value={partyId}
                onChange={onPartyChange}
                onNew={onPartyModalOpen}
                placeholder="Search customer…"
              />
            </Field>
          </div>
        </SectionCard>

        {/* Quoted items — real stock, quoted price snapshot */}
        <SectionCard
          title="Quoted Items"
          action={
            <button
              onClick={refreshStock}
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
              fyId={fy.id}
              onSelect={addItem}
              excludeIds={items.filter((i) => i.inventory_item_id).map((i) => i.inventory_item_id!)}
              placeholder="Search available stock by IMEI, brand or model…"
            />
          </div>

          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.key}
                className={cn(
                  'p-2.5 border rounded-lg',
                  item.inventory_item_id
                    ? 'bg-slate-50 border-slate-200'
                    : 'bg-amber-50/60 border-amber-200',
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-slate-900 truncate">
                      {item.inventory_item_id ? (
                        <>
                          {item.brand} {item.model}
                        </>
                      ) : (
                        <span className="text-amber-800">
                          {item.legacyDescription ?? 'Unmapped legacy line'}
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono truncate">
                      {item.inventory_item_id
                        ? `${item.imei} • ${item.ram_rom} • ${item.color}`
                        : `Legacy quoted rate: ${Number(item.rate).toFixed(2)} Rs. — select the device below`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">Quoted Price</p>
                    <MoneyInput
                      value={item.rate}
                      onChange={(v) => updateItem(item.key, { rate: v })}
                      aria-label={`Quoted price for ${item.brand} ${item.model}`}
                      className="w-28 h-9 text-xs"
                    />
                  </div>
                  <button
                    onClick={() => removeItem(item.key)}
                    title="Remove item"
                    aria-label={`Remove ${item.brand} ${item.model}`}
                    className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors shrink-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {item.legacyDescription && item.inventory_item_id && (
                  <p className="text-[10px] text-amber-700 mt-1.5 flex items-center gap-1">
                    <MapPin className="h-3 w-3 shrink-0" />
                    Mapped from legacy line: “{item.legacyDescription}”
                  </p>
                )}
                {!item.inventory_item_id && (
                  <div className="mt-2">
                    <StockSearchField
                      fyId={fy.id}
                      onSelect={(row) =>
                        updateItem(item.key, {
                          inventory_item_id: row.id,
                          brand: row.brand,
                          model: row.model,
                          imei: row.imei,
                          ram_rom: row.ram_rom ?? '',
                          color: row.color ?? '',
                          base_selling_price: String(row.base_selling_price),
                        })
                      }
                      excludeIds={items.filter((i) => i.inventory_item_id).map((i) => i.inventory_item_id!)}
                      placeholder="Search stock to map this legacy line to the quoted device…"
                      aria-label={`Map legacy line ${item.legacyDescription ?? 'unmapped legacy line'}`}
                    />
                  </div>
                )}
              </div>
            ))}
            {items.length === 0 && (
              <div className="text-center py-5 text-xs text-slate-400 border-2 border-dashed border-slate-200 rounded-lg">
                No items quoted yet. Search above to add phones to this quotation.
              </div>
            )}
            {/* Form-level business rules — a quotation needs at least one
                product, and every legacy line needs its device selected. */}
            <FormError className="text-center">{fieldErrors.show('items', errors.items)}</FormError>
            <FormError className="text-center">{fieldErrors.show('legacy', errors.legacy)}</FormError>
          </div>
        </SectionCard>

        {/* Proposed trade-ins — free-text commercial proposals */}
        <SectionCard title="Trade-In Items" icon={<RefreshCw className="h-3.5 w-3.5 text-emerald-600" />}>
          <div className="space-y-2">
            {tradeIns.map((ti, tiIndex) => (
              <div key={ti.key} className="p-2.5 bg-emerald-50/30 border border-emerald-100 rounded-lg space-y-2">
                <Input
                  placeholder="Proposed exchange (e.g. iPhone 13 — good condition)"
                  value={ti.description}
                  onChange={(e) => updateTradeIn(ti.key, 'description', e.target.value)}
                  className="h-9 text-xs"
                />
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Qty" className="w-14" error={fieldErrors.show(`qty-${ti.key}`, errors.tradeIns[tiIndex]?.qty)}>
                    <MoneyInput
                      decimals={0}
                      value={ti.qty}
                      onBlur={() => fieldErrors.touch(`qty-${ti.key}`)}
                      onChange={(v) => updateTradeIn(ti.key, 'qty', v)}
                      className="h-9 text-xs px-2"
                      aria-label="Proposed trade-in quantity"
                    />
                  </Field>
                  <Field label="Est. Credit" className="flex-1 min-w-[100px]" error={fieldErrors.show(`rate-${ti.key}`, errors.tradeIns[tiIndex]?.rate)}>
                    <MoneyInput
                      placeholder="0.00"
                      value={ti.rate}
                      onBlur={() => fieldErrors.touch(`rate-${ti.key}`)}
                      onChange={(v) => updateTradeIn(ti.key, 'rate', v)}
                      className="h-9 text-xs"
                    />
                  </Field>
                  <div className="h-9 min-w-[100px] px-3 flex items-center justify-end rounded-md bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-800 tabular-nums shrink-0" aria-label="Proposed trade-in amount">
                    {tradeInAmount(ti).toFixed(2)}
                  </div>
                  <button
                    onClick={() => setTradeIns((prev) => prev.filter((t) => t.key !== ti.key))}
                    title="Remove proposed trade-in"
                    aria-label="Remove proposed trade-in"
                    className="h-9 w-9 flex items-center justify-center text-emerald-700/60 hover:text-rose-600 hover:bg-rose-50 border border-emerald-200 hover:border-rose-100 rounded-md transition-colors shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {tradeIns.length === 0 && (
              <div className="text-center py-4 text-xs text-slate-400 border-2 border-dashed border-slate-200 rounded-lg">
                No proposed trade-ins. Add one below if the quotation includes an exchange.
              </div>
            )}
          </div>

          <Button
            variant="outline"
            onClick={() =>
              setTradeIns((prev) => [
                ...prev,
                { key: Math.random().toString(), description: '', qty: '1', rate: '' },
              ])
            }
            className="mt-3 w-full border-dashed border-emerald-200 hover:border-emerald-400 hover:bg-emerald-50/30 text-emerald-700"
          >
            <Plus className="h-4 w-4" /> Add Proposed Trade-In
          </Button>
        </SectionCard>
      </div>

      {/* Totals sidebar — stable fixed track; the main column absorbs the
          viewport width */}
      <div className="min-w-0">
        <SectionCard title="Totals" className="sticky top-6">
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
              <label className="block text-xs font-medium text-slate-600">Discount</label>
              <MoneyInput placeholder="0.00" value={discount} onBlur={() => fieldErrors.touch('discount')} onChange={setDiscount} error={!!fieldErrors.show('discount', errors.discount)} />
              {fieldErrors.show('discount', errors.discount) && (
                <p role="alert" className="text-[10px] font-medium text-rose-600 leading-snug">{errors.discount}</p>
              )}
            </div>
            <SummaryLine
              label="Grand Total"
              value={`${finalTotal.toFixed(2)} Rs.`}
              className="pt-3 border-t border-slate-200"
              labelClassName="text-sm font-bold text-slate-900"
              valueClassName="text-lg font-bold text-indigo-700"
            />
          </div>

          <Button onClick={handleSaveClick} isLoading={isSaving} className="w-full mt-5 h-10 font-semibold">
            {submitLabel}
          </Button>
          {mode === 'edit' && (
            <p className="text-[10px] text-slate-400 text-center mt-2">
              Saving keeps the quotation number — this is a revision.
            </p>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
