/**
 * Creates (or recreates) the deterministic TEST owner user in the TEST
 * Supabase Auth project via the admin API (secret key — tooling only).
 *
 * Outputs the user id so the seed script can reference it.
 * Usage: bun run create-test-user.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
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
const URL_ = env.TEST_SUPABASE_URL
const SECRET = env.TEST_SUPABASE_SECRET_KEY
const EMAIL = env.TEST_USER_EMAIL ?? 'owner@fusionone.test'
const PASSWORD = env.TEST_USER_PASSWORD ?? 'FusionOne#2026'

async function admin(path: string, init?: RequestInit) {
  return fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function main() {
  // Remove any existing user with the same email (deterministic re-runs).
  const listRes = await admin(`/auth/v1/admin/users?per_page=1000`)
  const { users } = (await listRes.json()) as { users: Array<{ id: string; email: string }> }
  for (const u of users) {
    if (u.email === EMAIL) {
      console.log(`Deleting existing test user ${u.email} (${u.id})`)
      await admin(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' })
    }
  }

  const createRes = await admin(`/auth/v1/admin/users`, {
    method: 'POST',
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'FUSION GADGETS Owner (Test)' },
    }),
  })
  if (!createRes.ok) {
    throw new Error(`User creation failed: ${createRes.status} ${await createRes.text()}`)
  }
  const user = (await createRes.json()) as { id: string; email: string }
  console.log(`Created test owner user: ${user.email} -> ${user.id}`)

  writeFileSync(join(HERE, '.test-user.json'), JSON.stringify(user, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
