/**
 * Common / shared primitive types used across multiple features.
 * These map directly to Supabase table rows.
 */

export interface FinancialYear {
  id: string;
  start_date: string;
  end_date: string;
  status: 'active' | 'closed';
}

export interface BankAccount {
  id: string;
  name: string;
  is_cash: boolean;
  balance?: number;
}

export interface PaymentMode {
  id: string;
  name: string;
}

export interface Store {
  id?: string;
  name?: string;
  address?: string;
  phone?: string;
  gstin?: string;
  logo_url?: string;
  signature_url?: string;
  active_financial_year_id?: string;
  /** Store-level onboarding state (read by the access gate). */
  onboarding_complete?: boolean;
}

export interface Party {
  id: string;
  name: string;
  number?: string;
  address?: string;
  gstin?: string;
  balance?: number;
}
