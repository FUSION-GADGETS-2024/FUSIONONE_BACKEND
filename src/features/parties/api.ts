import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear, Party } from '@/features/types'

export const partyKeys = {
  all: ['parties'] as const,
  ledger: (fyId: string) => ['parties-ledger', fyId] as const,
  /** One party's profile (the /parties/:id detail header). */
  detail: (partyId: string) => ['party-detail', partyId] as const,
  /** Searchable, paginated directory for the party combobox — one page of
   *  (id, name, number) per request, optionally filtered by search text.
   *  Lives under the ['parties'] prefix so invalidateParties() covers it. */
  options: (q: string) => ['parties', 'options', q] as const,
  /** One party's (id, name, number) — resolves a selected id to a label. */
  option: (partyId: string) => ['parties', 'option', partyId] as const,
  /** One party's accumulated sales list — scoped by party and working FY
   *  (the prefix ['party-sales'] stays covered by invalidateSales). */
  sales: (partyId: string, fyId: string) => ['party-sales', partyId, fyId] as const,
  /** One party's accumulated purchases list — scoped by party and working FY
   *  (the prefix ['party-purchases'] stays covered by invalidatePurchases). */
  purchases: (partyId: string, fyId: string) => ['party-purchases', partyId, fyId] as const,
}

/**
 * The single cached parties directory — shared by the parties page and every
 * form dropdown (replaces the reference app's separate form-dropdown fetch).
 */
export function useParties() {
  return useQuery({
    queryKey: partyKeys.all,
    queryFn: async (): Promise<Party[]> => {
      const { data, error } = await supabase.from('parties').select('*').order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as Party[]
    },
  })
}

/** FY-scoped sales/purchases totals per party (the ledger fold inputs). */
export function usePartiesLedger(selectedYear: FinancialYear | null, fyLoading: boolean) {
  return useQuery({
    queryKey: partyKeys.ledger(selectedYear?.id ?? ''),
    enabled: !fyLoading && !!selectedYear,
    queryFn: async () => {
      if (!selectedYear) return { sales: [], purchases: [] }
      const [
        { data: sData, error: sErr },
        { data: puData, error: puErr },
      ] = await Promise.all([
        supabase
          .from('sales')
          .select('party_id, final_total, due')
          .eq('financial_year_id', selectedYear.id)
          .eq('status', 'active'),
        supabase
          .from('purchases')
          .select('party_id, total, due')
          .eq('financial_year_id', selectedYear.id)
          .eq('status', 'active'),
      ])
      if (sErr) throw sErr
      if (puErr) throw puErr
      return { sales: sData ?? [], purchases: puData ?? [] }
    },
  })
}

// ── Party combobox directory (searchable + paginated) ─────────────────────

/** Only the fields the combobox needs: display, search, identification. */
export interface PartyOptionRow {
  id: string
  name: string
  number: string | null
}

/** Page size for the combobox directory (a comfortable dropdown viewport). */
export const PARTY_OPTIONS_PAGE_SIZE = 20

/** The RPC search result row (public.search_parties, migration 0012). */
interface PartySearchRpcRow {
  id: string
  name: string
  number: string | null
  address: string | null
  rank: number
  total_count: number
}

/**
 * ONE bounded, RANKED, server-side party search page — the canonical
 * search_parties RPC (phone-canonical, space-normalized, tiered
 * relevance: exact phone > name > tokens > substring > fuzzy). Replaces
 * the previous PostgREST `.or(name.ilike, number.ilike)` filter, which
 * could not match a party stored as +91XXXXXXXXXX from a bare 10-digit
 * query. Empty query = browse mode (name-ordered directory).
 */
async function fetchPartyOptionsPage(q: string, page: number): Promise<{ rows: PartyOptionRow[]; count: number }> {
  const { data, error } = await supabase.rpc('search_parties', {
    p_query: q,
    p_limit: PARTY_OPTIONS_PAGE_SIZE,
    p_offset: page * PARTY_OPTIONS_PAGE_SIZE,
  })
  if (error) throw error
  const rows = (data ?? []) as PartySearchRpcRow[]
  // total_count is reported on every row (0 when the page is empty).
  const count = rows.length > 0 ? rows[0].total_count : 0
  return {
    rows: rows.map(r => ({ id: r.id, name: r.name, number: r.number })),
    count,
  }
}

/**
 * The party combobox directory — ONE bounded database page per request
 * (ranked RPC search + exact total count), searched server-side with the
 * canonical phone-canonical, space-normalized ranking.
 *   - each fetchNextPage() asks the database for exactly the NEXT batch
 *     (never the whole table);
 *   - `placeholderData` keeps the previous results on screen while a new
 *     search loads, so typing never flickers.
 */
export function usePartyOptions(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: partyKeys.options(q),
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchPartyOptionsPage(q, pageParam as number),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((total, page) => total + page.rows.length, 0)
      return loaded < lastPage.count ? allPages.length : undefined
    },
    placeholderData: previous => previous,
    staleTime: 30_000,
  })
}

// ── Parties page directory search (the list page's search box) ────────────

/** A ranked directory-search result (full display shape for the page). */
export interface PartyDirectoryRow {
  id: string
  name: string
  number: string | null
  address: string | null
}

/** Directory page size for the parties list search. */
export const PARTY_DIRECTORY_SEARCH_LIMIT = 50

/**
 * The parties PAGE search — the same canonical search_parties RPC as the
 * combobox (one search implementation), returning up to 50 ranked rows.
 * Empty query → the full cached directory (useParties) is used instead;
 * the hook is enabled only while a query is present.
 */
export function usePartyDirectorySearch(query: string, enabled = true) {
  const trimmed = query.trim()
  return useQuery({
    queryKey: ['parties', 'directory-search', trimmed],
    enabled: enabled && trimmed !== '',
    staleTime: 30_000,
    placeholderData: previous => previous,
    queryFn: async (): Promise<PartyDirectoryRow[]> => {
      const { data, error } = await supabase.rpc('search_parties', {
        p_query: trimmed,
        p_limit: PARTY_DIRECTORY_SEARCH_LIMIT,
        p_offset: 0,
      })
      if (error) throw error
      return (data ?? []) as PartyDirectoryRow[]
    },
  })
}

/** Resolve a selected party id to its (id, name, number) for display. */
export function usePartyOption(partyId: string | undefined) {
  return useQuery({
    queryKey: partyKeys.option(partyId ?? ''),
    enabled: !!partyId,
    staleTime: 60_000,
    queryFn: async (): Promise<PartyOptionRow | null> => {
      const { data, error } = await supabase
        .from('parties')
        .select('id, name, number')
        .eq('id', partyId!)
        .maybeSingle()
      if (error) throw error
      return (data as PartyOptionRow | null) ?? null
    },
  })
}

// ── Party detail (the /parties/:id read layer) ──────────────────────────────

/** Page size for the party detail invoice lists (matches the app's list density). */
export const PARTY_PAGE_SIZE = 10

/** One party's profile row (the /parties/:id header). */
export function usePartyDetail(partyId: string) {
  return useQuery({
    queryKey: partyKeys.detail(partyId),
    queryFn: async (): Promise<Party | null> => {
      const { data, error } = await supabase
        .from('parties')
        .select('*')
        .eq('id', partyId)
        .maybeSingle()
      if (error) throw error
      return (data as Party | null) ?? null
    },
  })
}

/**
 * Lean per-page row shapes — only the columns the party detail lists render.
 * (The list pages own the fuller row types; this is a read view over the
 * same business data, not a second copy of it.)
 */
export interface PartySaleRow {
  id: string
  bill_number: string
  date: string
  final_total: number
  due: number
  status: 'active' | 'cancelled'
}

export interface PartyPurchaseRow {
  id: string
  bill_number: string
  date: string
  total: number
  due: number
  status: 'active' | 'cancelled'
}

/** One page of invoices plus the database's exact total for the query scope. */
export interface PartyInvoicePageResult<T> {
  rows: T[]
  count: number
}

/**
 * ONE batch of a party's invoices — paginated AT THE DATABASE, never in
 * React. The query asks PostgREST for exactly one page via range(offset,
 * offset + size - 1) and receives the exact total via { count: 'exact' } in
 * the same round trip — the browser never loads more than the batches it
 * has actually scrolled through. Order matches the working list pages
 * (date desc) with a unique tiebreaker (bill_number desc) so paging is
 * deterministic across batch boundaries.
 */
async function fetchPartyInvoicePage(
  kind: 'sales' | 'purchases',
  partyId: string,
  fyId: string,
  page: number,
): Promise<PartyInvoicePageResult<PartySaleRow | PartyPurchaseRow>> {
  const from = page * PARTY_PAGE_SIZE
  const request =
    kind === 'sales'
      ? supabase
          .from('sales')
          .select('id, bill_number, date, final_total, due, status', { count: 'exact' })
          .eq('party_id', partyId)
          .eq('financial_year_id', fyId)
          .order('date', { ascending: false })
          .order('bill_number', { ascending: false })
          .range(from, from + PARTY_PAGE_SIZE - 1)
      : supabase
          .from('purchases')
          .select('id, bill_number, date, total, due, status', { count: 'exact' })
          .eq('party_id', partyId)
          .eq('financial_year_id', fyId)
          .order('date', { ascending: false })
          .order('bill_number', { ascending: false })
          .range(from, from + PARTY_PAGE_SIZE - 1)
  const { data, error, count } = await request
  if (error) throw error
  return {
    rows: (data ?? []) as unknown as (PartySaleRow | PartyPurchaseRow)[],
    count: count ?? 0,
  }
}

/**
 * A party's invoices as a scroll-to-load-more list — the SAME bounded
 * database fetch as before (one PARTY_PAGE_SIZE page per request, exact
 * count), accumulated by TanStack Query's infinite query:
 *
 *   - each fetchNextPage() asks the database for exactly the NEXT batch
 *     (never the whole table);
 *   - the accumulated batches live under ONE query key per (party, FY), so
 *     navigating to an invoice and coming back restores every loaded batch
 *     from the cache (and the existing invalidateSales/invalidatePurchases
 *     prefix invalidation keeps it fresh after mutations);
 *   - the next-batch cursor is derived from the database's exact count, so
 *     loading stops precisely at the end of the data.
 *
 * `enabled` gates the inactive tab — switching tabs uses the cached batches
 * of the other list without refetching them.
 */
export function usePartyInvoices(
  kind: 'sales' | 'purchases',
  partyId: string,
  selectedYear: FinancialYear | null,
  fyLoading: boolean,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey:
      kind === 'sales'
        ? partyKeys.sales(partyId, selectedYear?.id ?? '')
        : partyKeys.purchases(partyId, selectedYear?.id ?? ''),
    enabled: enabled && !fyLoading && !!selectedYear,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchPartyInvoicePage(kind, partyId, selectedYear!.id, pageParam as number),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((total, page) => total + page.rows.length, 0)
      return loaded < lastPage.count ? allPages.length : undefined
    },
  })
}
