'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useSaleDetail } from '@/features/sales/api';
import type { SaleDetail, SaleTradeIn } from '@/features/sales/api';
import { updateSale } from '@/features/sales/mutations';
import { parseMoney } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';
import { invalidateSales } from '@/features/invalidate';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Field, SectionCard, SummaryLine } from '@/components/ui/form';
import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/PageHeader';
import {
  AlertTriangle,
  Info,
  Lock,
  RefreshCw,
  Save,
} from 'lucide-react';

interface SaleItem {
  sale_item_id: string;
  inventory_item_id: string;
  brand: string;
  model: string;
  imei: string;
  ram_rom: string;
  color: string;
  base_selling_price: number;
  sold_price: string; // editable
}

interface TradeInDisplay {
  id: string;
  credit_value: number;
  inventory_items?: SaleTradeIn['inventory_items'];
}

/** Map the shared sale-detail rows to the page's editable item rows. */
function toEditableItems(items: SaleDetail['items']): SaleItem[] {
  return items.map((row) => ({
    sale_item_id: row.id,
    inventory_item_id: row.inventory_item_id,
    brand: row.inventory_items?.brand || '',
    model: row.inventory_items?.model || '',
    imei: row.inventory_items?.imei || '',
    ram_rom: row.inventory_items?.ram_rom || '',
    color: row.inventory_items?.color || '',
    base_selling_price: Number(row.inventory_items?.base_selling_price) || 0,
    sold_price: row.sold_price?.toString() || '0',
  }));
}

export default function EditSalePage() {
  const navigate = useNavigate();
  const { id } = useParams() as { id: string };
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const { error, success } = useToast();

  // --- The sale, through the ONE shared cached detail query (the same rows
  //     the invoice view / list actions just loaded). Arriving from the
  //     invoice view is therefore a synchronous cache hit — the form renders
  //     immediately, with no refetch and no skeleton flash. Only a genuine
  //     first load (direct URL / stale entry) fetches. ---
  const detailQuery = useSaleDetail(id);
  const detail = detailQuery.data;

  // --- Editable form state, initialized LAZILY from the cached query data
  //     so the FIRST painted frame already holds the correct values (no
  //     empty-form flash when the data is already in memory). ---
  const [originalSale, setOriginalSale] = useState<any>(() => detail?.sale ?? null);
  const [isSaving, setIsSaving] = useState(false);

  const [date, setDate] = useState(() => detail?.sale?.date ?? '');
  const [discount, setDiscount] = useState(() => detail?.sale?.discount?.toString() || '0');
  const [saleItems, setSaleItems] = useState<SaleItem[]>(() => toEditableItems(detail?.items ?? []));
  const [tradeIns, setTradeIns] = useState<TradeInDisplay[]>(() => detail?.tradeIns ?? []);
  // Loading threshold: skeleton geometry renders immediately, shimmer only
  // starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(detailQuery.isLoading || fyLoading);

  // Initialize the form EXACTLY ONCE per mount when the data arrives after
  // the first render (genuine first load). A later background refetch never
  // clobbers in-progress edits. The cancelled-sale guard keeps its original
  // behavior: redirect back to the invoice with an explanatory toast.
  const initializedRef = useRef(false);
  useEffect(() => {
    const data = detailQuery.data;
    if (!data?.sale || initializedRef.current) return;
    initializedRef.current = true;

    // Guard: cannot edit a cancelled sale (replace — the unusable editor
    // must not stay in history behind the redirect; same rule as the
    // proforma editor's guards).
    if (data.sale.status === 'cancelled') {
      error('Cannot Edit', 'This invoice has been cancelled and cannot be edited.');
      navigate(`/sales/${id}`, { replace: true });
      return;
    }

    setOriginalSale(data.sale);
    setDate(data.sale.date);
    setDiscount(data.sale.discount?.toString() || '0');
    setSaleItems(toEditableItems(data.items));
    setTradeIns(data.tradeIns);
  }, [detailQuery.data, error, navigate, id]);

  // --- Guard: redirect if read-only ---
  useEffect(() => {
    if (!fyLoading && isReadOnly) {
      error('Access Denied', 'Cannot edit a sale in a closed financial year.');
      navigate(`/sales/${id}`, { replace: true });
    }
  }, [fyLoading, isReadOnly]);

  // --- Calculated totals ---
  const subtotal = useMemo(
    () => saleItems.reduce((acc, item) => acc + (Number(item.sold_price) || 0), 0),
    [saleItems]
  );

  const totalTradeInCredit = useMemo(
    () => tradeIns.reduce((acc, ti) => acc + Number(ti.credit_value), 0),
    [tradeIns]
  );

  const newFinalTotal = useMemo(
    () => Math.max(0, subtotal - (Number(discount) || 0) - totalTradeInCredit),
    [subtotal, discount, totalTradeInCredit]
  );

  const alreadyPaid = Number(originalSale?.paid) || 0;
  const newDue = useMemo(
    () => Math.max(0, newFinalTotal - alreadyPaid),
    [newFinalTotal, alreadyPaid]
  );

  const isBelowPaid = newFinalTotal < alreadyPaid;
  const hasPaymentWarning = alreadyPaid > 0;

  // --- Handlers ---
  const handleUpdateItemPrice = (sale_item_id: string, price: string) => {
    setSaleItems(prev =>
      prev.map(item => (item.sale_item_id === sale_item_id ? { ...item, sold_price: price } : item))
    );
  };

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Save → validate all + focus first invalid).
  const fieldErrors = useFieldErrors();

  // ── Validation (per field; the update_sale RPC stays authoritative) ──
  const errors = useMemo(() => ({
    date: !date
      ? 'Date is required.'
      : (selectedYear && (date < selectedYear.start_date || date > selectedYear.end_date))
        ? `Date must be within the financial year (${selectedYear.start_date} to ${selectedYear.end_date}).`
        : null,
    discount: discount.trim() !== '' && parseMoney(discount) === null
      ? 'Enter a valid discount amount.'
      : null,
    prices: saleItems.map(item =>
      parseMoney(item.sold_price) === null
        ? `Enter a valid sold price for ${item.brand} ${item.model}.`
        : null,
    ),
  }), [date, selectedYear, discount, saleItems]);

  const hasErrors = !!errors.date || !!errors.discount || errors.prices.some(Boolean);

  const handleSave = async () => {
    if (!originalSale || !selectedYear) return;

    // Validate the complete form: show every error inline, focus the first
    // invalid field — no validation toast.
    fieldErrors.beginSubmit();
    if (hasErrors) { focusFirstInvalid(); return; }

    setIsSaving(true);
    try {
      // ONE atomic canonical RPC: per-item prices + header, with all totals
      // recomputed server-side (fixes the old non-atomic direct writes).
      await updateSale({
        saleId: id,
        date,
        discount: Number(discount) || 0,
        items: saleItems.map((item) => ({
          sale_item_id: item.sale_item_id,
          sold_price: Number(item.sold_price) || 0,
        })),
      });

      // Centralized semantic invalidation (the full sale surface).
      await invalidateSales(selectedYear.id);

      success('Saved', 'Sale updated successfully.');

      // Successful save replaces the editor entry with the resulting
      // invoice — Back from the detail follows the user's real history
      // (the invoice they came from, or wherever the editor was entered
      // from), never back into the completed editor.
      navigate(`/sales/${id}`, { replace: true });
    } catch (err: any) {
      error('Error', err.message || 'Failed to save changes.');
    } finally {
      setIsSaving(false);
    }
  };

  // --- Skeleton loading state (genuine first load only — the shared cached
  //     query renders the form immediately when the data is already loaded) ---
  if (detailQuery.isLoading || fyLoading) {
    return (
      <div className={cn('space-y-5', skeletonPulsing && 'animate-pulse')}>
        <div className="flex items-center justify-between">
          <div className="space-y-1.5"><div className="h-4 w-40 bg-slate-100 rounded" /><div className="h-3 w-64 bg-slate-100 rounded" /></div>
          <div className="h-8 w-28 bg-slate-100 rounded-md" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
          <div className="min-w-0 space-y-5">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><div className="h-3 w-10 bg-slate-100 rounded" /><div className="h-10 bg-slate-100 rounded-md" /></div>
                <div className="space-y-1.5"><div className="h-3 w-20 bg-slate-100 rounded" /><div className="h-10 bg-slate-100 rounded-md" /></div>
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
              <div className="h-4 w-36 bg-slate-100 rounded" />
              {[...Array(2)].map((_, i) => <div key={i} className="h-14 w-full bg-slate-50 border border-slate-100 rounded-lg" />)}
            </div>
          </div>
          <div className="min-w-0">
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
              <div className="h-4 w-28 bg-slate-100 rounded" />
              {[...Array(4)].map((_, i) => <div key={i} className="h-4 w-full bg-slate-100 rounded" />)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="text-center py-16 space-y-3">
        <p className="text-xs text-rose-500">Failed to load sale.</p>
        <Button size="sm" variant="outline" onClick={() => detailQuery.refetch()} className="text-xs h-8">
          Retry
        </Button>
      </div>
    );
  }

  // A cancelled sale never shows the form — the init effect above redirects
  // back to the invoice with an explanatory toast.
  if (detail?.sale?.status === 'cancelled') {
    return null;
  }

  if (!originalSale) {
    return <div className="text-center py-16 text-xs text-slate-400">Sale not found.</div>;
  }

  const f = (n: number) =>
    `${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Edit Sale — ${originalSale.bill_number}`}
        subtitle="Correct prices, discount, date, or customer. Trade-ins and items list are locked."
        backTo={`/sales/${id}`}
        backLabel="Back to Invoice"
      />

      {/* Payment already received warning */}
      {hasPaymentWarning && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-semibold text-amber-800">Payment Already Received</p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              {f(alreadyPaid)} has already been received for this invoice. You can still adjust prices and discount — the system will only update the <strong>Due</strong> amount. The already-received amount and its account transactions will not be changed.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
        {/* Left column */}
        <div className="min-w-0 space-y-5">

          {/* Date & Customer */}
          <SectionCard>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label="Date"
                required
                error={fieldErrors.show('date', errors.date)}
                hint={alreadyPaid > 0 ? (
                  <span className="inline-flex items-center gap-1"><Info className="h-3 w-3 shrink-0" /> Existing payment entries keep their original dates.</span>
                ) : undefined}
              >
                <Input
                  type="date"
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  onBlur={() => fieldErrors.touch('date')}
                  min={selectedYear?.start_date}
                  max={selectedYear?.end_date}
                />
              </Field>
              <Field
                label="Customer"
                hint={(
                  <span className="inline-flex items-center gap-1"><Info className="h-3 w-3 shrink-0" /> Customer cannot be changed after a sale is created.</span>
                )}
              >
                <div className="flex h-10 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 font-medium truncate">
                  {originalSale?.parties?.name || '—'}
                  {originalSale?.parties?.number && (
                    <span className="ml-2 text-slate-400 font-normal text-xs">({originalSale.parties.number})</span>
                  )}
                </div>
              </Field>
            </div>
          </SectionCard>

          {/* Sale Items — prices editable, list locked */}
          <SectionCard
            title="Sold Items"
            action={
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 bg-slate-50 border border-slate-200 rounded-md px-2 py-1">
                <Lock className="h-3 w-3" />
                List is read-only — only prices are editable
              </div>
            }
          >
            <div className="space-y-2">
              {saleItems.map((item, idx) => {
                const mrp = item.base_selling_price;
                const soldNum = Number(item.sold_price) || 0;
                const disc = Math.max(0, mrp - soldNum);
                const priceError = fieldErrors.show(`price-${item.sale_item_id}`, errors.prices[idx]);
                return (
                  <div key={item.sale_item_id} className="flex items-start gap-3 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-slate-900 truncate">{item.brand} {item.model}</p>
                      <p className="text-[11px] text-slate-400 font-mono truncate">
                        {item.imei} · {item.ram_rom} · {item.color}
                      </p>
                      {disc > 0 && (
                        <p className="text-[10px] text-rose-500 font-medium mt-1">
                          Discount from MRP: {f(disc)}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">MRP</p>
                      <p className="text-xs text-slate-400 tabular-nums">{f(mrp)}</p>
                    </div>
                    <div className="shrink-0">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5 text-left">Sold Price</p>
                      <MoneyInput
                        value={item.sold_price}
                        onChange={v => handleUpdateItemPrice(item.sale_item_id, v)}
                        onBlur={() => fieldErrors.touch(`price-${item.sale_item_id}`)}
                        error={!!priceError}
                        aria-label={`Sold price for ${item.brand} ${item.model}`}
                        className="w-32 h-9 text-xs"
                      />
                      {priceError && (
                        <p role="alert" className="text-[10px] font-medium text-rose-600 leading-snug mt-1 w-32">{priceError}</p>
                      )}
                    </div>
                  </div>
                );
              })}
              {saleItems.length === 0 && (
                <div className="text-center py-6 text-xs text-slate-400 border-2 border-dashed border-slate-200 rounded-lg">
                  No items found for this sale.
                </div>
              )}
            </div>
          </SectionCard>

          {/* Trade-Ins — fully read-only */}
          {tradeIns.length > 0 && (
            <SectionCard
              title="Trade-Ins"
              icon={<RefreshCw className="h-3.5 w-3.5 text-emerald-600" />}
              action={
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 bg-slate-50 border border-slate-200 rounded-md px-2 py-1">
                  <Lock className="h-3 w-3" />
                  Cannot be edited after creation
                </div>
              }
            >
              <div className="space-y-2">
                {tradeIns.map(ti => (
                  <div key={ti.id} className="flex items-center gap-3 p-2.5 border border-emerald-100 bg-emerald-50/50 rounded-lg opacity-80">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-emerald-900 truncate">{ti.inventory_items?.brand} {ti.inventory_items?.model}</p>
                      <p className="text-[11px] text-emerald-700/80 font-mono truncate">{ti.inventory_items?.imei}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-semibold text-emerald-700 tabular-nums">-{Number(ti.credit_value).toFixed(2)} Rs.</p>
                      <p className="text-[10px] uppercase font-bold text-emerald-600/70">Credit</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-3 flex items-center gap-1">
                <Info className="h-3 w-3 shrink-0" />
                Trade-in credit is locked because it is linked to auto-generated purchase records and inventory.
              </p>
            </SectionCard>
          )}
        </div>

        {/* Right sidebar — Totals (stable fixed track; the main column
            absorbs the viewport width) */}
        <div className="min-w-0">
          <SectionCard title="Updated Totals" className="sticky top-6">
            <div className="space-y-3">
              <SummaryLine label="Subtotal" value={f(subtotal)} valueClassName="font-medium" />
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-600">Additional Discount</label>
                <MoneyInput placeholder="0.00" value={discount} onBlur={() => fieldErrors.touch('discount')} onChange={setDiscount} error={!!fieldErrors.show('discount', errors.discount)} />
                {fieldErrors.show('discount', errors.discount) && (
                  <p role="alert" className="text-[10px] font-medium text-rose-600 leading-snug">{errors.discount}</p>
                )}
              </div>
              {totalTradeInCredit > 0 && (
                <SummaryLine
                  label="Trade-In Credit"
                  value={`- ${f(totalTradeInCredit)}`}
                  labelClassName="text-emerald-700"
                  valueClassName="font-medium text-emerald-700"
                />
              )}
              <SummaryLine
                label="Final Total"
                value={f(newFinalTotal)}
                className="pt-3 border-t border-slate-200"
                labelClassName="text-sm font-bold text-slate-900"
                valueClassName={cn('text-lg font-bold', isBelowPaid ? 'text-rose-600' : 'text-indigo-700')}
              />

              {/* Constraint error */}
              {isBelowPaid && (
                <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-600 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-rose-700">
                    Total cannot be less than the already-received amount of <strong>{f(alreadyPaid)}</strong>.
                  </p>
                </div>
              )}
            </div>

            {/* Payment summary — read-only, the same soft inset panel as the
                sale editor's payment surface */}
            <div className="mt-4 space-y-2.5 rounded-lg border border-slate-100 bg-slate-50 p-3">
              <SummaryLine
                label="Already Received"
                value={f(alreadyPaid)}
                labelClassName="text-slate-600"
                valueClassName="font-semibold text-emerald-700"
              />
              <SummaryLine
                label="New Due"
                value={f(newDue)}
                className="pt-2.5 border-t border-slate-200"
                labelClassName="font-bold text-slate-700"
                valueClassName={cn('text-lg font-bold', newDue > 0 ? 'text-rose-600' : 'text-slate-400')}
              />
            </div>

            {/* Original amounts for reference */}
            <div className="mt-4 space-y-1.5 p-3 bg-slate-50/80 rounded-lg border border-slate-100">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Original Values</p>
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>Total</span>
                <span className="tabular-nums">{f(Number(originalSale.final_total))}</span>
              </div>
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>Paid</span>
                <span className="tabular-nums">{f(alreadyPaid)}</span>
              </div>
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>Due</span>
                <span className="tabular-nums">{f(Number(originalSale.due))}</span>
              </div>
            </div>

            <div className="mt-4">
              <Button
                onClick={handleSave}
                isLoading={isSaving}
                disabled={isBelowPaid}
                className="w-full h-10 font-semibold gap-2"
              >
                <Save className="h-4 w-4" />
                Save Changes
              </Button>
              <button
                onClick={() => navigate(`/sales/${id}`)}
                className="w-full mt-2 h-9 text-xs text-slate-500 hover:text-slate-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
