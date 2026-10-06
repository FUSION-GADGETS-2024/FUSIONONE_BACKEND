/**
 * FUSIONONE durable-message database test suite (spec §49 + the
 * automatic-receipts/payment-statement extension).
 *
 * Runs against the TEST Supabase project ONLY (never production) and
 * verifies the database-level behavior of the message system:
 *
 *   Payments     — payment correctness; receipt jobs never alter accounting.
 *   Reminder cfg — create / update / disable / re-enable / limit enforcement.
 *   Message jobs— due discovery, future-job isolation, atomic claiming
 *                  (concurrent claims never duplicate), abandoned-claim
 *                  recovery, retry persistence.
 *   Balance      — partial payment keeps the chain eligible; full payment
 *                  stops it; cancellation stops it; fully-paid invoices
 *                  never start one.
 *   Auto receipts— OFF by default; ON → exactly ONE job per SUBSEQUENT
 *                  payment (receive_payment / pay_purchase); the INITIAL
 *                  payment inside create_sale / create_purchase NEVER
 *                  triggers one; job references the exact payment row.
 *   Statements   — 'statement' job type shape + idempotency (one
 *                  pending/processing per invoice; later requests allowed
 *                  after a terminal outcome).
 *   Security     — message RPCs executable by service_role only;
 *                  message_jobs/reminder_settings read-only for the
 *                  browser roles; the private auto-receipt bridge is
 *                  executable by authenticated (the invoker payment RPCs
 *                  call it) but NOT anon.
 *
 * Usage (from database/tools):
 *   bun run message-tests.ts          # uses TEST_SUPABASE_DB_URL from .env
 *
 * Creates its own isolated fixtures (FY/party/inventory/sales/payments) and
 * removes them at the end. Exit code is non-zero when any check fails.
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
if (!DB_URL) throw new Error('Set FUSIONONE_DB_URL (or TEST_SUPABASE_DB_URL in database/tools/.env)')

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

// ── Typed RPC helpers (positional calls; postgres.js binds parameters) ─────

const claimDue = (worker: string, batch: number, lease: number, jobId: string | null, c = sql) =>
  c`SELECT * FROM public.claim_due_message_jobs(${worker}, ${batch}, ${lease}, ${jobId})`
    .then((r) => r as any[])

const recoverExpired = (c = sql) =>
  c`SELECT * FROM public.recover_expired_message_jobs()`.then((r) => r as any[])

const completeJob = (jobId: string, outcome: string, messageId: string | null, error: string | null, c = sql) =>
  c`SELECT public.complete_message_job(${jobId}, ${outcome}, ${messageId}, ${error}) AS result`
    .then((r) => r[0].result as any)

const upsertConfig = (saleId: string, enabled: boolean, frequencyDays: number, maxReminders: number) =>
  sql`SELECT public.upsert_reminder_config(${saleId}, ${enabled}, ${frequencyDays}, ${maxReminders}) AS result`
    .then((r) => r[0].result as any)

const triggerNow = (saleId: string) =>
  sql`SELECT public.trigger_reminder_now(${saleId}) AS result`.then((r) => r[0].result as any)

async function main() {
  const stamp = Date.now().toString(36)
  // 15-digit IMEI generator for fixtures (0012 enforces exactly-15-digits
  // at the DB boundary — the messaging suite tests documents, not IMEI
  // validation, so its fixtures must simply conform). Deterministic per
  // (stamp, n); all fixtures share the run's numeric prefix for cleanup.
  const imeiHash = (s: string): string => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
    return String(h % 100000).padStart(5, '0')
  }
  const runPrefix = '99' + imeiHash(stamp)
  const imeiFor = (n: number | string): string =>
    runPrefix + imeiHash(stamp + '#' + n) + imeiHash('suffix#' + n).slice(0, 3)
  console.log(`\n=== FUSIONONE message-system DB tests (${new Date().toISOString()}) ===\n`)

  // Save the store-level automatic-receipt switches and start from the
  // DEFAULT (OFF) state — every section (A-D included) asserts against
  // deterministic receipt-job creation. Restored in the finally block.
  const savedSwitches = await sql`
    SELECT auto_send_receipt_in, auto_send_receipt_out FROM public.whatsapp_settings LIMIT 1`.then((r) => r[0])
  await sql`UPDATE public.whatsapp_settings SET auto_send_receipt_in = false, auto_send_receipt_out = false`

  // ── Fixtures ────────────────────────────────────────────────────────────
  // Pre-cleanup: remove leftovers from previously interrupted runs (the FY
  // exclusion constraint forbids a second range over the same dates).
  // Fixture-scoped cleanup (unique per-run names — the seeded E2E
  // environment's data is never touched; the teardown below removes this
  // run's fixtures again).
  await sql`DELETE FROM public.payments_in WHERE sale_id IN (SELECT id FROM public.sales WHERE party_id IN (SELECT id FROM public.parties WHERE name LIKE ${'DBT Party ' + stamp + '%'}))`
  await sql`DELETE FROM public.sales WHERE party_id IN (SELECT id FROM public.parties WHERE name LIKE ${'DBT Party ' + stamp + '%'})`
  await sql`DELETE FROM public.account_transactions WHERE bank_account_id IN (SELECT id FROM public.bank_accounts WHERE name LIKE ${'DBT Cash ' + stamp + '%'})`
  await sql`DELETE FROM public.inventory_items WHERE imei LIKE ${runPrefix + '%'}`
  await sql`DELETE FROM public.payment_modes WHERE name LIKE ${'DBT UPI ' + stamp + '%'}`
  await sql`DELETE FROM public.bank_accounts WHERE name LIKE ${'DBT Cash ' + stamp + '%'}`
  await sql`DELETE FROM public.parties WHERE name LIKE ${'DBT Party ' + stamp + '%'}`

  // Reuse the FY covering the fixture sale date (the seeded E2E environment
  // provides one); insert only when absent. The FY is shared infrastructure
  // — the teardown never removes it.
  let fy = await sql`
    SELECT id FROM public.financial_years
     WHERE daterange(start_date, end_date, '[]') @> '2026-06-15'::date
     LIMIT 1`.then((r) => r[0]?.id)
  if (!fy) {
    fy = await sql`
      INSERT INTO public.financial_years (start_date, end_date, status)
      VALUES ('2026-04-01', '2027-03-31', 'active')
      RETURNING id`.then((r) => r[0].id)
  }

  const party = await sql`
    INSERT INTO public.parties (name, number, address)
    VALUES (${'DBT Party ' + stamp}, '9876543210', 'Test Address')
    RETURNING id`.then((r) => r[0].id)

  const bank = await sql`
    INSERT INTO public.bank_accounts (name, is_cash)
    VALUES (${'DBT Cash ' + stamp}, true)
    RETURNING id`.then((r) => r[0].id)

  const mode = await sql`
    INSERT INTO public.payment_modes (name, bank_account_id)
    VALUES (${'DBT UPI ' + stamp}, ${bank})
    RETURNING id`.then((r) => r[0].id)

  const makeItem = (n: number) =>
    sql`
      INSERT INTO public.inventory_items (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id)
      VALUES ('TestBrand', 'TestModel', ${imeiFor('I' + n)}, '8/256', 'Black', 8000, 10000, 'in_stock', 'purchase', ${fy})
      RETURNING id`.then((r) => r[0].id)
  const item = await makeItem(1)

  const salePayload = (itemId: string) => ({
    party_id: party,
    financial_year_id: fy,
    date: '2026-06-15',
    total: 10000,
    discount: 0,
    trade_in_credit: 0,
    final_total: 10000,
    paid: 0,
    due: 10000,
    items: [{ inventory_item_id: itemId, sold_price: 10000 }],
    bank_account_id: bank,
    payment_mode_id: mode,
    trade_ins: [],
  })

  const sale = await sql`
    SELECT public.create_sale(${salePayload(item)}::jsonb) AS result`.then((r) => r[0].result)
  const saleId = sale.sale_id
  ok(!!saleId, 'fixture: create_sale produced a sale (via the real transactional RPC)')

  await sql`INSERT INTO public.whatsapp_settings (singleton) VALUES (1) ON CONFLICT DO NOTHING`

  // ══ A. Payments (§49 Payments) ══════════════════════════════════════════
  console.log('\n── A. Payments remain accounting-correct; receipts never alter them ──')
  await sql`SELECT public.receive_payment(${saleId}, 3000, '2026-06-20', ${bank}, ${mode})`
  const after = await sql`
    SELECT paid, due, (SELECT count(*) FROM public.payments_in WHERE sale_id = ${saleId}) AS payments
      FROM public.sales WHERE id = ${saleId}`.then((r) => r[0])
  ok(Number(after.paid) === 3000 && Number(after.due) === 7000, 'partial payment updated stored balances (paid 3000 / due 7000)', after)
  ok(Number(after.payments) === 1, 'payments_in row created (the receipt source)')
  const paymentId = await sql`
    SELECT id FROM public.payments_in WHERE sale_id = ${saleId} LIMIT 1`.then((r) => r[0].id)

  // A receipt job (pending → claimed → succeeded) must not touch accounting.
  const receiptJob = await sql`
    INSERT INTO public.message_jobs (job_type, payment_in_id, run_at)
    VALUES ('receipt', ${paymentId}, now() - interval '1 minute')
    RETURNING id`.then((r) => r[0].id)
  const claimedReceipt = await claimDue('dbtest-1', 5, 300, receiptJob)
  ok(Array.isArray(claimedReceipt) && claimedReceipt.length === 1, 'receipt job claimed atomically')
  const receiptDone = await completeJob(receiptJob, 'success', 'wamid.TEST', null)
  ok(receiptDone?.updated === true && receiptDone?.status === 'succeeded', 'receipt job completion persisted', receiptDone)
  const accounting = await sql`
    SELECT paid, due, (SELECT count(*) FROM public.payments_in WHERE sale_id = ${saleId}) AS payments
      FROM public.sales WHERE id = ${saleId}`.then((r) => r[0])
  ok(
    Number(accounting.paid) === 3000 && Number(accounting.due) === 7000 && Number(accounting.payments) === 1,
    'receipt message did NOT alter accounting state (paid/due/payments unchanged)',
    accounting,
  )

  // ══ B. Reminder configuration (§49 Reminder configuration) ══════════════
  console.log('\n── B. Reminder configuration lifecycle ──')
  const cfg1 = await upsertConfig(saleId, true, 7, 3)
  ok(cfg1?.config?.enabled === true && cfg1?.config?.frequency_days === 7, 'configuration created (enabled, 7-day frequency)', cfg1)
  ok(cfg1?.job_created === true, 'enabling created the first durable reminder job (at +frequency)', cfg1)

  const cfg2 = await upsertConfig(saleId, true, 3, 5)
  ok(cfg2?.config?.frequency_days === 3 && cfg2?.config?.max_reminders === 5, 'configuration updated (3-day frequency, max 5)')
  ok(cfg2?.job_created === false, 'updating while a pending job exists does NOT duplicate the chain')

  const pendingCount = () =>
    sql`SELECT count(*)::int AS n FROM public.message_jobs
         WHERE sale_id = ${saleId} AND job_type = 'reminder' AND status = 'pending'`.then((r) => r[0].n)

  const cfg3 = await upsertConfig(saleId, false, 3, 5)
  const pendingAfterDisable = await pendingCount()
  ok(cfg3?.config?.enabled === false && cfg3?.jobs_cancelled >= 1 && pendingAfterDisable === 0,
    'disabling cancelled the pending reminder jobs', { cfg3, pendingAfterDisable })

  const cfg4 = await upsertConfig(saleId, true, 3, 5)
  ok(cfg4?.job_created === true, 're-enabling re-created the next job (chain resumes)')

  // Limit enforcement: max=1, one sent reminder → chain must stop.
  await upsertConfig(saleId, true, 3, 1)
  const limitJob = await sql`
    SELECT id FROM public.message_jobs
     WHERE sale_id = ${saleId} AND job_type = 'reminder' AND status = 'pending'`.then((r) => r[0].id)
  await sql`UPDATE public.message_jobs SET run_at = now() WHERE id = ${limitJob}`
  await claimDue('dbtest-1', 5, 300, limitJob)
  const limitDone = await completeJob(limitJob, 'success', 'wamid.R1', null)
  const cfgAfterLimit = await sql`
    SELECT reminders_sent, max_reminders FROM public.reminder_settings WHERE sale_id = ${saleId}`.then((r) => r[0])
  const pendingAfterLimit = await pendingCount()
  ok(
    limitDone?.updated === true && cfgAfterLimit.reminders_sent === 1 && pendingAfterLimit === 0,
    'maximum-reminder limit enforced persistently (1 sent of max 1 → no next job)',
    { limitDone, cfgAfterLimit, pendingAfterLimit },
  )
  // Raise the limit back for the later sections.
  await upsertConfig(saleId, true, 3, 5)

  // ══ C. Message jobs: claiming, recovery, retries (§49 Message jobs) ═══
  console.log('\n── C. Message job claiming / recovery / retries ──')
  // Future job isolation (invoice_send type: no conflict with the reminder chain).
  const futureAutoSend = await sql`
    INSERT INTO public.message_jobs (job_type, sale_id, run_at)
    VALUES ('invoice_send', ${saleId}, now() + interval '2 days')
    RETURNING id`.then((r) => r[0].id)
  const futureClaim = await claimDue('dbtest-f', 10, 300, null)
  ok(
    !(futureClaim ?? []).some((j) => j.id === futureAutoSend),
    'future jobs are NOT claimed (run_at in the future stays untouched)',
  )

  // Due job + concurrent claiming: two workers claim the SAME due job — only one wins.
  const dueJob = await sql`
    UPDATE public.message_jobs SET run_at = now() - interval '1 minute'
     WHERE id = ${futureAutoSend} RETURNING id`.then((r) => r[0].id)
  const workerA = postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
  const workerB = postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
  const [claimsA, claimsB] = await Promise.all([
    claimDue('dbtest-A', 10, 300, null, workerA),
    claimDue('dbtest-B', 10, 300, null, workerB),
  ])
  const claimedByA = (claimsA ?? []).filter((j) => j.id === dueJob).length
  const claimedByB = (claimsB ?? []).filter((j) => j.id === dueJob).length
  ok(claimedByA + claimedByB === 1, 'concurrent claims never duplicate one job (SKIP LOCKED)', { claimedByA, claimedByB })
  const dueRow = await sql`SELECT status, attempts, claimed_by FROM public.message_jobs WHERE id = ${dueJob}`.then((r) => r[0])
  ok(dueRow.status === 'processing' && Number(dueRow.attempts) === 1 && !!dueRow.claimed_by, 'claim set processing/attempts/claimed_by', dueRow)
  await workerA.end()
  await workerB.end()

  // A claimed-but-unfinished job whose lease expired is recovered (retryable).
  await sql`UPDATE public.message_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = ${dueJob}`
  const recovered = await recoverExpired()
  const recoveredRow = (recovered ?? []).find((r: any) => r.id === dueJob)
  ok(!!recoveredRow && recoveredRow.status === 'pending', 'abandoned processing job recovered to pending (retryable)', recoveredRow)
  const runAtRow = await sql`SELECT run_at FROM public.message_jobs WHERE id = ${dueJob}`.then((r) => r[0])
  ok(new Date(runAtRow.run_at).getTime() > Date.now() - 1000, 'recovery scheduled a backed-off retry run_at', runAtRow)

  // Retry persistence: a failed attempt returns to pending with the error kept.
  await sql`UPDATE public.message_jobs SET run_at = now() WHERE id = ${dueJob}`
  await claimDue('dbtest-2', 10, 300, dueJob)
  const retryDone = await completeJob(dueJob, 'retry', null, 'WHATSAPP_SEND_FAILED: transport')
  const retryRow = await sql`SELECT status, last_error FROM public.message_jobs WHERE id = ${dueJob}`.then((r) => r[0])
  ok(
    retryDone?.updated === true && retryRow.status === 'pending' && String(retryRow.last_error).includes('WHATSAPP_SEND_FAILED'),
    'retryable failure persisted (pending + last_error kept for the next attempt)',
    { retryDone, retryRow },
  )

  // ══ D. Balance-driven behavior (§49 Balance-driven) ═════════════════════
  console.log('\n── D. Balance-driven reminder behavior ──')
  // The reminder job references ONLY the sale — no frozen balance is stored.
  const jobRefRow = await sql`
    SELECT sale_id, payment_in_id, purchase_id FROM public.message_jobs
     WHERE sale_id = ${saleId} AND job_type = 'reminder' LIMIT 1`.then((r) => r[0])
  ok(!!jobRefRow?.sale_id && jobRefRow.payment_in_id === null, 'reminder jobs carry a business-object reference only (no frozen balance)', jobRefRow)

  // Complete the current pending reminder job successfully WITH the current
  // partial balance (due 7,000) → the chain continues (next job created).
  const pendingReminder = await sql`
    SELECT id FROM public.message_jobs
     WHERE sale_id = ${saleId} AND job_type = 'reminder' AND status = 'pending'
     ORDER BY run_at LIMIT 1`.then((r) => r[0].id)
  await sql`UPDATE public.message_jobs SET run_at = now() WHERE id = ${pendingReminder}`
  await claimDue('dbtest-4', 10, 300, pendingReminder)
  const chainDone = await completeJob(pendingReminder, 'success', 'wamid.R2', null)
  const nextPending = await pendingCount()
  ok(chainDone?.next_job_created === true && nextPending === 1, 'partial payment keeps the chain going (next job created)', { chainDone, nextPending })

  // Full payment stops future reminders: pay the rest, complete the next
  // reminder job → NO further job.
  await sql`SELECT public.receive_payment(${saleId}, 7000, '2026-06-25', ${bank}, ${mode})`
  const fullyPaid = await sql`SELECT due FROM public.sales WHERE id = ${saleId}`.then((r) => r[0])
  ok(Number(fullyPaid.due) === 0, 'fully paid now (due = 0)')
  const nextJob2 = await sql`
    SELECT id FROM public.message_jobs
     WHERE sale_id = ${saleId} AND job_type = 'reminder' AND status = 'pending'
     ORDER BY run_at LIMIT 1`.then((r) => r[0].id)
  await sql`UPDATE public.message_jobs SET run_at = now() WHERE id = ${nextJob2}`
  await claimDue('dbtest-5', 10, 300, nextJob2)
  const stopDone = await completeJob(nextJob2, 'success', 'wamid.R3', null)
  const pendingAfterFullPay = await pendingCount()
  ok(stopDone?.next_job_created === false && pendingAfterFullPay === 0, 'full payment stops the chain (no next reminder job)', { stopDone, pendingAfterFullPay })

  // A fully-paid invoice must not START a chain either.
  const cfgPaid = await upsertConfig(saleId, true, 3, 5)
  ok(cfgPaid?.job_created === false, 'fully-paid invoice never (re)starts a reminder chain', cfgPaid)

  // trigger_reminder_now on a fully-paid invoice fails (ineligible).
  let triggerRejected = false
  try {
    await triggerNow(saleId)
  } catch {
    triggerRejected = true
  }
  ok(triggerRejected, 'manual reminder on a fully-paid invoice is rejected (ineligible)')

  // Cancellation stops reminders: a fresh partially-due sale, cancelled.
  const item2 = await makeItem(2)
  const sale2 = await sql`
    SELECT public.create_sale(${salePayload(item2)}::jsonb) AS result`.then((r) => r[0].result)
  await upsertConfig(sale2.sale_id, true, 3, 3)
  await sql`SELECT public.cancel_sale(${sale2.sale_id})`
  const cfgAfterCancel = await upsertConfig(sale2.sale_id, true, 3, 3)
  const pendingAfterCancel = await sql`
    SELECT count(*)::int AS n FROM public.message_jobs
     WHERE sale_id = ${sale2.sale_id} AND job_type = 'reminder' AND status = 'pending'`.then((r) => r[0].n)
  ok(
    cfgAfterCancel?.job_created === false && pendingAfterCancel === 0,
    'cancelled invoice stops/cannot start the reminder chain',
    { pendingAfterCancel },
  )

  // Security: the message RPCs must NOT be executable by authenticated/anon.
  const execGrants = await sql`
    SELECT has_function_privilege('authenticated', 'public.claim_due_message_jobs(text, int, int, uuid)', 'EXECUTE') AS auth_can,
           has_function_privilege('anon', 'public.claim_due_message_jobs(text, int, int, uuid)', 'EXECUTE') AS anon_can,
           has_function_privilege('service_role', 'public.claim_due_message_jobs(text, int, int, uuid)', 'EXECUTE') AS svc_can`.then((r) => r[0])
  ok(execGrants.auth_can === false && execGrants.anon_can === false && execGrants.svc_can === true,
    'message RPCs: service_role ONLY (browser roles denied)', execGrants)

  // Table writes denied to authenticated (system-owned state).
  const writeGrant = await sql`
    SELECT has_table_privilege('authenticated', 'public.message_jobs', 'INSERT') AS can_insert,
           has_table_privilege('authenticated', 'public.message_jobs', 'SELECT') AS can_select,
           has_table_privilege('authenticated', 'public.reminder_settings', 'UPDATE') AS can_update_cfg`.then((r) => r[0])
  ok(
    writeGrant.can_insert === false && writeGrant.can_select === true && writeGrant.can_update_cfg === false,
    'message_jobs/reminder_settings: SELECT-only for authenticated (writes are system-owned)',
    writeGrant,
  )

  // ══ E. Automatic payment receipts (subsequent payments only) ═══════════
  console.log('\n── E. Automatic payment receipts: OFF default, ON → subsequent only ──')
  // The switches were saved + set OFF at the top of main(); section E
  // toggles them freely and the finally block restores the saved state.

  const item3 = await makeItem(3)
  const sale3 = await sql`
    SELECT public.create_sale(${salePayload(item3)}::jsonb) AS result`.then((r) => r[0].result)
  const sale3Id = sale3.sale_id

  // E1. Switch OFF (default): a subsequent payment records but creates NO job.
  await sql`SELECT public.receive_payment(${sale3Id}, 1000, '2026-06-21', ${bank}, ${mode})`
  const noJobs = await sql`
    SELECT count(*)::int AS n FROM public.message_jobs dj
     WHERE dj.payment_in_id IN (SELECT id FROM public.payments_in WHERE sale_id = ${sale3Id})`.then((r) => r[0].n)
  ok(noJobs === 0, 'auto receipt OFF (default): subsequent payment recorded, NO receipt job', { noJobs })

  // E2. Switch ON (In): each SUBSEQUENT payment creates exactly ONE job.
  await sql`UPDATE public.whatsapp_settings SET auto_send_receipt_in = true`
  await sql`SELECT public.receive_payment(${sale3Id}, 2000, '2026-06-22', ${bank}, ${mode})`
  await sql`SELECT public.receive_payment(${sale3Id}, 1500, '2026-06-23', ${bank}, ${mode})`
  const autoJobs = await sql`
    SELECT dj.payment_in_id, dj.status, dj.attempts, dj.run_at <= now() AS due_now
      FROM public.message_jobs dj
     WHERE dj.job_type = 'receipt' AND dj.payment_in_id IN (SELECT id FROM public.payments_in WHERE sale_id = ${sale3Id})
     ORDER BY dj.created_at`.then((r) => r as any[])
  const pay3Ids = await sql`
    SELECT id, amount FROM public.payments_in WHERE sale_id = ${sale3Id} ORDER BY created_at`.then((r) => r as any[])
  ok(
    autoJobs.length === 2
      && autoJobs[0].payment_in_id === pay3Ids[1].id
      && autoJobs[1].payment_in_id === pay3Ids[2].id
      && autoJobs.every((j) => j.status === 'pending' && Number(j.attempts) === 0 && j.due_now === true),
    'auto receipt ON: exactly ONE pending due-now job per subsequent payment (2000 + 1500, not the OFF-era 1000)',
    { autoJobs: autoJobs.length, payments: pay3Ids.map((p) => Number(p.amount)) },
  )

  // E3. The INITIAL payment inside create_sale NEVER triggers a receipt —
  //     even with the switch ON (the invoice message already carries it).
  const item4 = await makeItem(4)
  const sale4 = await sql`
    SELECT public.create_sale(${{ ...salePayload(item4), paid: 5000, due: 5000 }}::jsonb) AS result`.then((r) => r[0].result)
  const sale4Id = sale4.sale_id
  const initialPayment = await sql`
    SELECT id FROM public.payments_in WHERE sale_id = ${sale4Id} LIMIT 1`.then((r) => r[0]?.id)
  const initialJobs = await sql`
    SELECT count(*)::int AS n FROM public.message_jobs WHERE payment_in_id = ${initialPayment}`.then((r) => r[0].n)
  ok(!!initialPayment && initialJobs === 0,
    'initial payment (create_sale, auto ON): payment row exists, NO automatic receipt job',
    { initialPayment, initialJobs })

  // E4. Payment Out matrix: pay_purchase creates one job when the Out switch
  //     is ON; create_purchase's initial payment never does.
  const purchasePayload = (n: number, paid: number) => ({
    party_id: party,
    financial_year_id: fy,
    date: '2026-06-15',
    total: 8000,
    paid,
    due: 8000 - paid,
    items: [{
      brand: 'TestBrand', model: 'TestModel', imei: imeiFor('P' + n),
      ram_rom: '8/256', color: 'Black', purchase_price: 8000, base_selling_price: 9500,
    }],
    bank_account_id: bank,
    payment_mode_id: mode,
  })
  await sql`UPDATE public.whatsapp_settings SET auto_send_receipt_out = false`
  const purchase1 = await sql`
    SELECT public.create_purchase(${purchasePayload(1, 0)}::jsonb) AS result`.then((r) => r[0].result)
  await sql`SELECT public.pay_purchase(${purchase1.purchase_id}, 3000, '2026-06-20', ${bank}, ${mode})`
  const outJobsBefore = await sql`
    SELECT count(*)::int AS n FROM public.message_jobs dj
     WHERE dj.payment_out_id IN (SELECT id FROM public.payments_out WHERE purchase_id = ${purchase1.purchase_id})`.then((r) => r[0].n)
  ok(outJobsBefore === 0, 'auto receipt OUT off: pay_purchase recorded, NO job')

  await sql`UPDATE public.whatsapp_settings SET auto_send_receipt_out = true`
  await sql`SELECT public.pay_purchase(${purchase1.purchase_id}, 2000, '2026-06-21', ${bank}, ${mode})`
  const outJobs = await sql`
    SELECT dj.payment_out_id FROM public.message_jobs dj
     WHERE dj.job_type = 'receipt' AND dj.payment_out_id IN (SELECT id FROM public.payments_out WHERE purchase_id = ${purchase1.purchase_id})`.then((r) => r as any[])
  ok(outJobs.length === 1, 'auto receipt OUT on: exactly ONE job for the subsequent payment (not the OFF-era one)', { outJobs: outJobs.length })

  const purchase2 = await sql`
    SELECT public.create_purchase(${purchasePayload(2, 4000)}::jsonb) AS result`.then((r) => r[0].result)
  const initialOut = await sql`
    SELECT id FROM public.payments_out WHERE purchase_id = ${purchase2.purchase_id} LIMIT 1`.then((r) => r[0]?.id)
  const initialOutJobs = await sql`
    SELECT count(*)::int AS n FROM public.message_jobs WHERE payment_out_id = ${initialOut}`.then((r) => r[0].n)
  ok(!!initialOut && initialOutJobs === 0,
    'initial payment (create_purchase, auto OUT on): NO automatic receipt job',
    { initialOut, initialOutJobs })

  // E5. Idempotency: the unique index itself — a direct second pending
  //     receipt job for the SAME payment is rejected (23505), which is what
  //     the helper's ON CONFLICT DO NOTHING absorbs inside the payment tx.
  let receiptDupBlocked = false
  try {
    await sql`INSERT INTO public.message_jobs (job_type, payment_out_id) VALUES ('receipt', ${outJobs[0].payment_out_id})`
  } catch (e: any) {
    receiptDupBlocked = e.code === '23505'
  }
  ok(receiptDupBlocked, 'unique index blocks a second pending receipt job for the same payment (no duplicates)')

  // ══ F. Payment Statement jobs (manual only) ════════════════════════════
  console.log('\n── F. Payment Statement job type: shape + idempotency ──')
  // F1. A statement job for a sale inserts cleanly (run_at due).
  const statementJob = await sql`
    INSERT INTO public.message_jobs (job_type, sale_id, run_at)
    VALUES ('statement', ${sale3Id}, now())
    RETURNING id`.then((r) => r[0].id)
  ok(!!statementJob, 'statement job for a sale inserts cleanly (typed ref shape)')

  // F2. ONE pending/processing statement per invoice — a second is blocked.
  let statementDupBlocked = false
  try {
    await sql`INSERT INTO public.message_jobs (job_type, sale_id, run_at) VALUES ('statement', ${sale3Id}, now())`
  } catch (e: any) {
    statementDupBlocked = e.code === '23505'
  }
  ok(statementDupBlocked, 'unique index blocks a second PENDING statement for the same invoice (double-click guard)')

  // F3. After the first reaches a terminal state, a NEW statement is allowed
  //     (two intentionally separate user requests are not the same statement).
  await sql`UPDATE public.message_jobs SET status = 'succeeded', finished_at = now() WHERE id = ${statementJob}`
  const statement2 = await sql`
    INSERT INTO public.message_jobs (job_type, sale_id, run_at)
    VALUES ('statement', ${sale3Id}, now())
    RETURNING id`.then((r) => r[0].id)
  ok(!!statement2, 'after a terminal outcome a NEW statement job is allowed (separate user requests)')

  // F4. Ref-shape enforcement: statement must carry sale XOR purchase — never
  //     both, never a payment/proforma reference.
  let shapeViolation = false
  try {
    await sql`INSERT INTO public.message_jobs (job_type, sale_id, purchase_id) VALUES ('statement', ${sale3Id}, ${purchase1.purchase_id})`
  } catch (e: any) {
    shapeViolation = e.code === '23514' // check_violation
  }
  ok(shapeViolation, "ref-shape CHECK rejects a statement with BOTH sale and purchase references")
  let paymentRefViolation = false
  try {
    await sql`INSERT INTO public.message_jobs (job_type, payment_in_id) VALUES ('statement', ${pay3Ids[0].id})`
  } catch (e: any) {
    paymentRefViolation = e.code === '23514'
  }
  ok(paymentRefViolation, 'ref-shape CHECK rejects a statement with a payment reference')

  // ══ G. Security posture of the auto-receipt bridge ══════════════════════
  console.log('\n── G. private.create_auto_receipt_job privilege posture ──')
  const bridgeGrants = await sql`
    SELECT has_function_privilege('authenticated', 'private.create_auto_receipt_job(text, uuid)', 'EXECUTE') AS auth_can,
           has_function_privilege('anon', 'private.create_auto_receipt_job(text, uuid)', 'EXECUTE') AS anon_can,
           has_function_privilege('service_role', 'private.create_auto_receipt_job(text, uuid)', 'EXECUTE') AS svc_can`.then((r) => r[0])
  ok(
    bridgeGrants.auth_can === true && bridgeGrants.anon_can === false,
    'auto-receipt bridge: authenticated MAY execute (invoker payment RPCs), anon may NOT',
    bridgeGrants,
  )
  // The bridge lives in the PRIVATE schema — PostgREST exposes only the
  // public schema, so the browser can never call it directly.
  const inPublicSchema = await sql`
    SELECT count(*)::int AS n FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'create_auto_receipt_job' AND n.nspname = 'public'`.then((r) => r[0].n)
  ok(inPublicSchema === 0, 'the bridge is NOT in the PostgREST-exposed public schema (private schema posture intact)')

  // Restore the store-level switches exactly as they were found.
  await sql`UPDATE public.whatsapp_settings
     SET auto_send_receipt_in = ${savedSwitches?.auto_send_receipt_in ?? false},
         auto_send_receipt_out = ${savedSwitches?.auto_send_receipt_out ?? false}`

  // ── Teardown ────────────────────────────────────────────────────────────
  await sql`DELETE FROM public.payments_in WHERE sale_id IN (${saleId}, ${sale2.sale_id}, ${sale3Id}, ${sale4Id})`
  await sql`DELETE FROM public.payments_out WHERE purchase_id IN (${purchase1.purchase_id}, ${purchase2.purchase_id})`
  await sql`DELETE FROM public.account_transactions WHERE reference_type IN ('payment_in','payment_out') AND reference_id IN (
    SELECT id FROM public.payments_in WHERE sale_id IN (${saleId}, ${sale2.sale_id}, ${sale3Id}, ${sale4Id}))`
  await sql`DELETE FROM public.account_transactions WHERE bank_account_id = ${bank}`
  await sql`DELETE FROM public.sales WHERE id IN (${saleId}, ${sale2.sale_id}, ${sale3Id}, ${sale4Id})`
  await sql`DELETE FROM public.purchases WHERE id IN (${purchase1.purchase_id}, ${purchase2.purchase_id})`
  await sql`DELETE FROM public.inventory_items WHERE id IN (${item}, ${item2}, ${item3}, ${item4})`
  // create_purchase creates its OWN inventory rows from the payload items —
  // remove every remaining fixture row of this run by its unique IMEI prefix
  // (the tracked ids above cover only the directly-inserted ones).
  await sql`DELETE FROM public.inventory_items WHERE imei LIKE ${runPrefix + '%'}`
  await sql`DELETE FROM public.payment_modes WHERE id = ${mode}`
  await sql`DELETE FROM public.bank_accounts WHERE id = ${bank}`
  await sql`DELETE FROM public.parties WHERE id = ${party}`
  const leftovers = await sql`
    SELECT count(*)::int AS n FROM public.message_jobs WHERE sale_id IN (${saleId}, ${sale2.sale_id}, ${sale3Id}, ${sale4Id})
       OR purchase_id IN (${purchase1.purchase_id}, ${purchase2.purchase_id})`.then((r) => r[0].n)
  ok(leftovers === 0, 'teardown: cascading deletes removed the jobs with their invoices')
  const leftoverItems = await sql`
    SELECT count(*)::int AS n FROM public.inventory_items WHERE imei LIKE ${runPrefix + '%'}`.then((r) => r[0].n)
  ok(leftoverItems === 0, 'teardown: zero leaked fixture inventory rows remain (incl. create_purchase items)')

  await sql.end()
  console.log(`\n=== ${passes} passed, ${failures} failed ===\n`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try { await sql.end() } catch {}
  process.exit(1)
})
