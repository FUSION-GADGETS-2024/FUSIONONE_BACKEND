import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

const exts = await sql`select extname from pg_extension order by 1`
console.log('EXTENSIONS:', exts.map(e => e.extname).join(', '))
const schemas = await sql`select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`
console.log('SCHEMAS:', schemas.map(s => s.nspname).join(', '))
const tables = await sql`select table_schema, table_name from information_schema.tables where table_schema in ('public','storage','auth') order by 1,2`
console.log('TABLES:', tables.length ? tables.map(t => `${t.table_schema}.${t.table_name}`).join(', ') : '(none)')
const roles = await sql`select rolname from pg_roles where rolname in ('anon','authenticated','service_role','supabase_admin','postgres')`
console.log('ROLES:', roles.map(r => r.rolname).join(', '))
const funcs = await sql`select proname, pronamespace::regnamespace from pg_proc where pronamespace = 'public'::regnamespace`
console.log('PUBLIC FUNCS:', funcs.length ? funcs.map(f => f.proname).join(', ') : '(none)')
await sql.end()
