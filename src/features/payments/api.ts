/**
 * Invoice payment-history queries (browser, RLS-enforced, read-only).
 *
 * The Payments dialog loads ONE invoice/bill's payment rows through the
 * established application data architecture — the same Supabase client and
 * query conventions as every other feature module. The AGGREGATE paid/due
 * state is NOT recomputed here: it comes from the authoritative
 * sales.paid/due (purchases.paid/due) row the detail page already holds.
 */
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'

/** One payment row as the Payments dialog presents it. */
export interface InvoicePaymentRow {
  id: string
  amount: string | number
  date: string
  payment_modes?: { name: string } | null
  bank_accounts?: { name: string } | null
}

export const invoicePaymentsKeys = {
  list: (invoiceType: 'sale' | 'purchase', invoiceId: string) =>
    ['invoice-payments', invoiceType, invoiceId] as const,
}

/** ALL payments recorded against one invoice/bill, oldest first — including
 *  the initial payment made during invoice/bill creation. */
export function useInvoicePayments(invoiceType: 'sale' | 'purchase', invoiceId: string, enabled = true) {
  return useQuery({
    queryKey: invoicePaymentsKeys.list(invoiceType, invoiceId),
    enabled,
    queryFn: async (): Promise<InvoicePaymentRow[]> => {
      const table = invoiceType === 'sale' ? 'payments_in' : 'payments_out'
      const refColumn = invoiceType === 'sale' ? 'sale_id' : 'purchase_id'
      const { data, error } = await supabase
        .from(table)
        .select('id, amount, date, payment_modes (name), bank_accounts (name)')
        .eq(refColumn, invoiceId)
        .order('date', { ascending: true })
        .order('created_at', { ascending: true })
      if (error) throw error
      // PostgREST returns each to-one FK embed as a one-element array —
      // normalize defensively (the established firstOrNull pattern).
      return ((data as unknown as Array<Record<string, unknown>>) ?? []).map((row) => ({
        ...row,
        payment_modes: firstOrNull(row.payment_modes),
        bank_accounts: firstOrNull(row.bank_accounts),
      })) as InvoicePaymentRow[]
    },
    staleTime: 10_000,
  })
}

function firstOrNull<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null
  return (value as T | null | undefined) ?? null
}
