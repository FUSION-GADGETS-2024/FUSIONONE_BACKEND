/**
 * FUSIONONE — mandatory adversarial database access matrix (auth migration).
 *
 * Runs REAL PostgREST requests (publishable key + a real password-grant JWT
 * per identity) exactly as the application does, plus privileged postgres
 * attempts for the structural invariants. Verifies the RLS model:
 *
 *   OWNER_VERIFIED    -> shared business access + store writes
 *   USER_VERIFIED     -> shared business access, NO store writes
 *   NULL_ROLE_VERIFIED-> all protected access denied
 *   NO_APP_ROW        -> all protected access denied
 *   USER_UNVERIFIED   -> all protected access denied
 *   OWNER_UNVERIFIED  -> all protected access denied (temporarily unverified)
 *
 * Structural: second store rejected (even by privileged code), second owner
 * rejected, role-escalation updates rejected.
 *
 * Prerequisite: identities created by create-test-identities.ts
 * (/tmp/test-identities.json + the fixed owner id).
 *
 * Usage: bun run test-auth-matrix.ts
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const URL_ = env.TEST_SUPABASE_URL
const PUB = env.TEST_SUPABASE_PUBLISHABLE_KEY
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

const IDS = JSON.parse(readFileSync('/tmp/test-identities.json', 'utf8')) as Record<
  string,
  { id: string; password: string; email: string }
>
const OWNER = { key: 'OWNER_VERIFIED', email: 'owner@fusionone.test', password: 'FusionOne#2026', id: 'b56dbf8a-0d67-4f26-8fa1-e615f04f4291' }

const results: Array<{ group: string; name: string; pass: boolean; note?: string }> = []
function check(group: string, name: string, pass: boolean, note?: string) {
  results.push({ group, name, pass, note })
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${group}] ${name}${note ? ` — ${note}` : ''}`)
}

interface Identity {
  key: string
  email: string
  password: string
}
const IDENTITIES: Identity[] = [
  OWNER,
  { key: 'USER_VERIFIED', ...IDS['user@fusionone.test'] },
  { key: 'NULL_ROLE_VERIFIED', ...IDS['null-role@fusionone.test'] },
  { key: 'NO_APP_ROW', ...IDS['no-row@fusionone.test'] },
  { key: 'USER_UNVERIFIED', ...IDS['user-unverified@fusionone.test'] },
]

async function getToken(id: Identity): Promise<string | null> {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: id.email, password: id.password }),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { access_token?: string }
  return body.access_token ?? null
}

interface RestResult {
  status: number
  code?: string
  message?: string
  rows: any[]
}

async function rest(
  token: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<RestResult> {
  if (!token) return { status: -1, rows: [] }
  const headers: Record<string, string> = {
    apikey: PUB,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') headers['Prefer'] = 'return=representation'

  const res = await fetch(`${URL_}/rest/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : []
  return {
    status: res.status,
    code: parsed?.code,
    message: typeof parsed?.message === 'string' ? parsed.message : parsed?.hint,
    rows,
  }
}

function isDenied(r: RestResult): boolean {
  return r.status === 42501 || r.status === 401 || r.status === 403 || r.status === -1
}
const emptyOk = (r: RestResult) => r.status === 200 && r.rows.length === 0

async function main() {
  const tokens = new Map<string, string | null>()
  for (const id of IDENTITIES) {
    tokens.set(id.key, await getToken(id))
    console.log(`--- ${id.key}: ${tokens.get(id.key) ? 'token OK' : 'SIGN-IN REFUSED (unverified gate)'}`)
  }
  const owner = tokens.get('OWNER_VERIFIED')!
  const user = tokens.get('USER_VERIFIED')
  const nullRole = tokens.get('NULL_ROLE_VERIFIED')
  const noRow = tokens.get('NO_APP_ROW')
  const userUnverified = tokens.get('USER_UNVERIFIED')
  const STORE_ID = 'aa000000-0000-4000-8000-000000000003'
  const FY_ID = 'aa000000-0000-4000-8000-000000000001'
  const userId = IDS['user@fusionone.test'].id
  const unverifiedId = IDS['user-unverified@fusionone.test'].id

  const blocked: Array<[string, string | null]> = [
    ['NULL_ROLE_VERIFIED', nullRole],
    ['NO_APP_ROW', noRow],
    ['USER_UNVERIFIED', userUnverified],
  ]

  // ─── GROUP: store access ────────────────────────────────────────────────
  {
    const r = await rest(owner, 'GET', '/store?select=id,name')
    check('store', 'OWNER can SELECT store', r.status === 200 && r.rows.length === 1, `status=${r.status}`)

    const ru = await rest(user, 'GET', '/store?select=id,name')
    check('store', 'USER can SELECT store (shared data)', ru.status === 200 && ru.rows.length === 1, `status=${r.status} rows=${ru.rows.length}`)

    for (const [key, tok] of blocked) {
      const r = await rest(tok, 'GET', '/store?select=id')
      check('store', `${key} CANNOT SELECT store`, isDenied(r) || emptyOk(r), `status=${r.status}`)
    }

    const uo = await rest(owner, 'PATCH', `/store?id=eq.${STORE_ID}&select=id`, { name: 'FUSION GADGETS' })
    check('store', 'OWNER can UPDATE store', uo.status === 200 || uo.status === 204, `status=${uo.status}`)

    const uu = await rest(user, 'PATCH', `/store?id=eq.${STORE_ID}&select=id`, { name: 'HACKED' })
    check('store', 'USER CANNOT update store details', isDenied(uu) || emptyOk(uu), `status=${uu.status}`)
    for (const [key, tok] of blocked) {
      const r = await rest(tok, 'PATCH', `/store?id=eq.${STORE_ID}&select=id`, { name: 'HACKED' })
      check('store', `${key} CANNOT update store`, isDenied(r) || emptyOk(r), `status=${r.status}`)
    }

    const io = await rest(owner, 'POST', '/store', { name: 'SECOND', phone: '123' })
    check('store', 'OWNER INSERT second store rejected (singleton)', io.status === 409 || (io.status === 400 && /duplicate|unique/i.test(io.message ?? '')), `status=${io.status} ${io.message ?? ''}`)

    const d = await rest(owner, 'DELETE', `/store?id=eq.${STORE_ID}`)
    check('store', 'OWNER cannot DELETE store (no policy)', isDenied(d) || emptyOk(d), `status=${d.status}`)
  }

  // ─── GROUP: business data (parties) — shared, multi-user ────────────────
  {
    const so = await rest(owner, 'GET', '/parties?select=id&limit=5')
    check('parties', 'OWNER can SELECT parties', so.status === 200 && so.rows.length > 0, `status=${so.status}`)
    const su = await rest(user, 'GET', '/parties?select=id&limit=5')
    check('parties', 'USER can SELECT parties (shared data)', su.status === 200 && su.rows.length > 0, `status=${su.status}`)
    for (const [key, tok] of blocked) {
      const r = await rest(tok, 'GET', '/parties?select=id&limit=5')
      check('parties', `${key} CANNOT SELECT parties`, isDenied(r) || emptyOk(r), `status=${r.status}`)
    }

    const cu = await rest(user, 'POST', '/parties?select=id,name', { name: 'MATRIX-TEST shared party (user)' })
    check('parties', 'USER can INSERT a business record', (cu.status === 201 || cu.status === 200) && cu.rows.length > 0, `status=${cu.status}`)
    const co = await rest(owner, 'GET', '/parties?select=id&name=like.*MATRIX-TEST*')
    check('parties', 'OWNER sees the USER-created record (no per-user filtering)', co.status === 200 && co.rows.length >= 1, `rows=${co.rows.length}`)

    const uo2 = await rest(owner, 'POST', '/parties?select=id,name', { name: 'MATRIX-TEST shared party (owner)' })
    check('parties', 'OWNER can INSERT a business record', (uo2.status === 201 || uo2.status === 200) && uo2.rows.length > 0, `status=${uo2.status}`)
    const cu2 = await rest(user, 'GET', '/parties?select=id&name=like.*MATRIX-TEST*')
    check('parties', 'USER sees the OWNER-created record (no per-user filtering)', cu2.status === 200 && cu2.rows.length >= 2, `rows=${cu2.rows.length}`)

    const du = await rest(user, 'DELETE', '/parties?name=like.*MATRIX-TEST (owner)*')
    check('parties', 'USER can DELETE business records (shared write access)', du.status === 200 || du.status === 204, `status=${du.status}`)
    const del = await rest(owner, 'DELETE', '/parties?name=like.*MATRIX-TEST*')
    check('parties', 'OWNER can DELETE business records', del.status === 200 || del.status === 204, `status=${del.status}`)

    for (const [key, tok] of blocked) {
      const ins = await rest(tok, 'POST', '/parties', { name: 'DENIED' })
      check('parties', `${key} CANNOT INSERT business records`, isDenied(ins), `status=${ins.status}`)
    }
  }

  // ─── GROUP: sales / financial years / whatsapp settings ─────────────────
  {
    const r = await rest(owner, 'GET', '/sales?select=id&limit=3')
    check('business', 'OWNER can SELECT sales', r.status === 200 && r.rows.length > 0, `status=${r.status}`)
    const r2 = await rest(user, 'GET', '/sales?select=id&limit=3')
    check('business', 'USER can SELECT sales (shared data)', r2.status === 200 && r2.rows.length > 0, `status=${r2.status} rows=${r2.rows.length}`)
    for (const [key, tok] of blocked) {
      const rr = await rest(tok, 'GET', '/sales?select=id&limit=3')
      check('business', `${key} CANNOT SELECT sales`, isDenied(rr) || emptyOk(rr), `status=${rr.status}`)
    }

    const fy = await rest(user, 'GET', '/financial_years?select=id')
    check('business', 'USER can SELECT financial years', fy.status === 200 && fy.rows.length >= 3, `status=${fy.status}`)

    const ws = await rest(user, 'GET', '/whatsapp_settings?select=auto_send_sale')
    check('whatsapp', 'USER can READ whatsapp settings (shared store config)', ws.status === 200 && ws.rows.length === 1, `status=${ws.status} rows=${ws.rows.length}`)
    const wsu = await rest(user, 'PATCH', '/whatsapp_settings?select=id&singleton=eq.1', { auto_send_sale: false })
    check('whatsapp', 'USER CANNOT write whatsapp settings', isDenied(wsu) || emptyOk(wsu), `status=${wsu.status}`)
    const wso = await rest(owner, 'PATCH', '/whatsapp_settings?select=id&singleton=eq.1', { auto_send_sale: true })
    check('whatsapp', 'OWNER can write whatsapp settings', wso.status === 200 || wso.status === 204, `status=${wso.status}`)
  }

  // ─── GROUP: public.users access + role escalation (§32/§56) ─────────────
  {
    const selfU = await rest(user, 'GET', `/users?select=id,user_type&id=eq.${userId}`)
    check('users', 'USER can SELECT own public.users row (self-read)', selfU.status === 200 && selfU.rows.length === 1, `status=${selfU.status}`)

    const allO = await rest(owner, 'GET', '/users?select=id')
    const allU = await rest(user, 'GET', '/users?select=id')
    check('users', 'OWNER can SELECT all users rows', allO.status === 200 && allO.rows.length === 4, `rows=${allO.rows.length}`)
    check('users', 'USER sees ONLY own row (no owner read-all)', allU.status === 200 && allU.rows.length === 1, `rows=${allU.rows.length}`)

    const esc1 = await rest(user, 'PATCH', `/users?id=eq.${userId}`, { user_type: 'owner' })
    check('escalation', 'USER cannot update own user_type -> owner', isDenied(esc1), `status=${esc1.status}`)
    const esc2 = await rest(user, 'PATCH', `/users?id=eq.${userId}`, { user_type: null })
    check('escalation', 'USER cannot update own user_type -> NULL', isDenied(esc2), `status=${esc2.status}`)
    const esc3 = await rest(user, 'PATCH', `/users?id=eq.${unverifiedId}`, { user_type: 'owner' })
    check('escalation', 'USER cannot update ANOTHER user\'s user_type', isDenied(esc3), `status=${esc3.status}`)
    const esc4 = await rest(user, 'POST', '/users', { id: '00000000-0000-4000-8000-000000000099', user_type: 'owner' })
    check('escalation', 'USER cannot insert a fake owner row', isDenied(esc4), `status=${esc4.status}`)
    const esc5 = await rest(nullRole, 'PATCH', `/users?id=eq.${IDS['null-role@fusionone.test'].id}`, { user_type: 'owner' })
    check('escalation', 'NULL user cannot promote self to owner', isDenied(esc5), `status=${esc5.status}`)
    const esc6 = await rest(noRow, 'POST', '/users', { id: IDS['no-row@fusionone.test'].id, user_type: 'owner' })
    check('escalation', 'NO_APP_ROW user cannot insert own row as owner', isDenied(esc6), `status=${esc6.status}`)
    const esc7 = await rest(userUnverified, 'PATCH', `/users?id=eq.${unverifiedId}`, { user_type: 'owner' })
    check('escalation', 'UNVERIFIED user cannot promote self', isDenied(esc7), `status=${esc7.status}`)
    const esc8 = await rest(owner, 'PATCH', `/users?id=eq.${userId}`, { user_type: 'owner' })
    check('escalation', 'Even OWNER cannot change user_type via the API (server-side only)', isDenied(esc8), `status=${esc8.status}`)
  }

  // ─── GROUP: RPC authorization ───────────────────────────────────────────
  {
    const rpcSetup = async (tok: string | null) => {
      const res = await fetch(`${URL_}/rest/v1/rpc/complete_store_setup`, {
        method: 'POST',
        headers: { apikey: PUB, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { name: 'X', phone: '1', bank_name: 'B', fy_start: '2026-04-01', fy_end: '2027-03-31' } }),
      })
      return { status: res.status, text: await res.text() }
    }
    const r1 = await rpcSetup(user)
    check('rpc', 'complete_store_setup as USER rejected (owner required)', /Owner access is required/i.test(r1.text), `status=${r1.status}`)
    const r2 = await rpcSetup(nullRole)
    check('rpc', 'complete_store_setup as NULL rejected (owner required)', /Owner access is required/i.test(r2.text), `status=${r2.status}`)

    // Business RPC as USER: allowed (shared business operation)
    const r3 = await rest(user, 'POST', '/rpc/allocate_bill_numbers', { p_fy_id: FY_ID, p_sales: 0, p_purchases: 0, p_proformas: 0 })
    check('rpc', 'Business RPC (allocate_bill_numbers) works for USER', r3.status === 200, `status=${r3.status} ${r3.message ?? ''}`)
    const r4 = await rest(nullRole, 'POST', '/rpc/allocate_bill_numbers', { p_fy_id: FY_ID })
    check('rpc', 'Business RPC denied for NULL role', isDenied(r4) || /not found/i.test(r4.message ?? ''), `status=${r4.status}`)
  }

  // ─── GROUP: OWNER_UNVERIFIED (temporarily unconfirm the real owner) ─────
  {
    await sql`UPDATE auth.users SET email_confirmed_at = NULL WHERE id = ${OWNER.id}::uuid`
    const tok = await getToken(OWNER)
    console.log('--- OWNER_UNVERIFIED: token =', tok ? 'obtained (RLS must deny everything)' : 'SIGN-IN REFUSED (verification gate)')
    if (tok) {
      const r1 = await rest(tok, 'GET', '/store?select=id')
      check('owner-unverified', 'OWNER_UNVERIFIED cannot SELECT store', isDenied(r1) || emptyOk(r1), `status=${r1.status}`)
      const r2 = await rest(tok, 'GET', '/parties?select=id&limit=3')
      check('owner-unverified', 'OWNER_UNVERIFIED cannot SELECT business data', isDenied(r2) || emptyOk(r2), `status=${r2.status}`)
      const r3 = await rest(tok, 'POST', '/parties', { name: 'X' })
      check('owner-unverified', 'OWNER_UNVERIFIED cannot INSERT business data', isDenied(r3), `status=${r3.status}`)
    } else {
      check('owner-unverified', 'OWNER_UNVERIFIED cannot even sign in (native verification gate)', true)
    }
    await sql`UPDATE auth.users SET email_confirmed_at = now() WHERE id = ${OWNER.id}::uuid`
    const tok2 = await getToken(OWNER)
    check('owner-unverified', 'OWNER restored -> access returns', !!tok2)
  }

  // ─── GROUP: structural invariants (privileged postgres) ─────────────────
  {
    let secondStoreRejected = false
    try {
      await sql`INSERT INTO public.store (name, phone) VALUES ('PRIVILEGED SECOND', '000')`
    } catch (e: any) {
      secondStoreRejected = /duplicate key|unique constraint/i.test(String(e?.message ?? e))
    }
    check('invariant', 'Privileged INSERT of a second store REJECTED by database', secondStoreRejected)

    let secondOwnerRejected = false
    try {
      await sql`INSERT INTO public.users (id, user_type) VALUES (${userId}::uuid, 'owner') ON CONFLICT (id) DO UPDATE SET user_type = 'owner'`
    } catch (e: any) {
      secondOwnerRejected = /duplicate key|unique constraint/i.test(String(e?.message ?? e))
    }
    check('invariant', 'Second owner REJECTED by database (unique partial index)', secondOwnerRejected)

    // Concurrent store setup: two parallel RPC calls must yield exactly one store
    await Promise.allSettled([
      sql`SELECT public.complete_store_setup('{"name":"C1","phone":"1","bank_name":"B","fy_start":"2030-04-01","fy_end":"2031-03-31"}'::jsonb)`,
      sql`SELECT public.complete_store_setup('{"name":"C2","phone":"1","bank_name":"B","fy_start":"2032-04-01","fy_end":"2033-03-31"}'::jsonb)`,
    ])
    const storeCount = (await sql`SELECT count(*)::int AS n FROM public.store`)[0].n
    check('invariant', 'Concurrent setup attempts -> still exactly ONE store', storeCount === 1, `count=${storeCount}`)
    const orphanFys = (await sql`SELECT count(*)::int AS n FROM public.financial_years WHERE start_date IN ('2030-04-01','2032-04-01')`)[0].n
    check('invariant', 'Failed setup attempt rolled back completely (no orphan FY rows)', orphanFys === 0, `orphans=${orphanFys}`)
    check('invariant', 'COUNT(store) <= 1', storeCount === 1)

    const ownerCount = (await sql`SELECT count(*)::int AS n FROM public.users WHERE user_type = 'owner'`)[0].n
    check('invariant', 'COUNT(users WHERE user_type=owner) <= 1', ownerCount === 1, `count=${ownerCount}`)
  }

  await sql.end()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== MATRIX RESULT: ${results.length - failed.length}/${results.length} PASS ===`)
  if (failed.length > 0) {
    console.log('FAILURES:')
    for (const f of failed) console.log(`  FAIL [${f.group}] ${f.name} ${f.note ?? ''}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
