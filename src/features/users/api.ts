/**
 * User-management API client (owner-only backend endpoints).
 *
 * Calls the backend's user-management routes with the caller's Supabase JWT —
 * the same authenticated-backend pattern as the WhatsApp client, reusing its
 * URL builder (same-origin + gateway port hint). The backend re-resolves the
 * caller (verified + ACTIVE + owner) on every request; the frontend owner
 * gate is UX only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import { waUrl } from '@/platform/whatsapp/url'

/** Derived presentation state for a managed user (backend-derived, not a
 *  duplicate database column): the exact states the Profile UI renders. */
export type ManagedUserState = 'active' | 'blocked' | 'invitation_pending'

/** Application roles the owner can assign. NULL is the internal fail-closed
 *  unprovisioned state and is never exposed as a selectable role. */
export type AppRole = 'owner' | 'user'

/** A managed user row — exactly the fields the Profile UI needs. */
export interface AppUserView {
  id: string
  email: string | null
  /** Personal display name (null = not set yet; never generated from email). */
  displayName: string | null
  userType: 'owner' | 'user' | null
  status: 'active' | 'blocked'
  emailConfirmed: boolean
  createdAt: string | null
  lastSignInAt: string | null
  state: ManagedUserState
}

async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const token = data.session?.access_token
  if (!token) throw new Error('Authentication required.')
  return token
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) return body.error.message
  } catch {
    // not JSON
  }
  return `Backend returned HTTP ${res.status}: ${res.statusText}`
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const token = await accessToken()
  const res = await fetch(waUrl(path), {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(init.timeoutMs ?? 30000),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return (await res.json()) as T
}

/** The owner's managed-user list (backend: owner-only, managed users only). */
export async function fetchUsers(): Promise<AppUserView[]> {
  const body = await call<{ users: AppUserView[] }>('/api/users', { timeoutMs: 15000 })
  return body.users ?? []
}

/** Invite a new user by email (native Supabase invitation → /set-password). */
export async function inviteUser(email: string): Promise<void> {
  await call('/api/users/invite', { method: 'POST', body: { email }, timeoutMs: 30000 })
}

/** Resend a genuinely pending invitation (fresh native invite link). */
export async function resendInvite(userId: string): Promise<void> {
  await call(`/api/users/${encodeURIComponent(userId)}/resend-invite`, { method: 'POST' })
}

/** Block a user (status = 'blocked'; enforced by backend + RLS + resolver). */
export async function blockUser(userId: string): Promise<void> {
  await call(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' })
}

/** Unblock a user (status = 'active'; role and data untouched). */
export async function unblockUser(userId: string): Promise<void> {
  await call(`/api/users/${encodeURIComponent(userId)}/unblock`, { method: 'POST' })
}

/** Send the native password-recovery email (→ /set-password). */
export async function resetUserPassword(userId: string): Promise<void> {
  await call(`/api/users/${encodeURIComponent(userId)}/reset-password`, { method: 'POST' })
}

/** Change a user's role (owner ⇄ user; owner-only backend endpoint, full
 *  validation chain server-side — the dropdown alone never saves anything). */
export async function changeUserRole(userId: string, role: AppRole): Promise<void> {
  await call(`/api/users/${encodeURIComponent(userId)}/role`, {
    method: 'POST',
    body: { role },
  })
}

/** Permanently remove a user's account (shared business data is preserved). */
export async function removeUser(userId: string): Promise<void> {
  await call(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

/** Owner's user list (the backend enforces the owner-only rule). */
export function useUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['users'],
    enabled,
    staleTime: 30 * 1000,
    queryFn: fetchUsers,
  })
}

/** Shared invalidation: refresh ONLY the users list after a mutation — the
 *  rest of the Profile (and all business data) keeps its cached state. */
function useInvalidateUsers() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['users'] })
}

/** Invite a new user by email (owner-only). */
export function useInviteUser() {
  const invalidate = useInvalidateUsers()
  return useMutation({
    mutationFn: (email: string) => inviteUser(email),
    onSuccess: () => {
      void invalidate()
    },
  })
}

/** Any single-target owner management mutation (resend/block/unblock/reset/
 *  remove). One factory: identical pending/invalidation semantics. */
export function useUserAction(
  action: (userId: string) => Promise<void>,
): ReturnType<typeof useMutation<void, Error, string>> {
  const invalidate = useInvalidateUsers()
  return useMutation({
    mutationFn: action,
    onSuccess: () => {
      void invalidate()
    },
  })
}

/** Change a user's role (owner-only). Invalidates the users list so the new
 *  role shows immediately — no page reload. */
export function useChangeUserRole() {
  const invalidate = useInvalidateUsers()
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AppRole }) => changeUserRole(userId, role),
    onSuccess: () => {
      void invalidate()
    },
  })
}
