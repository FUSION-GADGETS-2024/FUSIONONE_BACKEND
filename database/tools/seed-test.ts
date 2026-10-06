/**
 * FUSIONONE test-environment seed (TEST project ONLY).
 *
 * Provisions the minimum production-shaped state for end-to-end
 * verification of the delivery system:
 *   - the owner application user (owner@fusionone.test → user_type 'owner')
 *   - the store singleton (onboarding complete) + whatsapp_settings
 *   - an active financial year covering today
 *   - banking (cash account + UPI mode), a party with a phone number
 *   - two inventory items → one sale with an outstanding balance
 *     (paid 3,000 of 10,000 → due 7,000) so receipts AND reminders have a
 *     real document to work against
 *
 * Idempotent: re-running refreshes the sale/payment state instead of
 * duplicating (parties/items are matched by stable keys).
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
if (!DB_URL) throw new Error('Set FUSIONONE_DB_URL (or TEST_SUPABASE_DB_URL)')

const sql = postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

async function main() {
  // ── 1. Owner application user ───────────────────────────────────────────
  const authOwner = await sql`
    SELECT id FROM auth.users WHERE email = ${env.TEST_USER_EMAIL} LIMIT 1`.then((r) => r[0])
  if (!authOwner) throw new Error(`Auth user ${env.TEST_USER_EMAIL} missing — create it first (admin API)`)
  await sql`
    INSERT INTO public.users (id, user_type, status, display_name)
    VALUES (${authOwner.id}, 'owner', 'active', 'Test Owner')
    ON CONFLICT (id) DO UPDATE SET user_type = 'owner', status = 'active', display_name = 'Test Owner'`
  console.log('✓ owner provisioned:', env.TEST_USER_EMAIL)

  // ── 2. Financial year covering today ────────────────────────────────────
  const year = new Date().getFullYear()
  const fyStart = `${year}-04-01`
  const fyEnd = `${year + 1}-03-31`
  // Today might be before April — pick the FY window that contains today.
  const today = new Date().toISOString().slice(0, 10)
  const start = today < fyStart ? `${year - 1}-04-01` : fyStart
  const end = today < fyStart ? `${year}-03-31` : fyEnd
  const fy = await sql`
    INSERT INTO public.financial_years (start_date, end_date, status)
    VALUES (${start}, ${end}, 'active')
    ON CONFLICT DO NOTHING
    RETURNING id`.then((r) => r[0]?.id)
  const fyId =
    fy ??
    (await sql`SELECT id FROM public.financial_years WHERE start_date = ${start} LIMIT 1`.then((r) => r[0].id))
  console.log(`✓ financial year ${start}..${end}`)

  // ── 3. Store + WhatsApp settings ────────────────────────────────────────
  await sql`
    INSERT INTO public.store (name, address, phone, email, gstin, onboarding_complete, active_financial_year_id)
    VALUES ('FUSION GADGETS (TEST)', 'Shop 12, MG Road, Bahraich', '+91 98765 43210', 'hello@fusiongadgets.test', '', true, ${fyId})
    ON CONFLICT (singleton) DO UPDATE SET active_financial_year_id = ${fyId}, onboarding_complete = true`
  await sql`INSERT INTO public.whatsapp_settings (singleton, auto_send_sale) VALUES (1, true) ON CONFLICT (singleton) DO UPDATE SET auto_send_sale = true`
  console.log('✓ store + whatsapp_settings (auto_send_sale = true)')

  // ── 4. Banking ──────────────────────────────────────────────────────────
  const bank = await sql`
    INSERT INTO public.bank_accounts (name, is_cash) VALUES ('Test Cash Drawer', true)
    ON CONFLICT DO NOTHING RETURNING id`.then((r) => r[0]?.id)
  const bankId = bank ?? (await sql`SELECT id FROM public.bank_accounts WHERE name = 'Test Cash Drawer' LIMIT 1`.then((r) => r[0].id))
  const mode = await sql`
    INSERT INTO public.payment_modes (bank_account_id, name) VALUES (${bankId}, 'Test UPI')
    ON CONFLICT DO NOTHING RETURNING id`.then((r) => r[0]?.id)
  const modeId = mode ?? (await sql`SELECT id FROM public.payment_modes WHERE name = 'Test UPI' LIMIT 1`.then((r) => r[0].id))
  console.log('✓ banking (cash + UPI)')

  // ── 5. Party with a phone number ────────────────────────────────────────
  const party = await sql`
    INSERT INTO public.parties (name, number, address)
    VALUES ('Rahul Test Customer', '9876543210', '12 Test Lane, Lucknow')
    ON CONFLICT DO NOTHING RETURNING id`.then((r) => r[0]?.id)
  const partyId = party ?? (await sql`SELECT id FROM public.parties WHERE name = 'Rahul Test Customer' LIMIT 1`.then((r) => r[0].id))
  console.log('✓ party (with phone for WhatsApp delivery)')

  // ── 6. Inventory + a sale with an outstanding balance ───────────────────
  const imei = 'TESTSEED000001'
  let item = await sql`SELECT id FROM public.inventory_items WHERE imei = ${imei} LIMIT 1`.then((r) => r[0]?.id)
  if (!item) {
    item = await sql`
      INSERT INTO public.inventory_items (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id)
      VALUES ('Apple', 'iPhone 15', ${imei}, '8/256', 'Black', 61000, 70000, 'in_stock', 'purchase', ${fyId})
      RETURNING id`.then((r) => r[0].id)
  }

  const existingSale = await sql`
    SELECT s.id, s.due FROM public.sales s
     JOIN public.parties p ON p.id = s.party_id
     WHERE p.name = 'Rahul Test Customer' AND s.status = 'active'
     ORDER BY s.created_at DESC LIMIT 1`.then((r) => r[0])

  let saleId: string
  if (existingSale && Number(existingSale.due) > 0) {
    saleId = existingSale.id
    console.log('✓ existing sale with outstanding balance reused:', saleId)
  } else {
    const inStock = await sql`SELECT status FROM public.inventory_items WHERE id = ${item}`.then((r) => r[0]?.status)
    let itemId = item
    if (inStock !== 'in_stock') {
      // The seeded item was sold by a previous run — add a fresh one.
      itemId = await sql`
        INSERT INTO public.inventory_items (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id)
        VALUES ('Apple', 'iPhone 15', ${imei + Math.floor(Math.random() * 9000 + 1000)}, '8/256', 'Black', 61000, 70000, 'in_stock', 'purchase', ${fyId})
        RETURNING id`.then((r) => r[0].id)
    }
    const payload = {
      party_id: partyId,
      financial_year_id: fyId,
      date: today,
      total: 70000,
      discount: 0,
      trade_in_credit: 0,
      final_total: 70000,
      paid: 0,
      due: 70000,
      bank_account_id: bankId,
      payment_mode_id: null,
      items: [{ inventory_item_id: itemId, sold_price: 70000 }],
      trade_ins: [],
    }
    const sale = await sql`SELECT public.create_sale(${payload}::jsonb) AS result`.then((r) => r[0].result)
    saleId = sale.sale_id
    console.log('✓ sale created:', sale.bill_number)

    // A partial payment (3,000 of 70,000) — the receipt/reminder subject.
    await sql`SELECT public.receive_payment(${saleId}, 3000, ${today}, ${bankId}, ${modeId})`
    console.log('✓ partial payment recorded (3,000 of 70,000 → due 67,000)')
  }

  const final = await sql`
    SELECT bill_number, paid, due FROM public.sales WHERE id = ${saleId}`.then((r) => r[0])
  console.log(`\nSeed complete. Sale ${final.bill_number}: paid ${final.paid} / due ${final.due}`)
  console.log(`Sale id (for E2E): ${saleId}`)
  await sql.end()
}

main().catch(async (e) => {
  console.error(e)
  try { await sql.end() } catch {}
  process.exit(1)
})
