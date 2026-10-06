import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

/**
 * Shared banking queries — the single cached source for bank accounts and
 * payment modes (fixes audit D1: five competing keys → one each). These
 * rows are NOT financial-year scoped, so the keys are not FY-keyed.
 */

export interface BankAccountRow {
  id: string
  name: string
  is_cash: boolean
}

export interface PaymentModeRow {
  id: string
  bank_account_id: string
  name: string
}

export function useBankAccounts() {
  return useQuery({
    queryKey: ['bank-accounts'],
    queryFn: async (): Promise<BankAccountRow[]> => {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, name, is_cash')
        .order('is_cash', { ascending: false })
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as BankAccountRow[]
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function usePaymentModes() {
  return useQuery({
    queryKey: ['payment-modes'],
    queryFn: async (): Promise<PaymentModeRow[]> => {
      const { data, error } = await supabase
        .from('payment_modes')
        .select('id, bank_account_id, name')
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as PaymentModeRow[]
    },
    staleTime: 5 * 60 * 1000,
  })
}

/** FY-scoped account transactions (amount + direction) for balance folds. */
export interface AccountTransactionLite {
  bank_account_id: string
  type: 'credit' | 'debit'
  amount: number
}

export function useAccountTransactions(fyId: string | undefined) {
  return useQuery({
    queryKey: ['accounts-page', fyId],
    enabled: !!fyId,
    queryFn: async (): Promise<AccountTransactionLite[]> => {
      if (!fyId) return []
      const { data, error } = await supabase
        .from('account_transactions')
        .select('bank_account_id, type, amount')
        .eq('financial_year_id', fyId)
      if (error) throw error
      return (data ?? []) as AccountTransactionLite[]
    },
  })
}

/** Balance computation helper (the single fold — audit D4). */
export function computeBalances(
  accounts: BankAccountRow[],
  transactions: AccountTransactionLite[],
): Record<string, number> {
  const m: Record<string, number> = {}
  accounts.forEach((a) => (m[a.id] = 0))
  transactions.forEach((tx) => {
    const amt = Number(tx.amount)
    m[tx.bank_account_id] = (m[tx.bank_account_id] || 0) + (tx.type === 'credit' ? amt : -amt)
  })
  return m
}

/** Transaction label/color helpers (verbatim port). Labels use the payment
 *  vocabulary — a transaction IS a payment ("receipt" is reserved for the
 *  receipt DOCUMENT, never used as a synonym for money received). */
export function getTransactionLabel(refType: string, txType: 'credit' | 'debit'): string {
  switch (refType) {
    case 'sale':
      return 'Sale Payment'
    case 'purchase':
      return 'Purchase Payment'
    case 'payment_in':
      return 'Payment Received'
    case 'payment_out':
      return 'Payment Made'
    case 'add_funds':
      return 'Funds Added'
    case 'transfer':
      return txType === 'debit' ? 'Transfer Out' : 'Transfer In'
    case 'opening_balance':
      return 'Opening Balance'
    case 'sale_cancelled':
      return 'Sale Cancelled Reversal'
    default:
      return refType
  }
}

export function getTransactionColor(_refType: string, txType: 'credit' | 'debit') {
  if (txType === 'credit')
    return {
      bg: 'bg-emerald-50',
      text: 'text-emerald-700',
      badge: 'bg-emerald-100 text-emerald-700',
    }
  return { bg: 'bg-rose-50', text: 'text-rose-700', badge: 'bg-rose-100 text-rose-700' }
}

export type { FinancialYear }

// ── Formatting helpers (ported verbatim from the reference app) ─────────────

/** Clamp today's date into the FY range (shared by add-funds/transfer forms). */
export function clampToFinancialYear(fy: { start_date: string; end_date: string }): string {
  const today = new Date().toISOString().split('T')[0]
  if (today < fy.start_date) return fy.start_date
  if (today > fy.end_date) return fy.end_date
  return today
}

export function formatINR(val: number): string {
  return val.toLocaleString('en-IN', { minimumFractionDigits: 2 })
}

// ── Transaction history (per-account, RLS-scoped in the browser) ────────────

export interface TransactionRow {
  id: string
  bank_account_id: string
  payment_mode_id: string | null
  type: 'credit' | 'debit'
  amount: number
  date: string
  reference_type: string
  reference_id: string
  financial_year_id: string
  notes: string | null
  transfer_group_id: string | null
  created_at: string
}

export async function fetchAccountHistory(
  bankAccountId: string,
  financialYearId: string,
): Promise<TransactionRow[]> {
  // Direct RLS-scoped read (replaces the old admin-key API route — the owner
  // can only ever read their own transactions either way).
  const { data, error } = await supabase
    .from('account_transactions')
    .select('id, bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id, notes, transfer_group_id, created_at')
    .eq('bank_account_id', bankAccountId)
    .eq('financial_year_id', financialYearId)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as TransactionRow[]
}
