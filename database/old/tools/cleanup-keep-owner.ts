/**
 * TEST Supabase cleanup — keep ONLY the main account + store
 * (owner@fusionone.test / FUSION GADGETS with its seeded data) and delete
 * every other user, store, and their data.
 *
 * Usage:
 *   bun cleanup-keep-owner.ts --dry-run   (report only, no changes)
 *   bun cleanup-keep-owner.ts --execute   (perform the cleanup)
 *
 * Keep set (deterministic): the owner auth user, the seeded store
 * (FUSION GADGETS), the two seeded financial years (2025-26, 2026-27),
 * the three seeded bank accounts (aa…010/011/012), the six seeded parties
 * (aa…030-035), and the owner's whatsapp_settings row.
 * Everything else (other auth users, other stores, other FYs + their
 * business data, other bank accounts/parties when unreferenced, their
 * storage assets) is deleted.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(HERE, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
const DRY = process.argv.includes('--dry-run')
const EXECUTE = process.argv.includes('--execute')
if (!DRY && !EXECUTE) {
  console.error('Pass --dry-run or --execute')
  process.exit(1)
}

// ── The keep set (verified against the deterministic seed) ──────────────────
const KEEP_OWNER_EMAIL = 'owner@fusionone.test'
const KEEP_STORE_ID = 'aa000000-0000-4000-8000-000000000003' // FUSION GADGETS
const KEEP_FY_IDS = [
  'aa000000-0000-4000-8000-000000000001', // FY 2026-27 (active)
  'aa000000-0000-4000-8000-000000000002', // FY 2025-26 (closed)
]
const KEEP_BANK_IDS = [
  'aa000000-0000-4000-8000-000000000010', // Cash
  'aa000000-0000-4000-8000-000000000011', // HDFC Current Account
  'aa000000-0000-4000-8000-000000000012', // SBI Savings
]
const KEEP_PARTY_IDS = [
  'aa000000-0000-4000-8000-000000000030', // Rahul Sharma
  'aa000000-0000-4000-8000-000000000031', // Priya Verma
  'aa000000-0000-4000-8000-000000000032', // Aman Khan
  'aa000000-0000-4000-8000-000000000033', // MobileHub Distribution
  'aa000000-0000-4000-8000-000000000034', // Galaxy Traders
  'aa000000-0000-4000-8000-000000000035', // Sunita Devi
]

const idList = (ids: string[]) => ids.map((i) => `'${i}'`).join(',')

// ── Preflight: verify the keep set actually exists ───────────────────────────
const owner = await sql`SELECT id, email FROM auth.users WHERE email = ${KEEP_OWNER_EMAIL}`
if (owner.length !== 1) throw new Error(`Owner user not found: ${KEEP_OWNER_EMAIL}`)
const KEEP_USER_ID = owner[0].id
const keepStore = await sql`SELECT id, name FROM store WHERE id = ${KEEP_STORE_ID} AND owner_user_id = ${KEEP_USER_ID}`
if (keepStore.length !== 1) throw new Error(`Keep store not found or not owned by owner: ${KEEP_STORE_ID}`)
const keepFys = await sql.unsafe(`SELECT count(*)::int AS n FROM financial_years WHERE id IN (${idList(KEEP_FY_IDS)})`)
if (keepFys[0].n !== 2) throw new Error(`Expected 2 keep FYs, found ${keepFys[0].n}`)
console.log(`[preflight] keep set verified: owner=${KEEP_OWNER_EMAIL} (${KEEP_USER_ID}), store="${keepStore[0].name}", 2 FYs, 3 banks, 6 parties`)

// ── Identify the delete set ──────────────────────────────────────────────────
const delUsers = await sql`SELECT id, email FROM auth.users WHERE id <> ${KEEP_USER_ID}`
const delStores = await sql`SELECT id, name, owner_user_id FROM store WHERE id <> ${KEEP_STORE_ID}`
const delFys = await sql.unsafe(`SELECT id, start_date, end_date FROM financial_years WHERE id NOT IN (${idList(KEEP_FY_IDS)})`)
const delBanks = await sql.unsafe(`SELECT id, name FROM bank_accounts WHERE id NOT IN (${idList(KEEP_BANK_IDS)})`)
const delParties = await sql.unsafe(`SELECT id, name FROM parties WHERE id NOT IN (${idList(KEEP_PARTY_IDS)})`)

console.log(`\n[to delete] auth users: ${delUsers.map((u) => u.email).join(', ') || 'none'}`)
console.log(`[to delete] stores: ${delStores.map((s) => `${s.name}(${s.id.slice(0, 8)})`).join(', ') || 'none'}`)
console.log(`[to delete] FYs: ${delFys.map((f) => `${f.start_date}→${f.end_date}`).join(', ') || 'none'}`)
console.log(`[to delete] bank accounts: ${delBanks.map((b) => b.name).join(', ') || 'none'}`)
console.log(`[to delete] parties: ${delParties.map((p) => p.name).join(', ') || 'none'}`)

if (delUsers.some((u) => u.id === KEEP_USER_ID)) throw new Error('SAFETY: owner in delete set')
if (delStores.some((s) => s.id === KEEP_STORE_ID)) throw new Error('SAFETY: keep store in delete set')
if (delFys.some((f) => KEEP_FY_IDS.includes(f.id))) throw new Error('SAFETY: keep FY in delete set')

// ── Reference checks: KEPT data must not reference DELETE-set shared rows ────
const delBankIds = delBanks.map((b) => b.id)
const delPartyIds = delParties.map((p) => p.id)
if (delBankIds.length > 0) {
  const refByKept = await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM sales WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND bank_account_id IN (${idList(delBankIds)})) AS s,
      (SELECT count(*)::int FROM purchases WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND bank_account_id IN (${idList(delBankIds)})) AS p,
      (SELECT count(*)::int FROM payments_in WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND bank_account_id IN (${idList(delBankIds)})) AS pi,
      (SELECT count(*)::int FROM payments_out WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND bank_account_id IN (${idList(delBankIds)})) AS po,
      (SELECT count(*)::int FROM account_transactions WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND bank_account_id IN (${idList(delBankIds)})) AS at`)
  const total = Object.values(refByKept[0] as Record<string, number>).reduce((a, b) => a + b, 0)
  if (total > 0) throw new Error(`SAFETY: kept-FY data references ${total} delete-set bank accounts — aborting`)
}
if (delPartyIds.length > 0) {
  const refByKept = await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM sales WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND party_id IN (${idList(delPartyIds)})) AS s,
      (SELECT count(*)::int FROM purchases WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND party_id IN (${idList(delPartyIds)})) AS p,
      (SELECT count(*)::int FROM payments_in WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND party_id IN (${idList(delPartyIds)})) AS pi,
      (SELECT count(*)::int FROM payments_out WHERE financial_year_id IN (${idList(KEEP_FY_IDS)}) AND party_id IN (${idList(delPartyIds)})) AS po`)
  const total = Object.values(refByKept[0] as Record<string, number>).reduce((a, b) => a + b, 0)
  if (total > 0) throw new Error(`SAFETY: kept-FY data references ${total} delete-set parties — aborting`)
}
console.log('\n[checks] kept-FY data references no delete-set banks/parties ✓')

// ── Report FY-scoped data that will be removed ───────────────────────────────
if (delFys.length > 0) {
  const fids = idList(delFys.map((f) => f.id))
  const counts = await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM inventory_items WHERE financial_year_id IN (${fids})) AS inv,
      (SELECT count(*)::int FROM sales WHERE financial_year_id IN (${fids})) AS sales,
      (SELECT count(*)::int FROM purchases WHERE financial_year_id IN (${fids})) AS purch,
      (SELECT count(*)::int FROM proforma_invoices WHERE financial_year_id IN (${fids})) AS prof,
      (SELECT count(*)::int FROM account_transactions WHERE financial_year_id IN (${fids})) AS atx,
      (SELECT count(*)::int FROM account_fund_entries WHERE financial_year_id IN (${fids})) AS fund,
      (SELECT count(*)::int FROM account_transfers WHERE financial_year_id IN (${fids})) AS trf`)
  console.log(`[to delete] FY-scoped data: ${JSON.stringify(counts[0])}`)
  const waSettings = delUsers.length > 0
    ? await sql.unsafe(`SELECT count(*)::int AS n FROM whatsapp_settings WHERE owner_user_id IN (${idList(delUsers.map((u) => u.id))})`)
    : [{ n: 0 }]
  console.log(`[to delete] whatsapp_settings rows: ${waSettings[0].n}`)
}

if (DRY) {
  console.log('\n[DRY RUN] no changes made. Re-run with --execute to apply.')
  await sql.end()
  process.exit(0)
}

// ══════════════════════════ EXECUTE ═════════════════════════════════════════
console.log('\n[execute] starting cleanup...')

await sql.begin(async (tx) => {
  if (delFys.length > 0) {
    const fids = idList(delFys.map((f) => f.id))
    // 1. Stores BEFORE their referenced FYs (store.active_financial_year_id → FY)
    if (delStores.length > 0) {
      const n = await tx.unsafe(`DELETE FROM store WHERE id IN (${idList(delStores.map((s) => s.id))})`)
      console.log(`[execute] stores deleted: ${n.count}`)
    }
    // 2. FY-scoped business data (FK-safe order)
    await tx.unsafe(`
      DELETE FROM account_transactions WHERE financial_year_id IN (${fids});
      DELETE FROM account_fund_entries WHERE financial_year_id IN (${fids});
      DELETE FROM account_transfers WHERE financial_year_id IN (${fids});
      DELETE FROM payments_in WHERE financial_year_id IN (${fids});
      DELETE FROM payments_out WHERE financial_year_id IN (${fids});
      DELETE FROM trade_ins WHERE sale_id IN (SELECT id FROM sales WHERE financial_year_id IN (${fids}));
      DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE financial_year_id IN (${fids}));
      DELETE FROM sales WHERE financial_year_id IN (${fids});
      DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE financial_year_id IN (${fids}));
      DELETE FROM purchases WHERE financial_year_id IN (${fids});
      DELETE FROM proforma_invoice_items WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE financial_year_id IN (${fids}));
      DELETE FROM proforma_trade_ins WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE financial_year_id IN (${fids}));
      DELETE FROM proforma_invoices WHERE financial_year_id IN (${fids});
      DELETE FROM trade_ins WHERE new_inventory_item_id IN (SELECT id FROM inventory_items WHERE financial_year_id IN (${fids}));
      DELETE FROM inventory_items WHERE origin_inventory_item_id IN (SELECT id FROM inventory_items WHERE financial_year_id IN (${fids}));
      DELETE FROM inventory_items WHERE financial_year_id IN (${fids});
      DELETE FROM financial_years WHERE id IN (${fids});`)
    console.log('[execute] FY-scoped business data + FYs deleted')
  } else if (delStores.length > 0) {
    const n = await tx.unsafe(`DELETE FROM store WHERE id IN (${idList(delStores.map((s) => s.id))})`)
    console.log(`[execute] stores deleted: ${n.count}`)
  }

  // 3. Non-seeded bank accounts (+ their payment modes) — unreferenced by kept data
  if (delBankIds.length > 0) {
    const n = await tx.unsafe(`
      DELETE FROM payment_modes WHERE bank_account_id IN (${idList(delBankIds)});
      DELETE FROM bank_accounts WHERE id IN (${idList(delBankIds)});`)
    console.log(`[execute] bank accounts deleted: ${delBankIds.length}`)
  }

  // 4. Non-seeded parties
  if (delPartyIds.length > 0) {
    await tx.unsafe(`DELETE FROM parties WHERE id IN (${idList(delPartyIds)})`)
    console.log(`[execute] parties deleted: ${delPartyIds.length}`)
  }

  // 5. whatsapp_settings of deleted users (FK → auth.users; must go first)
  if (delUsers.length > 0) {
    const n = await tx.unsafe(`DELETE FROM whatsapp_settings WHERE owner_user_id IN (${idList(delUsers.map((u) => u.id))})`)
    console.log(`[execute] whatsapp_settings deleted: ${n.count}`)
  }
})

// 6. Storage assets of deleted users (admin REST — outside the SQL tx)
const SUPA_URL = env.TEST_SUPABASE_URL
const SECRET = env.TEST_SUPABASE_SECRET_KEY
for (const u of delUsers) {
  const listRes = await fetch(`${SUPA_URL}/storage/v1/object/list/store_assets`, {
    method: 'POST',
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  })
  if (!listRes.ok) throw new Error(`storage list failed: ${listRes.status}`)
  const objects = (await listRes.json()) as Array<{ name: string }>
  const theirs = objects.filter((o) => o.name.startsWith(u.id))
  if (theirs.length > 0) {
    const delRes = await fetch(`${SUPA_URL}/storage/v1/object/store_assets`, {
      method: 'DELETE',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: theirs.map((o) => o.name) }),
    })
    console.log(`[execute] storage objects for ${u.email}: ${theirs.length} → delete ${delRes.status}`)
  } else {
    console.log(`[execute] storage objects for ${u.email}: none`)
  }
}

// 7. Auth users via the admin API (cascades auth-schema rows)
for (const u of delUsers) {
  const res = await fetch(`${SUPA_URL}/auth/v1/admin/users/${u.id}`, {
    method: 'DELETE',
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  })
  console.log(`[execute] auth user ${u.email}: delete → ${res.status} ${res.ok ? 'OK' : await res.text()}`)
}

// ── Final verification ────────────────────────────────────────────────────────
console.log('\n=== FINAL STATE ===')
const users2 = await sql`SELECT email FROM auth.users ORDER BY created_at`
console.log(`auth users (${users2.length}): ${users2.map((u) => u.email).join(', ')}`)
const stores2 = await sql`SELECT name, owner_user_id FROM store`
console.log(`stores (${stores2.length}): ${stores2.map((s) => s.name).join(', ')}`)
const fys2 = await sql`SELECT start_date, end_date, status FROM financial_years ORDER BY start_date`
console.log(`FYs (${fys2.length}): ${fys2.map((f) => `${f.start_date.toISOString().slice(0, 10)}→${f.end_date.toISOString().slice(0, 10)} (${f.status})`).join(', ')}`)
const banks2 = await sql`SELECT name FROM bank_accounts ORDER BY created_at`
console.log(`bank accounts (${banks2.length}): ${banks2.map((b) => b.name).join(', ')}`)
const parties2 = await sql`SELECT name FROM parties ORDER BY created_at`
console.log(`parties (${parties2.length}): ${parties2.map((p) => p.name).join(', ')}`)
const wa2 = await sql`SELECT u.email FROM whatsapp_settings w JOIN auth.users u ON u.id = w.owner_user_id`
console.log(`whatsapp_settings: ${wa2.map((w) => w.email).join(', ')}`)
const data2 = await sql`
  SELECT
    (SELECT count(*)::int FROM inventory_items) AS inv,
    (SELECT count(*)::int FROM sales) AS sales,
    (SELECT count(*)::int FROM purchases) AS purchases,
    (SELECT count(*)::int FROM proforma_invoices) AS proformas,
    (SELECT count(*)::int FROM payments_in) AS pay_in,
    (SELECT count(*)::int FROM payments_out) AS pay_out,
    (SELECT count(*)::int FROM account_transactions) AS acct_tx,
    (SELECT count(*)::int FROM account_fund_entries) AS fund,
    (SELECT count(*)::int FROM account_transfers) AS transfers`
console.log(`business rows: ${JSON.stringify(data2[0])}`)
const storeOk = await sql`
  SELECT s.onboarding_complete, s.active_financial_year_id IS NOT NULL AS has_active_fy, s.name
  FROM store WHERE id = ${KEEP_STORE_ID}`
console.log(`keep store intact: ${JSON.stringify(storeOk[0])}`)

await sql.end()
console.log('\nDONE — TEST Supabase now contains only the main account + store.')
