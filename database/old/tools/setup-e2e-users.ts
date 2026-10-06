/**
 * E2E test-data setup: create the two edge-state accounts the routing
 * matrix needs (mirroring how the real invite path provisions them).
 *   * user-unverified@fusionone.test — unconfirmed email + user_type='user'
 *   * user-null@fusionone.test       — confirmed email + user_type NULL
 * Idempotent: skips creation when the account already exists.
 */
const SB = 'https://egdrnhtmclvhsfjvhyam.supabase.co'
const SECRET = 'sb_secret_REDACTED'

async function adminApi(path: string, method: string, body?: unknown) {
  const res = await fetch(`${SB}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SECRET, Authorization: `Bearer ${SECRET}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}

// 1. unverified user: createUser does NOT confirm the email
let r = await adminApi('/auth/v1/admin/users', 'POST', {
  email: 'user-unverified@fusionone.test',
  password: 'FusionOne#2026',
  email_confirm: false,
})
console.log('create user-unverified:', r.status, r.json?.id ?? r.json?.msg ?? r.json?.message ?? '')
const unverifiedId = r.json?.id

// provision as 'user' (the invite path's role)
if (unverifiedId) {
  r = await adminApi(`/rest/v1/users?id=eq.${unverifiedId}`, 'PATCH', { user_type: 'user', status: 'active' })
  console.log('provision user-unverified (user/active):', r.status)
}

// 2. NULL-role user: createUser WITH email_confirm → trigger provisions user_type NULL
r = await adminApi('/auth/v1/admin/users', 'POST', {
  email: 'user-null@fusionone.test',
  password: 'FusionOne#2026',
  email_confirm: true,
})
console.log('create user-null:', r.status, r.json?.id ?? r.json?.msg ?? r.json?.message ?? '')
const nullId = r.json?.id

if (nullId) {
  // ensure the row exists with NULL role (trigger should have created it)
  r = await adminApi(`/rest/v1/users?id=eq.${nullId}&select=id,user_type,status`, 'GET')
  console.log('user-null row:', JSON.stringify(r.json))
}
