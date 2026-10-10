/**
 * Direct list-row invoice actions — the ONE behavior layer shared by every
 * invoice list (Sales, Purchases, Proformas, and any future list).
 *
 * Each action executes directly against the row's invoice — it never routes
 * through the invoice detail page:
 *
 *   savePdf         → existing PDF pipeline (download.ts — single rendering source)
 *   shareViaWhatsApp→ existing WhatsApp message action (postSendInvoice, by reference)
 *   share           → native platform share of the SAME PDF artifact (share.ts)
 *   print           → existing PDF pipeline + browser native print (print.ts)
 *
 * `shareViaWhatsApp` and `share` are deliberately separate actions with
 * separate implementations: WhatsApp delivery is backend-owned (data,
 * message, PDF and transport by reference), while native share hands the
 * browser-side PDF file to the platform share sheet. Neither ever invokes
 * the other.
 *
 * The detail pages keep their own action panel; both consume the same
 * feature-level implementations, so the two surfaces cannot drift apart.
 */
import { useCallback } from 'react'
import type { InvoiceType } from './types'
import { downloadInvoicePdf } from './download'
import { printInvoicePdf } from './print'
import { shareInvoicePdf } from './share'
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

  const shareViaWhatsApp = useCallback(async (target: InvoiceQuickAction) => {
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

  const share = useCallback(async (target: InvoiceQuickAction) => {
    try {
      // Native platform share of the invoice PDF — the same artifact the
      // other actions use (one pipeline, one cache). Unsupported platforms
      // reject with a clear message; a user dismissal resolves silently.
      await shareInvoicePdf(target.invoiceId, target.invoiceType)
    } catch (cause) {
      error('Share Failed', messageOf(cause, 'Unable to share the invoice PDF.'))
    }
  }, [error])

  const print = useCallback(async (target: InvoiceQuickAction) => {
    try {
      await printInvoicePdf(target.invoiceId, target.invoiceType)
    } catch (cause) {
      error('Print Failed', messageOf(cause, 'Unable to print the invoice.'))
    }
  }, [error])

  return { savePdf, shareViaWhatsApp, share, print }
}
