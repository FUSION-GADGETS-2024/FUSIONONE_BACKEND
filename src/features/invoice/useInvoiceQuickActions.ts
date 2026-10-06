/**
 * Direct list-row invoice actions — the ONE behavior layer shared by every
 * invoice list (Sales, Purchases, Proformas, and any future list).
 *
 * Each action executes directly against the row's invoice — it never routes
 * through the invoice detail page:
 *
 *   savePdf → existing PDF pipeline (download.ts — single rendering source)
 *   share   → existing WhatsApp message action (postSendInvoice, by reference)
 *   print   → existing PDF pipeline + browser native print (print.ts)
 *
 * The detail page keeps its own action system; lists use this hook so the
 * two can never drift apart.
 */
import { useCallback } from 'react'
import type { InvoiceType } from './types'
import { downloadInvoicePdf } from './download'
import { printInvoicePdf } from './print'
import { postSendInvoice } from '@/platform/whatsapp/http'
import { useToast } from '@/components/ui/Toast'

export interface InvoiceQuickAction {
  invoiceId: string
  invoiceType: InvoiceType
  billNumber: string
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function useInvoiceQuickActions() {
  const { success, error } = useToast()

  const savePdf = useCallback(async (target: InvoiceQuickAction) => {
    try {
      await downloadInvoicePdf(target.invoiceId, target.invoiceType)
    } catch (cause) {
      error('PDF Failed', messageOf(cause, 'Unable to generate the PDF.'))
    }
  }, [error])

  const share = useCallback(async (target: InvoiceQuickAction) => {
    try {
      // Existing send behavior — the invoice is sent by reference to the
      // party's number; the backend owns data, message, and PDF. No extra
      // invoice data is needed here.
      await postSendInvoice({ invoiceId: target.invoiceId, invoiceType: target.invoiceType })
      success('Invoice sent', `Invoice ${target.billNumber} was sent on WhatsApp.`)
    } catch (cause) {
      error('WhatsApp send failed', messageOf(cause, 'Unable to send invoice'))
    }
  }, [success, error])

  const print = useCallback(async (target: InvoiceQuickAction) => {
    try {
      await printInvoicePdf(target.invoiceId, target.invoiceType)
    } catch (cause) {
      error('Print Failed', messageOf(cause, 'Unable to print the invoice.'))
    }
  }, [error])

  return { savePdf, share, print }
}
