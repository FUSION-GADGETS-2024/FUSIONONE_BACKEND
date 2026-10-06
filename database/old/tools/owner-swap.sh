#!/bin/bash
# Guarded owner swap: usage `./owner-swap.sh swap` or `./owner-swap.sh restore`
cd /home/z/my-project/database/tools
if [ "$1" = "swap" ]; then
  bun run - << 'TS'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
await sql`update public.users set user_type = 'user' where id = (select id from auth.users where email = 'wamiq.khan2023@gmail.com')`
await sql`update public.users set user_type = 'owner', status = 'active' where id = (select id from auth.users where email = 'owner@fusionone.test')`
const rows = await sql`select u.user_type, u.display_name, a.email from public.users u join auth.users a on a.id = u.id order by a.email`
for (const r of rows) console.log(`${r.email} | ${r.user_type} | name=${JSON.stringify(r.display_name)}`)
await sql.end()
TS
elif [ "$1" = "restore" ]; then
  bun run - << 'TS'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
await sql`update public.users set user_type = 'user' where id = (select id from auth.users where email = 'owner@fusionone.test')`
await sql`update public.users set user_type = 'owner', status = 'active' where id = (select id from auth.users where email = 'wamiq.khan2023@gmail.com')`
const rows = await sql`select u.user_type, a.email from public.users u join auth.users a on a.id = u.id order by a.email`
for (const r of rows) console.log(`${r.email} | ${r.user_type}`)
await sql.end()
TS
fi
