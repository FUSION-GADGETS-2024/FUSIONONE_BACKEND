/**
 * Account money mutations — transactional RPCs (add_funds, transfer_funds)
 * replacing the former secret-key admin API routes. The RPCs run under the
 * caller's JWT + RLS and enforce the same validations with the exact
 * reference error texts.
 */
import { supabase } from '@/platform/supabase/client'

export async function addFunds(params: {
  bank_account_id: string
  amount: number
  date: string
  notes?: string | null
  financial_year_id: string
}): Promise<string> {
  const { data, error } = await supabase.rpc('add_funds', {
    p_bank_account_id: params.bank_account_id,
    p_amount: params.amount,
    p_date: params.date,
    p_financial_year_id: params.financial_year_id,
    p_notes: params.notes ?? null,
  })
  if (error) throw error
  return data as string
}

export async function transferFunds(params: {
  from_bank_account_id: string
  to_bank_account_id: string
  amount: number
  date: string
  notes?: string | null
  financial_year_id: string
}): Promise<string> {
  const { data, error } = await supabase.rpc('transfer_funds', {
    p_from_bank_account_id: params.from_bank_account_id,
    p_to_bank_account_id: params.to_bank_account_id,
    p_amount: params.amount,
    p_date: params.date,
    p_financial_year_id: params.financial_year_id,
    p_notes: params.notes ?? null,
  })
  if (error) throw error
  return data as string
}
