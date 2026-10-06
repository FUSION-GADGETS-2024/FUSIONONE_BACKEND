import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'

/**
 * Single source of truth for WhatsApp message configuration (auto-send flag
 * + message template per invoice type, the automatic-receipt switches, plus
 * the payment-receipt, payment-statement and reminder message templates).
 * Loaded exclusively from the `whatsapp_settings` table — the ONE
 * store-level settings row shared by every authorized user (store-scoped
 * since the auth migration; RLS allows all app users to read it and only the
 * owner to write it). There is deliberately NO hardcoded template fallback:
 * when a template is missing from the database, `template` is `null` and
 * callers must fail with a clear error rather than inventing default text.
 */
export interface WhatsAppDeliveryTypeConfig {
  autoSend: boolean
  template: string | null
}

export interface WhatsAppMessageSettings {
  sale: WhatsAppDeliveryTypeConfig
  purchase: WhatsAppDeliveryTypeConfig
  proforma: WhatsAppDeliveryTypeConfig
  /** Receipts: automatic sending applies to SUBSEQUENT payments only (the
   *  initial payment recorded during invoice/bill creation never triggers a
   *  receipt — the invoice/bill delivery already carries it). */
  paymentIn: { autoSend: boolean; template: string | null }
  paymentOut: { autoSend: boolean; template: string | null }
  /** Statements and the reminder message have NO automatic concept
   *  (statements are manual-only sends; reminder POLICY is per-invoice). */
  statementIn: { template: string | null }
  statementOut: { template: string | null }
  reminder: { template: string | null }
}

const EMPTY: WhatsAppMessageSettings = {
  sale: { autoSend: false, template: null },
  purchase: { autoSend: false, template: null },
  proforma: { autoSend: false, template: null },
  paymentIn: { autoSend: false, template: null },
  paymentOut: { autoSend: false, template: null },
  statementIn: { template: null },
  statementOut: { template: null },
  reminder: { template: null },
}

export function useWhatsAppMessageSettings() {
  const query = useQuery({
    queryKey: ['whatsapp-settings'],
    staleTime: 1000 * 30,
    queryFn: async (): Promise<WhatsAppMessageSettings> => {
      const { data, error } = await supabase
        .from('whatsapp_settings')
        .select(
          'auto_send_sale, auto_send_purchase, auto_send_proforma, auto_send_receipt_in, auto_send_receipt_out, sale_message_template, purchase_message_template, proforma_message_template, payment_in_message_template, payment_out_message_template, payment_statement_in_message_template, payment_statement_out_message_template, reminder_message_template',
        )
        .maybeSingle()

      if (error) throw error
      if (!data) return EMPTY

      return {
        sale: { autoSend: Boolean(data.auto_send_sale), template: data.sale_message_template || null },
        purchase: { autoSend: Boolean(data.auto_send_purchase), template: data.purchase_message_template || null },
        proforma: { autoSend: Boolean(data.auto_send_proforma), template: data.proforma_message_template || null },
        paymentIn: { autoSend: Boolean(data.auto_send_receipt_in), template: data.payment_in_message_template || null },
        paymentOut: { autoSend: Boolean(data.auto_send_receipt_out), template: data.payment_out_message_template || null },
        statementIn: { template: data.payment_statement_in_message_template || null },
        statementOut: { template: data.payment_statement_out_message_template || null },
        reminder: { template: data.reminder_message_template || null },
      }
    },
  })

  return {
    settings: query.data ?? EMPTY,
    isLoading: query.isLoading,
    /** True once the query has settled (data, no-row, or error — never while
     *  the fetch is still pending). Consumers use this to initialize forms
     *  from `settings` exactly once, instead of mistaking the truthy EMPTY
     *  placeholder for loaded data. */
    isReady: !query.isLoading,
    error: query.error,
  }
}
