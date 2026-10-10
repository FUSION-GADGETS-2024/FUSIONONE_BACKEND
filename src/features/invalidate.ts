/**
 * Centralized semantic cache invalidation.
 *
 * Every mutation invalidates through ONE place instead of hand-rolled
 per-page key lists (fixes audit D17: invalidation-list drift). The helper
 names describe the business event, and each helper owns the complete set
 of query keys that event can affect.
 */
import type { QueryClient } from '@tanstack/react-query'

let client: QueryClient | null = null

/** Called once by QueryProvider — the app has exactly one QueryClient. */
export function setQueryClient(c: QueryClient): void {
  client = c
}

/**
 * The app's ONE QueryClient, for non-React call sites that need the SAME
 * query cache the components use (e.g. the invoice PDF pipeline's data
 * resolution). Throws if read before QueryProvider mounted.
 */
export function getQueryClient(): QueryClient {
  if (!client) throw new Error('QueryClient not initialized (QueryProvider missing?)')
  return client
}

function qc(): QueryClient {
  return getQueryClient()
}

type Keys = ReadonlyArray<readonly unknown[]>

async function invalidate(keys: Keys): Promise<void> {
  await Promise.all(keys.map((key) => qc().invalidateQueries({ queryKey: key as unknown[] })))
}

/** Store row changed (settings save, onboarding, active FY pointer). */
export function invalidateStore(): Promise<void> {
  return invalidate([['store', 'current']])
}

/**
 * Clear ALL cached queries — called on sign-out. Every query in this app is
 * user-scoped (store, FYs, parties, sales, WhatsApp settings, …); without
 * this, the next user to sign in within the staleTime window (60s) would be
 * served the PREVIOUS user's cached store/FY (and could create documents
 * under the wrong financial year).
 */
export function clearQueryCache(): void {
  if (client) client.clear()
}

/** Financial-year rows changed (create / close). */
export function invalidateFinancialYears(): Promise<void> {
  return invalidate([
    ['financial-years'],
    ['store', 'current'],
    // Closing an FY carries stock forward and changes notice conditions.
    ['analytics'],
    ['notices'],
  ])
}

/** Banking setup changed (accounts CRUD, payment modes). */
export function invalidateBanking(): Promise<void> {
  // Account/mode names surface in analytics payment breakdowns.
  return invalidate([['bank-accounts'], ['payment-modes'], ['analytics']])
}

/** Party directory changed. */
export function invalidateParties(): Promise<void> {
  // Party names surface in analytics registers and notice messages.
  return invalidate([['parties'], ['party-detail'], ['analytics'], ['notices']])
}

/** Inventory changed for a FY (add / edit / status changes). */
export function invalidateInventory(fyId?: string): Promise<void> {
  return invalidate([
    ['inventory-page', fyId].filter((k) => k !== undefined),
    // The ranked search cache (keys carry their own fyId — prefix only).
    ['inventory-search'],
    // The shared analytics fold (+ acquisition timeline) and derived notices.
    ['analytics'],
    ['notices'],
  ])
}

/** A sale was created / edited / cancelled / deleted. */
export function invalidateSales(fyId?: string): Promise<void> {
  return invalidate([
    ['sales-page', fyId].filter((k) => k !== undefined),
    ['sale-detail'],
    ['party-sales'],
    ['parties-ledger', fyId].filter((k) => k !== undefined),
    ['payments-page', fyId].filter((k) => k !== undefined),
    ['exchange-page', fyId].filter((k) => k !== undefined),
    ['accounts-page', fyId].filter((k) => k !== undefined),
    ['account-history'],
    ['analytics'],
    ['notices'],
  ])
}

/** A purchase was created / paid / cancelled. */
export function invalidatePurchases(fyId?: string): Promise<void> {
  return invalidate([
    ['purchases-page', fyId].filter((k) => k !== undefined),
    ['purchase-detail'],
    ['party-purchases'],
    ['parties-ledger', fyId].filter((k) => k !== undefined),
    ['payments-page', fyId].filter((k) => k !== undefined),
    ['accounts-page', fyId].filter((k) => k !== undefined),
    ['account-history'],
    ['analytics'],
    ['notices'],
  ])
}

/** A proforma was created / converted. */
export function invalidateProformas(fyId?: string): Promise<void> {
  return invalidate([
    ['proformas-page', fyId].filter((k) => k !== undefined),
    ['proforma-detail'],
    ['analytics'],
    ['notices'],
  ])
}

/** Account money movement (payments, add funds, transfers, cancels). */
export function invalidateAccountMoney(fyId?: string): Promise<void> {
  return invalidate([
    ['accounts-page', fyId].filter((k) => k !== undefined),
    ['account-history'],
    ['analytics'],
    ['notices'],
    ['payments-page', fyId].filter((k) => k !== undefined),
  ])
}

/** WhatsApp message settings row changed. */
export function invalidateWhatsAppState(): Promise<void> {
  return invalidate([['whatsapp-settings']])
}

/** A party's documents changed (upload via trade-in, replace, archive). */
export function invalidatePartyDocuments(partyId?: string): Promise<void> {
  return invalidate([
    ['party-documents', partyId].filter((k) => k !== undefined),
  ])
}
