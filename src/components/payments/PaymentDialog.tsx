'use client';

/**
 * PaymentDialog — the ONE payment dialog for sales and purchase invoices.
 *
 * Used by BOTH the invoice lists (row PAY action) and the invoice detail
 * pages (sidebar payment action) — there is no list variant and no detail
 * variant, just this component:
 *
 *     PaymentDialog
 *         ↓          ↓
 *       list       detail
 *
 * Sales → "Receive Payment" (money in, receive_payment RPC).
 * Purchases → "Pay Party" (money out, pay_purchase RPC).
 *
 * TERMINOLOGY — the dialog records a PAYMENT (the business action); the
 * receipt is a separate DOCUMENT the backend can deliver for it. The
 * primary action therefore carries the same name as the dialog itself
 * ("Receive Payment" / "Pay Party") — never "Record Receipt": recording a
 * payment and generating its receipt document are different concepts.
 *
 * The behavior is the existing list-page logic moved verbatim into one
 * place: identical validation + toasts, the same RPCs, and the centralized
 * semantic invalidation (invalidateSales / invalidatePurchases), which also
 * refreshes the open detail-page query and the lists.
 */
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/form';
import { useToast } from '@/components/ui/Toast';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useBankAccounts, usePaymentModes } from '@/features/accounts/api';
import { receivePayment } from '@/features/sales/mutations';
import { payPurchase } from '@/features/purchases/mutations';
import { invalidateSales, invalidatePurchases } from '@/features/invalidate';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';

export interface PaymentDialogInvoice {
  id: string;
  billNumber: string;
  partyName: string | null;
  total: number;
  paid: number;
  due: number;
}

export interface PaymentDialogProps {
  open: boolean;
  onClose: () => void;
  /** 'sale' → Receive Payment · 'purchase' → Pay Party. */
  invoiceType: 'sale' | 'purchase';
  invoice: PaymentDialogInvoice | null;
}

export function PaymentDialog({ open, onClose, invoiceType, invoice }: PaymentDialogProps) {
  const isSale = invoiceType === 'sale';
  const { selectedYear } = useFinancialYear();
  const { error, success } = useToast();

  const bankQuery = useBankAccounts();
  const modeQuery = usePaymentModes();
  const bankAccounts = bankQuery.data ?? [];
  const paymentModes = modeQuery.data ?? [];

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [bankId, setBankId] = useState('');
  const [modeId, setModeId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, submit → validate all + focus first invalid).
  const fieldErrors = useFieldErrors();

  // (Re)initialize from the target invoice DURING RENDER whenever the dialog
  // opens (or reopens for a different invoice). React re-renders with the new
  // state before committing to the DOM, so the first PAINTED frame always
  // shows THIS invoice's amount/date — a post-render effect let the previous
  // invoice's amount flash for one frame on reopen.
  const dialogTarget = open && invoice ? invoice.id : null;
  const [appliedTarget, setAppliedTarget] = useState(dialogTarget);
  if (dialogTarget !== appliedTarget) {
    setAppliedTarget(dialogTarget);
    fieldErrors.reset();
    if (invoice) {
      setAmount(invoice.due.toString());
      const today = new Date().toISOString().split('T')[0];
      setDate(selectedYear
        ? (today < selectedYear.start_date ? selectedYear.start_date : today > selectedYear.end_date ? selectedYear.end_date : today)
        : today);
      setBankId('');
      setModeId('');
    }
  }

  const selectedBank = bankAccounts.find(b => b.id === bankId);
  const applicableModes = paymentModes.filter(m => m.bank_account_id === bankId);
  // A non-cash account with NO configured payment modes: the mode field
  // would otherwise be a required dropdown with nothing to select — guide
  // the user to add one instead (guidance also becomes the submit error).
  const noModesAvailable = !!selectedBank && !selectedBank.is_cash && applicableModes.length === 0;

  // ── Validation (per field; the receive_payment / pay_purchase RPCs stay
  //    authoritative) ──
  const errors = {
    amount: (() => {
      const parsedAmount = Number(amount);
      if (!amount.trim() || isNaN(parsedAmount) || parsedAmount <= 0) return 'Enter an amount greater than zero.';
      if (invoice && parsedAmount > invoice.due) return 'Amount cannot be greater than the balance due.';
      return null;
    })(),
    date: !date
      ? 'Date is required.'
      : (selectedYear && (date < selectedYear.start_date || date > selectedYear.end_date))
        ? `Date must be within the financial year (${selectedYear.start_date} to ${selectedYear.end_date}).`
        : null,
    account: !bankId ? 'Select an account.' : null,
    mode: selectedBank && !selectedBank.is_cash && !modeId
      ? (noModesAvailable ? 'Add a payment mode to this account first.' : 'Select a payment mode.')
      : null,
  };

  const handleSubmit = async () => {
    if (!selectedYear || !invoice) return;
    const parsedAmount = Number(amount);
    // Validate the complete form: show every error inline, focus the first
    // invalid field — no validation toast.
    fieldErrors.beginSubmit();
    if (Object.values(errors).some(Boolean)) { focusFirstInvalid(); return; }
    setSubmitting(true);
    try {
      if (isSale) {
        await receivePayment({
          saleId: invoice.id,
          amount: parsedAmount,
          date,
          bankAccountId: bankId,
          paymentModeId: modeId || null,
        });
      } else {
        await payPurchase({
          purchaseId: invoice.id,
          amount: parsedAmount,
          date,
          bankAccountId: bankId,
          paymentModeId: modeId || null,
        });
      }
      success('Success', isSale ? 'Payment received' : 'Payment made');
      onClose();
      await (isSale ? invalidateSales(selectedYear.id) : invalidatePurchases(selectedYear.id));
    } catch (err: any) {
      error('Error', err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open && !!invoice}
      onClose={() => !submitting && onClose()}
      hideClose
      title={isSale ? 'Receive Payment' : 'Pay Party'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} isLoading={submitting}>{isSale ? 'Receive Payment' : 'Pay Party'}</Button>
        </>
      }
    >
      {invoice && (
        <div className="space-y-4">
          <div className="bg-slate-50 rounded-lg border border-slate-200 px-4 py-3 flex justify-between text-xs">
            <div><p className="text-slate-400 mb-0.5">{isSale ? 'Invoice' : 'Bill No'}</p><p className="font-semibold text-slate-900">{invoice.billNumber}</p></div>
            <div className="text-right"><p className="text-slate-400 mb-0.5">{isSale ? 'Customer' : 'Party'}</p><p className="font-semibold text-slate-900">{invoice.partyName}</p></div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-slate-50 rounded-lg p-2.5 text-center"><p className="text-[10px] text-slate-400 mb-1">Total</p><p className="text-xs font-semibold tabular-nums">{Number(invoice.total).toFixed(2)} Rs.</p></div>
            <div className="bg-emerald-50 rounded-lg p-2.5 text-center border border-emerald-100"><p className="text-[10px] text-emerald-600 mb-1">{isSale ? 'Received' : 'Paid'}</p><p className="text-xs font-semibold text-emerald-800 tabular-nums">{Number(invoice.paid).toFixed(2)} Rs.</p></div>
            <div className="bg-rose-50 rounded-lg p-2.5 text-center border border-rose-100"><p className="text-[10px] text-rose-600 mb-1">Due</p><p className="text-xs font-bold text-rose-800 tabular-nums">{Number(invoice.due).toFixed(2)} Rs.</p></div>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount" required error={fieldErrors.show('amount', errors.amount)}>
                <MoneyInput value={amount} onBlur={() => fieldErrors.touch('amount')} onChange={setAmount} className="text-xs" />
              </Field>
              <Field label="Date" required error={fieldErrors.show('date', errors.date)}>
                <Input type="date" value={date} onChange={e => setDate(e.target.value)} onBlur={() => fieldErrors.touch('date')} min={selectedYear?.start_date} max={selectedYear?.end_date} className="text-xs" />
              </Field>
            </div>
            <Field label="Account" required error={fieldErrors.show('account', errors.account)}>
              <Select value={bankId} onChange={v => { setBankId(v); setModeId(''); }}
                options={[{ value: '', label: 'Select account' }, ...bankAccounts.map(b => ({ value: b.id, label: b.name + (b.is_cash ? ' (Cash)' : '') }))]} />
            </Field>
            {selectedBank && !selectedBank.is_cash && (
              <Field
                label="Payment Mode"
                required
                hint={noModesAvailable ? 'Add a payment mode to this account first.' : undefined}
                error={fieldErrors.show('mode', errors.mode)}
              >
                <Select value={modeId} onChange={v => setModeId(v)}
                  options={[{ value: '', label: 'Select mode' }, ...applicableModes.map(m => ({ value: m.id, label: m.name }))]} />
              </Field>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
