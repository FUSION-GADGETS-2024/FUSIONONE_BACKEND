/**
 * Invoice data loading (browser, RLS-enforced).
 *
 * The reference app loaded invoices server-side (cookie client in an API
 * route); the SPA loads them in the browser with the SAME publishable-key
 * client under the SAME RLS — an authenticated user can only compose their
 * own store's invoices. Identical queries, identical builders.
 *
 * Data resolution runs through the app's ONE React Query cache (the same
 * query keys and fetchers the detail pages use), so the invoice page, the
 * edit page and the PDF pipeline share a single fetch per invoice instead of
 * each issuing its own Supabase round trips:
 *
 *   - fresh cached detail (within the app's staleTime) → resolved instantly,
 *     no network — a cached invoice PDF opens with zero data requests;
 *   - stale/absent → ONE parallel fetch batch, deduplicated with any
 *     in-flight detail fetch and cached for the next consumer;
 *   - `fresh: true` (the manual Refresh action) bypasses the freshness
 *     window and obtains the CURRENT invoice state before rendering.
 *
 * The composed InvoiceData is byte-identical to what the previous dedicated
 * queries produced (the shared detail fetchers return supersets of the
 * fields the builders read), so PDF cache fingerprints are unchanged.
 */
import { getQueryClient } from '@/features/invalidate'
import { salesKeys, fetchSaleDetail } from '@/features/sales/api'
import { purchaseKeys, fetchPurchaseDetail } from '@/features/purchases/api'
import { proformaKeys, fetchProformaDetail } from '@/features/proformas/api'
import type { InvoiceData, InvoiceType } from './types'
import { buildSaleInvoiceData, buildPurchaseInvoiceData, buildProformaInvoiceData } from './builders'

const INVOICE_TYPES: readonly InvoiceType[] = ['sale', 'purchase', 'proforma'] as const

export interface LoadInvoiceDataOptions {
  /**
   * Obtain the CURRENT invoice state, bypassing the query cache's freshness
   * window (the manual Refresh action). The refetched rows also update the
   * shared cache for subsequent readers.
   */
  fresh?: boolean
}

/**
 * fetchQuery wrapper: resolves from the shared query cache when the data is
 * fresh, otherwise fetches once (deduplicated with any in-flight fetch of
 * the same key). `fresh` forces a refetch past the freshness window.
 */
function resolveDetail<TData>(
  queryKey: readonly unknown[],
  fetcher: () => Promise<TData>,
  fresh: boolean,
): Promise<TData> {
  return getQueryClient().fetchQuery({
    queryKey,
    queryFn: fetcher,
    ...(fresh ? { staleTime: 0 } : {}),
  })
}

export async function loadInvoiceData(
  invoiceId: string,
  invoiceType: InvoiceType,
  options: LoadInvoiceDataOptions = {},
): Promise<InvoiceData> {
  const fresh = options.fresh === true
  switch (invoiceType) {
    case 'sale': {
      let detail: Awaited<ReturnType<typeof fetchSaleDetail>>
      try {
        detail = await resolveDetail(
          salesKeys.detail(invoiceId),
          () => fetchSaleDetail(invoiceId),
          fresh,
        )
      } catch (cause) {
        throw new Error('Failed to load the sale invoice.', { cause })
      }
      if (!detail.sale) throw new Error('Invoice not found.')
      return buildSaleInvoiceData({
        sale: detail.sale,
        items: detail.items,
        tradeIns: detail.tradeIns,
        store: detail.store,
      })
    }
    case 'purchase': {
      let detail: Awaited<ReturnType<typeof fetchPurchaseDetail>>
      try {
        detail = await resolveDetail(
          purchaseKeys.detail(invoiceId),
          () => fetchPurchaseDetail(invoiceId),
          fresh,
        )
      } catch (cause) {
        throw new Error('Failed to load the purchase bill.', { cause })
      }
      if (!detail.purchase) throw new Error('Invoice not found.')
      return buildPurchaseInvoiceData({
        purchase: detail.purchase,
        items: detail.items,
        store: detail.store,
      })
    }
    case 'proforma': {
      let detail: Awaited<ReturnType<typeof fetchProformaDetail>>
      try {
        detail = await resolveDetail(
          proformaKeys.detail(invoiceId),
          () => fetchProformaDetail(invoiceId),
          fresh,
        )
      } catch (cause) {
        throw new Error('Failed to load the quotation.', { cause })
      }
      if (!detail.proforma) throw new Error('Invoice not found.')
      return buildProformaInvoiceData({
        proforma: detail.proforma,
        items: detail.items,
        tradeIns: detail.tradeIns,
        store: detail.store,
      })
    }
    default:
      throw new Error(`Invalid invoice type. Allowed: ${INVOICE_TYPES.join(', ')}.`)
  }
}

export { INVOICE_TYPES }
