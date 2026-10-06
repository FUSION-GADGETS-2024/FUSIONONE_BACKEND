/**
 * Client-side invoice PDF download (browser-only).
 *
 * Flow: load the invoice by reference (RLS) → compose InvoiceData with the
 * proven builders → render with the browser PDFKit build → trigger download
 * with filename "{bill_number}.pdf".
 *
 * `buildInvoicePdf` is the single compose step reused by every client-side
 * PDF action (download, print, viewer) so they can never drift apart.
 *
 * The composed PDF is cached by content fingerprint (pdf-cache.ts): opening
 * an unchanged invoice reuses the cached document instead of re-rendering
 * it. `force` (the manual Refresh action) bypasses the cache READ, always
 * re-renders through the same pipeline, and replaces the cached entry.
 * No server round-trip, no PDF service, no second renderer.
 */
import type { InvoiceType } from './types'
import { loadInvoiceData } from './api'
import { generateInvoicePdf } from './renderers/pdfkit'
import { invoicePdfCacheKey, readCachedInvoicePdf, writeCachedInvoicePdf } from './pdf-cache'
import { perfMark, perfIncrement } from '@/platform/perf'

export interface BuildInvoicePdfOptions {
  /**
   * Bypass the cache READ and regenerate through the existing pipeline
   * (manual Refresh). The freshly rendered PDF replaces the cached entry,
   * and the invoice data is re-read from the CURRENT state (fresh fetch)
   * before rendering.
   */
  force?: boolean
}

interface BuiltInvoicePdf {
  blob: Blob
  billNumber: string
  cached: boolean
}

/**
 * In-flight compose dedupe — concurrent builds for the SAME invoice and the
 * SAME intent (e.g. the viewer composing while the user clicks Save PDF, or
 * React StrictMode's double effect in development) share ONE pipeline run
 * instead of rendering the document twice. A forced refresh is a distinct
 * intent and is never merged into a normal build.
 */
const inFlight = new Map<string, Promise<BuiltInvoicePdf>>()

/**
 * Load + render an invoice PDF by reference. The one compose step reused by
 * all client PDF actions so download, print and the viewer can never drift
 * apart.
 */
export function buildInvoicePdf(
  invoiceId: string,
  invoiceType: InvoiceType,
  options: BuildInvoicePdfOptions = {},
): Promise<BuiltInvoicePdf> {
  const flightKey = `${invoiceType}:${invoiceId}:${options.force ? 'force' : 'auto'}`
  const existing = inFlight.get(flightKey)
  if (existing) return existing

  const run = composeInvoicePdf(invoiceId, invoiceType, options).finally(() => {
    inFlight.delete(flightKey)
  })
  inFlight.set(flightKey, run)
  return run
}

async function composeInvoicePdf(
  invoiceId: string,
  invoiceType: InvoiceType,
  options: BuildInvoicePdfOptions,
): Promise<BuiltInvoicePdf> {
  perfIncrement('pipelineRuns')
  // Always resolve the invoice data first — it defines the cache identity, so
  // a changed invoice can never be served from a stale PDF. Resolution goes
  // through the shared query cache (instant when fresh); a forced refresh
  // re-reads the CURRENT state before rendering. (Dev-only timing marks; no-ops
  // in production.)
  perfMark('data-start')
  const data = await loadInvoiceData(invoiceId, invoiceType, { fresh: options.force })
  perfMark('data-end')
  const key = invoicePdfCacheKey(invoiceId, invoiceType, data)

  if (!options.force) {
    perfIncrement('cacheReads')
    const cached = await readCachedInvoicePdf(key)
    if (cached) {
      return { blob: cached, billNumber: data.bill_number, cached: true }
    }
  }

  perfIncrement('generationRuns')
  perfMark('gen-start')
  const blob = await generateInvoicePdf(data)
  perfMark('gen-end')
  await writeCachedInvoicePdf({
    key,
    invoiceType,
    invoiceId,
    billNumber: data.bill_number,
    blob,
  })
  return { blob, billNumber: data.bill_number, cached: false }
}

export async function downloadInvoicePdf(invoiceId: string, invoiceType: InvoiceType): Promise<void> {
  const { blob, billNumber } = await buildInvoicePdf(invoiceId, invoiceType)
  triggerDownload(blob, `${billNumber}.pdf`)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
