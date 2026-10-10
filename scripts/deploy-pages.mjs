// FUSIONONE — Pages deploy bridge.
//
// `wrangler pages deploy` does not read wrangler.jsonc natively, so this
// script makes wrangler.jsonc the single source of truth:
//   1. Reads `vars` from wrangler.jsonc and exports them as env.
//   2. Runs `npm run build` (Vite bakes VITE_* into the bundle).
//   3. Uploads `dist/` via `wrangler pages deploy` to `name`.
//
// Usage: npm run deploy:pages
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const raw = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')

// Strip // and /* */ comments to get plain JSON.
const json = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
const config = JSON.parse(json)

if (!config.name) throw new Error('wrangler.jsonc: missing "name"')
const vars = config.vars ?? {}
const outDir = config.pages_build_output_dir ?? 'dist'

const env = { ...process.env }
for (const [k, v] of Object.entries(vars)) env[k] = String(v)

console.log(`[deploy] project: ${config.name}`)
console.log(`[deploy] build env: ${Object.keys(vars).join(', ')}`)

execSync('npm run build', { cwd: root, stdio: 'inherit', env })
execSync(`npx wrangler pages deploy ${outDir} --project-name=${config.name}`, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
