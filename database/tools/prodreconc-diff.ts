/**
 * FUSIONONE — PRODUCTION SCHEMA RECONCILIATION: structural diff between the
 * TEST reference inventory and the production inventory (read-only, offline —
 * compares the two JSON files produced by prodreconc-inspect.ts).
 *
 * Reports differences per dimension; data-dependent dimensions (row counts,
 * fingerprints, totals) are intentionally NOT compared across projects (TEST
 * and production hold different business data by design) — they exist in the
 * inventory for PROD pre/post-migration preservation checks.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const A = JSON.parse(readFileSync('/home/z/prodreconc/inspection/testref.json', 'utf8')) // reference (TEST)
const B = JSON.parse(readFileSync(process.argv[2] ?? '/home/z/prodreconc/inspection/prod-pre.json', 'utf8')) // production

const lines: string[] = []
const note = (s: string) => lines.push(s)

// ── Tables (name, rls, columns — row_count is data-dependent, excluded) ─────
const tA = new Map((A.tables as { name: string; rls: boolean; columns: unknown[] }[]).map((t) => [t.name, { rls: t.rls, columns: t.columns }]))
const tB = new Map((B.tables as { name: string; rls: boolean; columns: unknown[] }[]).map((t) => [t.name, { rls: t.rls, columns: t.columns }]))
const onlyA = [...tA.keys()].filter((k) => !tB.has(k))
const onlyB = [...tB.keys()].filter((k) => !tA.has(k))
note(`TABLES: ref=${tA.size} prod=${tB.size}`)
if (onlyA.length) note(`  tables ONLY in reference: ${onlyA.join(', ')}`)
if (onlyB.length) note(`  tables ONLY in production: ${onlyB.join(', ')}`)
for (const k of [...tA.keys()].filter((k) => tB.has(k))) {
  const a = JSON.stringify(tA.get(k))
  const b = JSON.stringify(tB.get(k))
  if (a !== b) {
    note(`  TABLE DIFFERS: ${k}`)
    const ca = tA.get(k)!.columns as Record<string, unknown>[]
    const cb = tB.get(k)!.columns as Record<string, unknown>[]
    const namesA = ca.map((c) => c.column_name)
    const namesB = cb.map((c) => c.column_name)
    for (const n of namesA.filter((n) => !namesB.includes(n))) note(`    column only in ref: ${n}`)
    for (const n of namesB.filter((n) => !namesA.includes(n))) note(`    column only in prod: ${n}`)
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
      if (JSON.stringify(ca[i]) !== JSON.stringify(cb[i])) {
        note(`    column differs: ref=${JSON.stringify(ca[i])} prod=${JSON.stringify(cb[i])}`)
      }
    }
    if (tA.get(k)!.rls !== tB.get(k)!.rls) note(`    rls: ref=${tA.get(k)!.rls} prod=${tB.get(k)!.rls}`)
  }
}

// ── Simple array dimensions ──────────────────────────────────────────────────
const dims: [string, (x: Record<string, unknown>) => unknown][] = [
  ['INDEXES', (x) => x.indexes],
  ['CONSTRAINTS', (x) => x.constraints],
  ['TRIGGERS', (x) => x.triggers],
  ['POLICIES', (x) => x.policies],
  ['TABLE_ACLS', (x) => x.table_acls],
  ['FUNCTION_ACLS', (x) => x.function_acls],
  ['EVENT_TRIGGERS', (x) => x.event_triggers],
]
for (const [name, get] of dims) {
  const a = get(A) as string[]
  const b = get(B) as string[]
  const setA = new Set(a), setB = new Set(b)
  const onlyRef = a.filter((x) => !setB.has(x))
  const onlyProd = b.filter((x) => !setA.has(x))
  note(`${name}: ref=${a.length} prod=${b.length} ${onlyRef.length + onlyProd.length === 0 ? 'IDENTICAL' : 'DIFFER'}`)
  for (const x of onlyRef) note(`  only-in-ref : ${x.length > 300 ? x.slice(0, 300) + '…' : x}`)
  for (const x of onlyProd) note(`  only-in-prod: ${x.length > 300 ? x.slice(0, 300) + '…' : x}`)
}

// ── Extensions (public schema) ───────────────────────────────────────────────
{
  const a = JSON.stringify(A.public_extensions)
  const b = JSON.stringify(B.public_extensions)
  note(`PUBLIC_EXTENSIONS: ${a === b ? 'IDENTICAL' : `DIFFER ref=${a} prod=${b}`}`)
}

// ── Functions (signature + body fingerprint) ─────────────────────────────────
{
  const fa = (A.functions as { schema: string; name: string; args: string; body_md5: string }[])
  const fb = (B.functions as { schema: string; name: string; args: string; body_md5: string }[])
  const key = (f: { schema: string; name: string; args: string }) => `${f.schema}.${f.name}(${f.args})`
  const mapA = new Map(fa.map((f) => [key(f), f.body_md5]))
  const mapB = new Map(fb.map((f) => [key(f), f.body_md5]))
  const onlyRef = [...mapA.keys()].filter((k) => !mapB.has(k))
  const onlyProd = [...mapB.keys()].filter((k) => !mapA.has(k))
  const bodyDiff = [...mapA.keys()].filter((k) => mapB.has(k) && mapA.get(k) !== mapB.get(k))
  note(`FUNCTIONS: ref=${fa.length} prod=${fb.length}`)
  for (const k of onlyRef) note(`  signature only in ref : ${k}`)
  for (const k of onlyProd) note(`  signature only in prod: ${k}`)
  for (const k of bodyDiff) note(`  BODY DIFFERS: ${k}`)
}

// ── Migration bookkeeping ────────────────────────────────────────────────────
{
  const a = A.schema_migrations as string[]
  const b = B.schema_migrations as string[]
  const missing = a.filter((x) => !b.includes(x))
  const extra = b.filter((x) => !a.includes(x))
  note(`SCHEMA_MIGRATIONS: ref=${a.length} prod=${b.length}`)
  for (const x of missing) note(`  recorded in ref but NOT prod: ${x}`)
  for (const x of extra) note(`  recorded in prod but NOT ref: ${x}`)
}

console.log(lines.join('\n'))
