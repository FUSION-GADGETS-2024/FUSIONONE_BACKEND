/**
 * Self-service display-name update — the ONE mechanism both /profile-setup
 * and the Profile name edit use (the profile is completed/changed only
 * through the NORMAL application session).
 *
 * Security: the browser updates exactly ONE column of the caller's OWN row
 * through public.users' narrow RLS boundary — the
 * users_self_update_display_name policy (own row + verified + ACTIVE +
 * owner/user + amr 'password') together with the column-level UPDATE
 * privilege (GRANT UPDATE (display_name) only). The database itself
 * rejects anything else; there is no backend path and no setup-auth
 * involvement (an invitation/recovery session can never write the name).
 *
 * Validation mirrors the database contract exactly (migration 0014):
 * trim → non-empty → maximum 80 characters. The database additionally
 * normalizes (btrim trigger) and enforces the same CHECK constraint.
 */
import { supabase } from '@/platform/supabase/client'

export const DISPLAY_NAME_MAX_LENGTH = 80

export type DisplayNameUpdateResult =
  | { ok: true; displayName: string }
  | { ok: false; message: string }

/** Trim + validate against the same rule the database enforces. */
export function validateDisplayName(
  raw: string,
): { valid: boolean; value: string; message: string | null } {
  const value = raw.trim()
  if (value.length === 0) {
    return { valid: false, value, message: 'Please enter your name.' }
  }
  if (value.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      valid: false,
      value,
      message: `Names are limited to ${DISPLAY_NAME_MAX_LENGTH} characters.`,
    }
  }
  return { valid: true, value, message: null }
}

/** Map a failed update to a human-readable message — raw Postgres errors
 *  are never surfaced to the user. */
function mapUpdateError(err: { code?: string; message?: string }): string {
  const message = err.message ?? ''
  if (err.code === '42501' || /permission denied|row-level security/i.test(message)) {
    return 'Your account cannot update its name right now. Please sign in again and try again.'
  }
  if (err.code === '23514' || /check constraint/i.test(message)) {
    return `That name is not valid. Use 1–${DISPLAY_NAME_MAX_LENGTH} characters (after trimming).`
  }
  if (/network|fetch|timeout|Failed to fetch/i.test(message)) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  return 'Could not save your name. Please try again.'
}

/**
 * Update the caller's own display_name. Resolves ONLY after confirmed
 * database success (the returned row is authoritative); a failure keeps
 * the previous value untouched and carries a mapped message.
 */
export async function updateOwnDisplayName(
  userId: string,
  rawName: string,
): Promise<DisplayNameUpdateResult> {
  const { valid, value, message } = validateDisplayName(rawName)
  if (!valid) return { ok: false, message: message! }

  const { data, error } = await supabase
    .from('users')
    .update({ display_name: value })
    .eq('id', userId)
    .select('display_name')
    .single()

  if (error) {
    return { ok: false, message: mapUpdateError(error) }
  }
  const stored = (data as { display_name?: string | null } | null)?.display_name
  return {
    ok: true,
    displayName: typeof stored === 'string' && stored.trim().length > 0 ? stored : value,
  }
}
