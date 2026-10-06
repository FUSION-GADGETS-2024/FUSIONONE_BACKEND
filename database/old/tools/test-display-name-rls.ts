/**
 * FUSIONONE — 0014 display_name RLS/privilege matrix (spec PHASE 24 + PHASE 31 tests 1–6).
 *
 * Runs against the LIVE TEST project with REAL authentication contexts:
 *   * password-login JWT (the normal application session — amr 'password')
 *   * recovery otp JWT   (the setup-auth context — amr 'otp')
 * and executes every check through PostgREST (the exact path the browser
 * uses), plus direct SQL for the constraint/trigger checks.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)

const SUPABASE_URL = 'https://egdrnhtmclvhsfjvhyam.supabase.co'
const PUBLISHABLE_KEY = 'sb_publishable_p5O1dGMmpZyvZpsa4Rhl0w_klQgHD2d'
const SECRET_KEY = 'sb_secret_REDACTED'
const USER_EMAIL = 'owner@fusionone.test'
const USER_PASSWORD = 'FusionOne#2026'

const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

const results: Array<{ id: string; name: string; pass: boolean; detail: string }> = {}
function record(id: string, name: string, pass: boolean, detail: string) {
  results[id] = { id, name, pass, detail }
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name} — ${detail}`)
}

async function passwordLogin(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`password login failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { access_token: string; user: { id: string } }
  return { token: body.access_token, userId: body.user.id }
}

async function restCall(jwt: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function main() {
  // ─── 1. migration applied ────────────────────────────────────────────────
  const applied = await sql`select version from public.schema_migrations where version = '0014_display_name.sql'`
  record('1', 'migration 0014 applied', applied.length === 1, applied.length === 1 ? 'in schema_migrations' : 'NOT recorded')

  // ─── 2. column exists ────────────────────────────────────────────────────
  const col = await sql`
    select data_type, is_nullable from information_schema.columns
    where table_schema='public' and table_name='users' and column_name='display_name'
  `
  record('2', 'display_name column exists (TEXT NULL)', col.length === 1 && col[0].data_type === 'text' && col[0].is_nullable === 'YES',
    col.length === 1 ? `${col[0].data_type} nullable=${col[0].is_nullable}` : 'missing')

  // ─── 3. constraints work (direct SQL, checked as the DB enforces them) ──
  const userId = (await sql`select id from public.users where id = (select id from auth.users where email = ${USER_EMAIL})`)[0].id
  const ownerIdRow = (await sql`select id from public.users where user_type = 'owner' limit 1`)

  // 3a. NULL is allowed
  let constraintNullOk = true
  try {
    await sql`update public.users set display_name = null where id = ${userId}`
  } catch (e) { constraintNullOk = false }
  record('3a', 'constraint: NULL allowed', constraintNullOk, constraintNullOk ? 'null accepted' : 'null REJECTED')

  // 3b. empty string rejected
  let emptyRejected = false
  try {
    await sql`update public.users set display_name = '' where id = ${userId}`
  } catch { emptyRejected = true }
  record('3b', 'constraint: empty string rejected', emptyRejected, emptyRejected ? 'violates users_display_name_check' : 'EMPTY STRING ACCEPTED')

  // 3c. whitespace-only rejected
  let wsRejected = false
  try {
    await sql`update public.users set display_name = '     ' where id = ${userId}`
  } catch { wsRejected = true }
  record('3c', 'constraint: whitespace-only rejected', wsRejected, wsRejected ? 'trimmed length 0 rejected' : 'WHITESPACE ACCEPTED')

  // 3d. 81 chars rejected
  let longRejected = false
  try {
    await sql`update public.users set display_name = ${'x'.repeat(81)} where id = ${userId}`
  } catch { longRejected = true }
  record('3d', 'constraint: 81 chars rejected', longRejected, longRejected ? 'trimmed length 81 rejected' : '81 CHARS ACCEPTED')

  // 3e. 80 chars accepted + trim trigger normalizes
  await sql`update public.users set display_name = ${'  ' + 'y'.repeat(80) + '  '} where id = ${userId}`
  const stored = (await sql`select display_name from public.users where id = ${userId}`)[0].display_name
  record('3e', 'constraint+trigger: 80 chars accepted, stored trimmed', stored === 'y'.repeat(80),
    `stored length ${stored.length}${stored === 'y'.repeat(80) ? ' (trimmed)' : ' UNTRIMMED'}`)

  // reset to NULL for the PostgREST tests
  await sql`update public.users set display_name = null where id = ${userId}`

  // ─── 4. self-update works through PostgREST with a password JWT ─────────
  const session = await passwordLogin(USER_EMAIL, USER_PASSWORD)
  const jwtPayload = JSON.parse(atob(session.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  const amr = jwtPayload.amr?.[0]?.method
  const selfUpdate = await restCall(session.token, 'PATCH', `users?id=eq.${session.userId}`, { display_name: '  Test User  ' })
  const selfRow = (await sql`select display_name from public.users where id = ${session.userId}`)[0]
  record('4', 'self-update works (own display_name, trimmed)', selfUpdate.status === 200 && selfRow.display_name === 'Test User',
    `HTTP ${selfUpdate.status}, amr=${amr}, stored="${selfRow.display_name}"`)

  // ─── 5. cross-user update denied ─────────────────────────────────────────
  const otherId = ownerIdRow[0].id
  const cross = await restCall(session.token, 'PATCH', `users?id=eq.${otherId}`, { display_name: 'Hacked Name' })
  const otherRow = (await sql`select display_name from public.users where id = ${otherId}`)[0]
  record('5', 'cross-user update denied', (cross.status === 200 || cross.status === 204) && (otherRow.display_name === null || cross.status === 403),
    `HTTP ${cross.status}, target display_name=${JSON.stringify(otherRow.display_name)} (unchanged = denied)`)

  // 5b. targeting BOTH rows updates only own
  await sql`update public.users set display_name = null where id = ${session.userId}`
  const massUpdate = await restCall(session.token, 'PATCH', `users?id=in.(${session.userId},${otherId})`, { display_name: 'Mass Test' })
  const ownAfter = (await sql`select display_name from public.users where id = ${session.userId}`)[0].display_name
  const otherAfter = (await sql`select display_name from public.users where id = ${otherId}`)[0].display_name
  record('5b', 'mass update touches only own row', ownAfter === 'Mass Test' && otherAfter === null,
    `own="${ownAfter}", other="${otherAfter}"`)

  // ─── 6. role/status/id mutation denied (column privilege) ────────────────
  const roleTry = await restCall(session.token, 'PATCH', `users?id=eq.${session.userId}`, { user_type: 'owner' })
  record('6a', 'user_type mutation denied', roleTry.status === 42501 || /permission denied/i.test(String((roleTry.json as any)?.message ?? roleTry.text)),
    `HTTP ${roleTry.status} ${((roleTry.json as any)?.message ?? '').slice(0, 60)}`)

  const statusTry = await restCall(session.token, 'PATCH', `users?id=eq.${session.userId}`, { status: 'blocked' })
  record('6b', 'status mutation denied', statusTry.status === 42501 || /permission denied/i.test(String((statusTry.json as any)?.message ?? statusTry.text)),
    `HTTP ${statusTry.status} ${((statusTry.json as any)?.message ?? '').slice(0, 60)}`)

  const idTry = await restCall(session.token, 'PATCH', `users?id=eq.${session.userId}`, { id: otherId })
  record('6c', 'id mutation denied', idTry.status === 42501 || /permission denied/i.test(String((idTry.json as any)?.message ?? idTry.text)),
    `HTTP ${idTry.status} ${((idTry.json as any)?.message ?? '').slice(0, 60)}`)

  const createdTry = await restCall(session.token, 'PATCH', `users?id=eq.${session.userId}`, { created_at: '2020-01-01T00:00:00Z' })
  record('6d', 'created_at mutation denied', createdTry.status === 42501 || /permission denied/i.test(String((createdTry.json as any)?.message ?? createdTry.text)),
    `HTTP ${createdTry.status} ${((createdTry.json as any)?.message ?? '').slice(0, 60)}`)

  // ─── Phase 29: setup-auth (otp) context can NEVER write display_name ────
  // recovery link for a provisioned, verified, ACTIVE user; verifyOtp gives an
  // otp-context JWT — it must NOT pass the self-update policy.
  const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    body: JSON.stringify({ type: 'recovery', email: USER_EMAIL }),
  })
  if (linkRes.ok) {
    const link = (await linkRes.json()) as { hashed_token: string }
    const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY },
      body: JSON.stringify({ token_hash: link.hashed_token, type: 'recovery' }),
    })
    if (verifyRes.ok) {
      const verifyBody = (await verifyRes.json()) as { access_token: string }
      const otpPayload = JSON.parse(atob(verifyBody.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      await sql`update public.users set display_name = null where id = ${session.userId}`
      const otpUpdate = await restCall(verifyBody.access_token, 'PATCH', `users?id=eq.${session.userId}`, { display_name: 'OTP Name' })
      const afterOtp = (await sql`select display_name from public.users where id = ${session.userId}`)[0].display_name
      record('6e', 'setup-auth (otp) context denied', afterOtp === null,
        `amr=${otpPayload.amr?.[0]?.method}, HTTP ${otpUpdate.status}, display_name still ${JSON.stringify(afterOtp)}`)
    } else {
      record('6e', 'setup-auth (otp) context denied', false, `verifyOtp failed: ${verifyRes.status}`)
    }
  } else {
    record('6e', 'setup-auth (otp) context denied', false, `generate_link failed: ${linkRes.status}`)
  }

  // ─── blocked context denied (temporary, auto-restored) ───────────────────
  await sql`update public.users set display_name = null where id = ${session.userId}`
  await sql`update public.users set status = 'blocked' where id = ${session.userId}`
  try {
    const blockedUpdate = await restCall(session.token, 'PATCH', `users?id=eq.${session.userId}`, { display_name: 'Blocked Name' })
    const afterBlocked = (await sql`select display_name from public.users where id = ${session.userId}`)[0].display_name
    record('6f', 'blocked context denied', afterBlocked === null, `HTTP ${blockedUpdate.status}, display_name still ${JSON.stringify(afterBlocked)}`)
  } finally {
    await sql`update public.users set status = 'active' where id = ${session.userId}`
  }

  // ─── owner-read of managed names still works (SELECT policy unchanged) ──
  const selfRead = await restCall(session.token, 'GET', `users?id=eq.${session.userId}&select=id,display_name,user_type,status`)
  record('7x', 'self-read of own row incl. display_name', selfRead.status === 200 && Array.isArray(selfRead.json) && (selfRead.json as any[]).length === 1,
    `HTTP ${selfRead.status}, row=${JSON.stringify((selfRead.json as any[])?.[0])}`)

  // ─── cleanup: leave the account with a display_name set (profile complete)
  await sql`update public.users set display_name = 'Test User' where id = ${session.userId}`

  const failed = Object.values(results).filter((r) => !r.pass)
  console.log(`\n=== DB MATRIX: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} PASS ===`)
  if (failed.length > 0) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '))
    process.exitCode = 1
  }
  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
