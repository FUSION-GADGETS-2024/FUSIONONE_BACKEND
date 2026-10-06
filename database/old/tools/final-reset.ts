import postgres from 'postgres'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
// Final state: all display_names NULL (Phase 28 post-migration state; no invented names)
await sql`update public.users set display_name = null`
const rows = await sql`select u.user_type, u.status, u.display_name, a.email, a.email_confirmed_at is not null as verified from public.users u join auth.users a on a.id = u.id order by a.email`
console.log('=== FINAL STATE ===')
for (const r of rows) console.log(`${r.email} | ${r.user_type} | ${r.status} | verified=${r.verified} | name=${JSON.stringify(r.display_name)}`)
const store = await sql`select onboarding_complete from public.store limit 1`
console.log('store onboarding_complete:', store[0].onboarding_complete)
await sql.end()
