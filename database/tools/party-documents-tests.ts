/**
 * FUSIONONE Party Documents architecture — database test suite.
 *
 * Covers the FINAL domain model (documents belong exclusively to parties):
 *   - party_documents creation (metadata columns, defaults, unique storage key)
 *   - party ownership of documents
 *   - archive behavior (row kept, status/archived_at, nothing deleted)
 *   - trade_ins has NO document relationship (column absent, direct insert
 *     with a document column rejected by the schema itself)
 *   - create_sale no longer accepts/uses trade-in document data (a
 *     document_id key in the payload is simply ignored — no validation,
 *     no persistence, no rejection)
 *   - cancel_sale no longer returns document data in resold[]
 *
 * Runs against the TEST Supabase project ONLY (never production).
 * Creates its own isolated fixtures (FY 2032-33 / parties / bank /
 * inventory) and removes them at the end. Exit code is non-zero when any
 * check fails.
 *
 * Usage (from database/tools):
 *   bun run party-documents-tests.ts   # uses TEST_SUPABASE_DB_URL from .env
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(): Record<string, string> {
  const raw = readFileSync(join(HERE, '.env'), 'utf8')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}

const env = loadEnv()
const DB_URL = process.env.FUSIONONE_DB_URL || env.TEST_SUPABASE_DB_URL
if (!DB_URL) throw new Error('Set FUSIONONE_DB_URL (or TEST_SUPABASE_DB_URL in database/tools/.env)')
if (!DB_URL.includes('egdrnhtmclvhsfjvhyam')) throw new Error('SAFETY ABORT: not the TEST project.')

const sql = postgres(DB_URL, { max: 4, prepare: false, idle_timeout: 5 })

let failures = 0
let passes = 0
function ok(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    passes++
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`)
  }
}

async function rpc(fn: string, params: Record<string, unknown>): Promise<any> {
  const entries = Object.entries(params)
  const args = entries.map(([name], i) => `${name} := $${i + 1}`).join(', ')
  const rows = await sql.unsafe(
    `SELECT public.${fn}(${args}) AS result`, entries.map(([, v]) => v) as any,
  )
  return (rows as any[])[0]?.result
}

let imeiSeq = 760000000000010
const nextImei = () => String(imeiSeq++)

const FY_START = '2032-04-01'
const FY_END = '2033-03-31'
const PARTY_NAME = 'PDox Test Party'
const OTHER_PARTY_NAME = 'PDox Other Party'
const BANK_NAME = 'PDox Cash'

/** A synthetic-but-honest party_documents row. The id is application-
 *  generated (exactly like the backend service does — the storage key
 *  embeds it before the insert). The encryption material is opaque base64
 *  to the database — only the architecture invariants are under test
 *  here; the crypto itself has its own backend suite. */
async function mkDocument(partyId: string, name: string): Promise<string> {
  const id = randomUUID()
  await sql`
    INSERT INTO public.party_documents (
      id, party_id, file_name, mime_type, file_size, checksum_sha256, storage_key,
      encryption_alg, key_version, encrypted_dek, dek_iv, dek_tag, file_iv, file_tag
    ) VALUES (
      ${id}, ${partyId}, ${name}, 'application/pdf', 4321, ${'a'.repeat(64)},
      ${'party-documents/' + partyId + '/' + id},
      'AES-256-GCM', 1, 'ZGVr', 'aXY', 'dGFn', 'ZmlsZUlW', 'ZmlsZVRhZw=='
    )`
  return id
}

async function cleanupFixtures(fyIds: string[]): Promise<void> {
  if (fyIds.length === 0) return
  // All sales of the fixture FYs (their sale_items hold trade-in devices).
  const sales = await sql`SELECT id FROM public.sales WHERE financial_year_id IN ${sql(fyIds)}`
  // Trade-in devices BEFORE their trade_ins rows are removed.
  const tiDevices = await sql`SELECT DISTINCT t.inventory_item_id AS id
      FROM public.trade_ins t
     WHERE t.sale_id IN (SELECT id FROM public.sales WHERE financial_year_id IN ${sql(fyIds)})`
  for (const s of sales) {
    await sql`DELETE FROM public.account_transactions WHERE reference_id = ${s.id} AND reference_type IN ('sale', 'sale_cancelled')`
    await sql`DELETE FROM public.payments_in WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.trade_ins WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.sale_items WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.sales WHERE id = ${s.id}`
  }
  for (const t of tiDevices) {
    if (!t.id) continue
    await sql`DELETE FROM public.purchase_items WHERE inventory_item_id = ${t.id}`
    await sql`DELETE FROM public.inventory_items WHERE id = ${t.id}`
  }
  await sql`DELETE FROM public.account_transactions WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.payments_in WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.purchase_items WHERE purchase_id IN (SELECT id FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)})`
  await sql`DELETE FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.party_documents WHERE party_id IN (
    SELECT id FROM public.parties WHERE name IN (${PARTY_NAME}, ${OTHER_PARTY_NAME}))`
  await sql`DELETE FROM public.financial_years WHERE id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.bank_accounts WHERE name = ${BANK_NAME}`
  await sql`DELETE FROM public.parties WHERE name IN (${PARTY_NAME}, ${OTHER_PARTY_NAME})`
}

async function main() {
  console.log('\n═══ FUSIONONE Party Documents DB suite (final architecture) ═══\n')

  // Pre-cleanup for re-runnability (a prior crashed run leaves fixtures).
  {
    const staleFys = await sql`SELECT id FROM public.financial_years WHERE start_date = ${FY_START}`
    if (staleFys.length > 0) {
      console.log(`  (pre-cleanup: removing ${staleFys.length} stale fixture FYs from a prior run)`)
      await cleanupFixtures(staleFys.map((r: any) => r.id))
    }
    // Orphan document rows from a prior crashed run (no FK holders left).
    await sql`DELETE FROM public.party_documents WHERE party_id IN (
      SELECT id FROM public.parties WHERE name IN (${PARTY_NAME}, ${OTHER_PARTY_NAME}))`
  }

  // ── Fixtures ────────────────────────────────────────────────────────────
  const fy = await sql`INSERT INTO public.financial_years (start_date, end_date, status)
    VALUES (${FY_START}, ${FY_END}, 'active') RETURNING id`.then((r) => r[0].id as string)
  const party = await sql`INSERT INTO public.parties (name, number)
    VALUES (${PARTY_NAME}, '919999001101') RETURNING id`.then((r) => r[0].id as string)
  const otherParty = await sql`INSERT INTO public.parties (name, number)
    VALUES (${OTHER_PARTY_NAME}, '919999001102') RETURNING id`.then((r) => r[0].id as string)
  const bank = await sql`INSERT INTO public.bank_accounts (name, is_cash)
    VALUES (${BANK_NAME}, true) RETURNING id`.then((r) => r[0].id as string)

  const mkItem = (rate: number) =>
    sql`INSERT INTO public.inventory_items
          (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
        VALUES ('PDOX', 'DocPhone', ${nextImei()}, '8/128', 'Black', ${rate - 1000}, ${rate}, 'in_stock', 'purchase', ${fy}, 'direct')
        RETURNING id`.then((r) => r[0].id as string)

  const deviceA = await mkItem(20000) // C: sale with document data in payload
  const deviceB = await mkItem(25000) // C: plain sale
  const deviceC = await mkItem(15000) // E: ignored-document probes
  const deviceF = await mkItem(16000) // F origin sale (resold test)

  const salePayload = (over: Record<string, unknown>) => ({
    party_id: party,
    date: '2032-06-15',
    discount: 0,
    paid: 0,
    bank_account_id: bank,
    payment_mode_id: null,
    financial_year_id: fy,
    items: [],
    trade_ins: [],
    ...over,
  })
  const tradeIn = (over: Partial<Record<string, unknown>> = {}) => ({
    brand: 'PDOX OldPhone', model: 'X1', imei: nextImei(), ram_rom: '6/64', color: 'White',
    credit_value: 5000, mrp: 9000, ...over,
  })

  console.log('── A. party_documents entity remains fully functional ──')
  {
    const docId = await mkDocument(party, 'id-card.pdf')
    const row = await sql`SELECT * FROM public.party_documents WHERE id = ${docId}`.then((r) => r[0])
    ok(!!row, 'document row created')
    ok(row.party_id === party, 'party ownership column')
    ok(row.file_name === 'id-card.pdf' && row.mime_type === 'application/pdf' && Number(row.file_size) === 4321, 'filename/mime/size metadata persisted')
    ok(row.checksum_sha256 === 'a'.repeat(64), 'checksum column persisted')
    ok(row.storage_key === `party-documents/${party}/${docId}`, 'storage key encodes party/document relationship')
    ok(row.encryption_alg === 'AES-256-GCM' && Number(row.key_version) === 1, 'encryption metadata + key version persisted')
    ok(row.encrypted_dek !== null && row.dek_iv !== null && row.dek_tag !== null && row.file_iv !== null && row.file_tag !== null, 'envelope material columns persisted')
    ok(row.status === 'active' && row.archived_at === null, 'default lifecycle = active')
    ok(row.created_at !== null, 'created_at default')

    // Unique storage key.
    let dupKeyRejected = false
    try {
      await sql`INSERT INTO public.party_documents (party_id, file_name, mime_type, file_size, checksum_sha256, storage_key, encrypted_dek, dek_iv, dek_tag, file_iv, file_tag)
        VALUES (${party}, 'dup.pdf', 'application/pdf', 1, 'x', ${row.storage_key}, 'a', 'b', 'c', 'd', 'e')`
    } catch {
      dupKeyRejected = true
    }
    ok(dupKeyRejected, 'duplicate storage key rejected (unique constraint)')

    // Archive semantics: row kept, status/archived_at set, nothing deleted.
    await sql`UPDATE public.party_documents SET status = 'archived', archived_at = now()
      WHERE id = ${docId}`
    const archivedRow = await sql`SELECT status, archived_at FROM public.party_documents WHERE id = ${docId}`.then((r) => r[0])
    ok(archivedRow.status === 'archived' && archivedRow.archived_at !== null, 'archived: status + archived_at set, row kept')
  }

  console.log('── B. trade_ins has NO document relationship ──')
  {
    const tiCols = await sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='trade_ins'`
    const names = tiCols.map((c) => c.column_name)
    ok(!names.includes('document_id'), 'trade_ins.document_id is absent')
    ok(!names.some((n) => n.startsWith('document')), 'no document column of any kind on trade_ins')

    // A direct insert naming a document column is rejected by the schema.
    let probeSale: string | null = null
    let probeItem: string | null = null
    let schemaRejected = false
    try {
      probeSale = await sql`INSERT INTO public.sales (
        bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due,
        bank_account_id, date, financial_year_id, status
      ) VALUES ('PD-TEST-1', ${party}, 1, 0, 0, 1, 0, 1, ${bank}, '2032-06-15', ${fy}, 'active') RETURNING id`.then((r) => r[0].id as string)
      probeItem = await sql`INSERT INTO public.inventory_items (
        brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type
      ) VALUES ('PDOX', 'Probe', ${nextImei()}, '6/64', 'White', 1, 1, 'in_stock', 'trade_in', ${fy}, 'direct') RETURNING id`.then((r) => r[0].id as string)
      await sql`INSERT INTO public.trade_ins (sale_id, inventory_item_id, credit_value, document_id)
        VALUES (${probeSale}, ${probeItem}, 1, '33333333-3333-3333-3333-333333333333')`
    } catch {
      schemaRejected = true
    }
    ok(schemaRejected, 'direct trade_ins insert with a document column is rejected by the schema')
    if (probeItem) await sql`DELETE FROM public.inventory_items WHERE id = ${probeItem}`
    if (probeSale) await sql`DELETE FROM public.sales WHERE id = ${probeSale}`
  }

  console.log('── C. create_sale no longer uses trade-in document data ──')
  {
    // A document_id key present in the payload is simply ignored: the
    // sale succeeds, nothing is validated, nothing is persisted.
    const otherDoc = await mkDocument(otherParty, 'other-party.pdf')
    const result = await rpc('create_sale', {
      payload: salePayload({
        items: [{ inventory_item_id: deviceA, sold_price: 20000 }],
        trade_ins: [tradeIn({ document_id: otherDoc })],
      }),
    })
    ok(!!result?.sale_id, 'sale with document_id in the trade-in payload succeeds (data ignored)')
    const tiCols = await sql`SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='trade_ins'`
    ok(!tiCols.some((c) => c.column_name === 'document_id'), 'created trade-in row has no document column to populate')
    await sql`SELECT public.delete_sale(p_sale_id := ${result.sale_id}::uuid) AS result`

    // A plain sale (no document concept at all) is unchanged.
    const plain = await rpc('create_sale', {
      payload: salePayload({ items: [{ inventory_item_id: deviceB, sold_price: 25000 }] }),
    })
    ok(!!plain?.sale_id, 'plain sale without any document data works')
    await sql`SELECT public.delete_sale(p_sale_id := ${plain.sale_id}::uuid) AS result`
  }

  console.log('── D. create_sale trade-in invariants remain intact ──')
  {
    // The device/transaction validation itself is untouched.
    let rejected = false
    try {
      await rpc('create_sale', {
        payload: salePayload({
          items: [{ inventory_item_id: deviceC, sold_price: 15000 }],
          trade_ins: [tradeIn({ imei: '123' })],
        }),
      })
    } catch (e: any) {
      rejected = String(e.message).includes('15 digits')
    }
    ok(rejected, 'trade-in IMEI validation still enforced')
  }

  console.log('── E. cancel_sale returns no document data ──')
  {
    const doc = await mkDocument(party, 'resale-doc.pdf')
    const origin = await rpc('create_sale', {
      payload: salePayload({
        items: [{ inventory_item_id: deviceF, sold_price: 16000 }],
        trade_ins: [tradeIn()],
      }),
    })
    const tiDevice = await sql`
      SELECT t.inventory_item_id AS id FROM public.trade_ins t WHERE t.sale_id = ${origin.sale_id}
      LIMIT 1`.then((r) => r[0].id as string)
    // Resell the trade-in device to the OTHER party.
    await rpc('create_sale', {
      payload: salePayload({
        party_id: otherParty,
        items: [{ inventory_item_id: tiDevice, sold_price: 6000 }],
      }),
    })
    const cancelled = await rpc('cancel_sale', { p_sale_id: origin.sale_id })
    ok(Array.isArray(cancelled.resold) && cancelled.resold.length === 1, 'resold[] has the one resold trade-in')
    ok(!('document_id' in cancelled.resold[0]), 'resold[] carries NO document field')
    ok(!Object.keys(cancelled.resold[0]).some((k) => k.includes('document')), 'resold[] carries no document data of any kind')
    // The party document itself is untouched by the cancellation.
    const docRow = await sql`SELECT status FROM public.party_documents WHERE id = ${doc}`.then((r) => r[0])
    ok(docRow.status === 'active', 'cancellation never deletes or archives a party document')
  }

  console.log('── F. final state + message_jobs safety ──')
  {
    const mj = await sql`SELECT count(*)::int AS n FROM public.message_jobs`.then((r) => r[0].n)
    ok(mj === 0, 'message_jobs remains 0 (WhatsApp untouched)')
  }

  // ── Teardown ────────────────────────────────────────────────────────────
  const fyRows = await sql`SELECT id FROM public.financial_years WHERE start_date = ${FY_START}`
  await cleanupFixtures(fyRows.map((r: any) => r.id))
  const leftovers = await sql`SELECT count(*)::int AS n FROM public.party_documents d
    JOIN public.parties p ON p.id = d.party_id WHERE p.name IN (${PARTY_NAME}, ${OTHER_PARTY_NAME})`.then((r) => r[0].n)
  ok(leftovers === 0, 'all document fixtures removed')

  await sql.end()
  console.log(`\n═══ Party Documents DB suite: ${passes} passed, ${failures} failed ═══\n`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    const fyRows = await sql`SELECT id FROM public.financial_years WHERE start_date = '2032-04-01'`
    if (fyRows.length > 0) await cleanupFixtures(fyRows.map((r: any) => r.id))
  } catch { /* best effort */ }
  await sql.end().catch(() => {})
  process.exit(1)
})
