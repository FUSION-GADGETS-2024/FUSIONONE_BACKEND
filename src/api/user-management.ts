/**
 * User management service — the trusted owner-controlled boundary.
 *
 * Every operation runs ONLY after requireOwner() re-resolved the caller
 * (JWT → verified email → ACTIVE account → user_type = owner) — a frontend
 * "isOwner" flag is never trusted. Privileged Auth administration uses the
 * server-only admin client from the Supabase boundary.
 *
 * Model: user_type owner | user | NULL (NULL = unprovisioned, fail-closed);
 * status active | blocked (independent of role).
 *
 * Invariants (the owner count is additionally trigger-enforced in the DB —
 * migration 0005):
 *   * never zero owners — a demotion only proceeds while another ACTIVE
 *     owner remains, and the owner is never a self-target
 *   * block / unblock / reset / remove / resend keep targeting user_type =
 *     'user' only; only changeUserRole can target another owner
 *   * role changes go ONLY through changeUserRole: 'owner' | 'user' — NULL
 *     stays the internal fail-closed state and can never be assigned
 *   * shared business data is NEVER tied to user lifecycle — removing a user
 *     deletes only the Auth account (public.users follows via FK cascade)
 *   * invitation / password-reset use NATIVE Supabase Auth emails redirecting
 *     to /set-password; no custom tokens, no owner-set passwords
 */
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/logger.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import { requireAdminClient, getMailClient } from '../supabase/clients.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A provisioned application user (owner | user) as shown in the Users list. */
interface ProvisionedUserRow {
  id: string;
  email: string | null;
  status: 'active' | 'blocked';
  emailConfirmed: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
}

/** The GET /api/users row — exactly what the Profile UI needs, nothing more. */
export interface ManagedUserView {
  id: string;
  email: string | null;
  /** Personal display name (public.users.display_name; null = not set yet). */
  displayName: string | null;
  userType: 'owner' | 'user';
  status: 'active' | 'blocked';
  emailConfirmed: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
  /** Derived presentation state (no duplicate database column). */
  state: 'active' | 'blocked' | 'invitation_pending';
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || !EMAIL_PATTERN.test(email) || email.length > 320) {
    throw new AppError(ErrorCode.API_REQUEST_INVALID, {
      message: 'A valid email address is required.',
    });
  }
  return email;
}

/** Require a well-formed UUID target id (400 for malformed, 404 for unknown). */
function requireTargetId(raw: string): string {
  if (!UUID_PATTERN.test(raw)) {
    throw new AppError(ErrorCode.API_REQUEST_INVALID, {
      message: 'A valid user id is required.',
    });
  }
  return raw;
}

/** The public app origin for native Auth email links (→ /set-password). */
function requireAppBaseUrl(): string {
  const cfg = getConfig();
  if (!cfg.appBaseUrl) {
    throw new AppError(ErrorCode.SERVER_NOT_READY, {
      message: 'User management is not configured on this server.',
      internalDetails: { reason: 'APP_BASE_URL missing' },
    });
  }
  return cfg.appBaseUrl;
}

/** All auth users, following listUsers pagination (admin API). */
async function listAllAuthUsers(admin: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  let page = 1;
  for (;;) {
    const res = await admin.auth.admin.listUsers({ page, perPage: 500 });
    if (res.error) {
      throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
        internalDetails: { step: 'admin.listUsers', cause: res.error.message },
      });
    }
    users.push(...res.data.users);
    if (!res.data.nextPage) break;
    page = res.data.nextPage;
  }
  return users;
}

/**
 * Resolve the target of an owner management action. Only managed users
 * (user_type = 'user') can ever be targeted:
 *   * owner row      → explicit rejection (the owner manages, is never managed)
 *   * NULL / missing → not a managed user (fail closed, 404)
 */
async function requireManagedUser(admin: SupabaseClient, targetId: string): Promise<ProvisionedUserRow> {
  const { data, error } = await admin
    .from('users')
    .select('id, user_type, status, created_at')
    .eq('id', targetId)
    .maybeSingle();

  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      internalDetails: { step: 'users.select', pgError: error.message },
    });
  }

  const row = data as { id: string; user_type: string | null; status?: unknown; created_at?: string | null } | null;
  if (!row) {
    throw new AppError(ErrorCode.USER_NOT_FOUND);
  }
  if (row.user_type === 'owner') {
    // The single owner is displayed in the Profile Account section and can
    // never be managed, blocked or removed from the Users list.
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'The owner account cannot be managed this way.',
    });
  }
  if (row.user_type !== 'user') {
    // NULL / invalid role — not a provisioned managed user.
    throw new AppError(ErrorCode.USER_NOT_FOUND, {
      message: 'This account has not been invited to FUSION ONE.',
    });
  }

  const authRes = await admin.auth.admin.getUserById(targetId);
  if (authRes.error || !authRes.data.user) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      internalDetails: { step: 'admin.getUserById', cause: authRes.error?.message },
    });
  }
  const authUser = authRes.data.user;

  return {
    id: row.id,
    email: authUser.email ?? null,
    status: row.status === 'blocked' ? 'blocked' : 'active',
    emailConfirmed: authUser.email_confirmed_at != null,
    createdAt: authUser.created_at ?? row.created_at ?? null,
    lastSignInAt: authUser.last_sign_in_at ?? null,
  };
}

// ─── Operations ─────────────────────────────────────────────────────────────

/**
 * List the users the owner manages (Profile → Users): every provisioned
 * account (owner | user) EXCEPT the requester. NULL-role accounts are not
 * provisioned users and are not listed. Returns only the fields the UI
 * renders — no tokens, no Auth internals.
 */
export async function listManagedUsers(requesterId: string): Promise<ManagedUserView[]> {
  const admin = requireAdminClient();

  const appRes = await admin
    .from('users')
    .select('id, user_type, status, created_at, display_name')
    .in('user_type', ['owner', 'user'])
    .neq('id', requesterId);
  if (appRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      internalDetails: { step: 'users.select', pgError: appRes.error.message },
    });
  }

  const rows = (appRes.data ?? []) as {
    id: string;
    user_type?: unknown;
    status?: unknown;
    created_at?: string | null;
    display_name?: string | null;
  }[];
  if (rows.length === 0) return [];

  const appById = new Map(rows.map((r) => [r.id, r]));
  const authUsers = await listAllAuthUsers(admin);

  const users: ManagedUserView[] = [];
  for (const authUser of authUsers) {
    const row = appById.get(authUser.id);
    if (!row) continue; // not a provisioned user (NULL / orphan)
    const userType = row.user_type === 'owner' ? 'owner' : 'user';
    const status = row.status === 'blocked' ? 'blocked' : 'active';
    const emailConfirmed = authUser.email_confirmed_at != null;
    users.push({
      id: authUser.id,
      email: authUser.email ?? null,
      displayName: typeof row.display_name === 'string' ? row.display_name : null,
      userType,
      status,
      emailConfirmed,
      createdAt: authUser.created_at ?? row.created_at ?? null,
      lastSignInAt: authUser.last_sign_in_at ?? null,
      state: status === 'blocked' ? 'blocked' : emailConfirmed ? 'active' : 'invitation_pending',
    });
  }

  // Stable order: pending invitations first (actionable), then by email.
  users.sort((a, b) => {
    const rank = (u: ManagedUserView) => (u.state === 'invitation_pending' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.email ?? '').localeCompare(b.email ?? '');
  });

  return users;
}

/**
 * Invite a new user by email — native Supabase Admin invitation: no password
 * from the owner, no auto-confirm; the invitee receives Supabase's own
 * invitation email (redirect → /set-password) and the application row is
 * provisioned user_type = 'user', status = 'active'.
 */
export async function inviteUser(rawEmail: unknown): Promise<{ email: string }> {
  const admin = requireAdminClient();
  const appBaseUrl = requireAppBaseUrl();
  const email = normalizeEmail(rawEmail);

  // One account per email — duplicates get a clear conflict, never a silent
  // re-invite (a lost invitation is recoverable through resend / reset).
  const existing = await listAllAuthUsers(admin);
  if (existing.some((u) => (u.email ?? '').toLowerCase() === email)) {
    throw new AppError(ErrorCode.USER_ALREADY_EXISTS);
  }

  // Native Supabase invitation (admin API, secret key — server only).
  const invite = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appBaseUrl}/set-password`,
  });
  if (invite.error) {
    throw new AppError(ErrorCode.USER_INVITE_FAILED, {
      internalDetails: { step: 'admin.inviteUserByEmail', cause: invite.error.message },
    });
  }

  const invitedId = invite.data.user?.id;
  if (!invitedId) {
    throw new AppError(ErrorCode.USER_INVITE_FAILED, {
      internalDetails: { step: 'admin.inviteUserByEmail', reason: 'missing user id' },
    });
  }

  // The provisioning trigger created the application row with user_type NULL.
  // Resolve it to 'user' through THIS controlled path only. If this write
  // fails the row stays NULL → the invitee cannot access the app (fail closed).
  const { error: roleError } = await admin
    .from('users')
    .upsert({ id: invitedId, user_type: 'user', status: 'active' }, { onConflict: 'id' });
  if (roleError) {
    getLogger().error(
      { invitedId, pgError: roleError.message },
      'Invite role assignment failed (user remains NULL — fail closed)',
    );
    throw new AppError(ErrorCode.USER_INVITE_FAILED, {
      message:
        'The invitation was sent, but provisioning failed. The user cannot access the app yet — contact your administrator.',
      internalDetails: { step: 'users.upsert', pgError: roleError.message },
    });
  }

  getLogger().info({ invitedId }, 'User invited');
  return { email };
}

/**
 * Resend a genuinely pending invitation — a FRESH native invitation email
 * for a user_type = 'user' account whose email is still unconfirmed.
 *
 * Supabase exposes NO admin API that re-sends an invitation email for an
 * existing account (generateLink(type='invite') only CREATES a link — nothing
 * is delivered — verified live). The only native mechanism that actually
 * DELIVERS is inviteUserByEmail, which requires the account not to exist.
 * A pending invitee has never signed in and holds no application data, so
 * resending removes the pending Auth account (public.users follows via the
 * FK cascade) and issues a fresh invitation to the same address, then
 * re-provisions the row (user_type = 'user'). The user id changes —
 * semantically a new invitation, exactly like Add User for the same email.
 */
export async function resendInvitation(rawTargetId: string): Promise<{ email: string }> {
  const admin = requireAdminClient();
  const appBaseUrl = requireAppBaseUrl();
  const targetId = requireTargetId(rawTargetId);
  const target = await requireManagedUser(admin, targetId);

  if (target.emailConfirmed) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This user has already accepted their invitation.',
    });
  }
  if (!target.email) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This invitation has no email address to resend to.',
    });
  }

  // 1. Remove the never-used pending account (FK-cascades public.users).
  const removed = await admin.auth.admin.deleteUser(targetId);
  if (removed.error) {
    throw new AppError(ErrorCode.USER_ACTION_FAILED, {
      internalDetails: { step: 'admin.deleteUser(pending)', cause: removed.error.message },
    });
  }

  // 2. Fresh native invitation — the ONLY path that actually delivers. If
  //    this fails the pending account is gone (fail closed); retry Add User.
  const invite = await admin.auth.admin.inviteUserByEmail(target.email, {
    redirectTo: `${appBaseUrl}/set-password`,
  });
  if (invite.error) {
    getLogger().error(
      { email: target.email, cause: invite.error.message },
      'Resend: pending account removed but re-invite failed (fail closed)',
    );
    throw new AppError(ErrorCode.USER_INVITE_FAILED, {
      message:
        'The pending invitation was removed, but the new invitation email could not be sent. Try inviting the user again.',
      internalDetails: { step: 'admin.inviteUserByEmail(reinvite)', cause: invite.error.message },
    });
  }

  const invitedId = invite.data.user?.id;
  if (!invitedId) {
    throw new AppError(ErrorCode.USER_INVITE_FAILED, {
      internalDetails: { step: 'admin.inviteUserByEmail(reinvite)', reason: 'missing user id' },
    });
  }

  // 3. Re-provision the application row (trigger created it NULL).
  const { error: roleError } = await admin
    .from('users')
    .upsert({ id: invitedId, user_type: 'user', status: 'active' }, { onConflict: 'id' });
  if (roleError) {
    getLogger().error(
      { invitedId, pgError: roleError.message },
      'Resend: re-invite sent but provisioning failed (user remains NULL — fail closed)',
    );
    throw new AppError(ErrorCode.USER_INVITE_FAILED, {
      message:
        'The invitation was sent, but provisioning failed. The user cannot access the app yet — contact your administrator.',
      internalDetails: { step: 'users.upsert(reinvite)', pgError: roleError.message },
    });
  }

  getLogger().info({ from: targetId, to: invitedId }, 'Invitation resent (fresh native invite)');
  return { email: target.email };
}

/**
 * Block a managed user: status → 'blocked'. The block is enforced live per
 * request by every authorization layer (backend requireAuthorizedUser, RLS
 * helpers, frontend resolver) — never by session revocation: this Supabase
 * version has no admin API to revoke another user's sessions by id (verified
 * live), and an issued access token would survive revocation until expiry
 * anyway. Only verified, active users can be blocked — an unconfirmed
 * account is invitation-pending (resend or remove it instead).
 */
export async function blockUser(requesterId: string, rawTargetId: string): Promise<void> {
  const admin = requireAdminClient();
  const targetId = requireTargetId(rawTargetId);
  if (targetId === requesterId) {
    // Structurally impossible (requester is owner, target is 'user').
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'You cannot block your own account.',
    });
  }
  const target = await requireManagedUser(admin, targetId);

  if (!target.emailConfirmed) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This invitation is still pending. Resend it or remove the user instead.',
    });
  }
  if (target.status === 'blocked') {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This user is already blocked.',
    });
  }

  const { error } = await admin.from('users').update({ status: 'blocked' }).eq('id', targetId);
  if (error) {
    throw new AppError(ErrorCode.USER_ACTION_FAILED, {
      internalDetails: { step: 'users.update(blocked)', pgError: error.message },
    });
  }

  getLogger().info({ targetId }, 'User blocked');
}

/**
 * Unblock a managed user: status → 'active'. The role is never touched and
 * neither is any business data — the user simply regains application access.
 */
export async function unblockUser(requesterId: string, rawTargetId: string): Promise<void> {
  const admin = requireAdminClient();
  const targetId = requireTargetId(rawTargetId);
  if (targetId === requesterId) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'You cannot unblock your own account.',
    });
  }
  const target = await requireManagedUser(admin, targetId);

  if (target.status !== 'blocked') {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This user is not blocked.',
    });
  }

  const { error } = await admin.from('users').update({ status: 'active' }).eq('id', targetId);
  if (error) {
    throw new AppError(ErrorCode.USER_ACTION_FAILED, {
      internalDetails: { step: 'users.update(active)', pgError: error.message },
    });
  }

  getLogger().info({ targetId }, 'User unblocked');
}

/**
 * Send a password reset for a managed user — the NATIVE Supabase recovery
 * email, actually DELIVERED through resetPasswordForEmail (the admin
 * generateLink(type='recovery') API only creates a link — verified live).
 * The owner never chooses another user's password; only verified users are
 * eligible. Rate-limited by Supabase's own recover limits — surfaced as a
 * clear failure, never swallowed.
 */
export async function sendPasswordReset(rawTargetId: string): Promise<{ email: string }> {
  const admin = requireAdminClient();
  const appBaseUrl = requireAppBaseUrl();
  const targetId = requireTargetId(rawTargetId);
  const target = await requireManagedUser(admin, targetId);

  if (!target.emailConfirmed) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This invitation is still pending. Resend it instead — the user has no password yet.',
    });
  }
  if (!target.email) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This account has no email address to send the reset to.',
    });
  }

  const mail = getMailClient();
  const { error: sendError } = await mail.auth.resetPasswordForEmail(target.email, {
    redirectTo: `${appBaseUrl}/set-password`,
  });
  if (sendError) {
    throw new AppError(ErrorCode.USER_ACTION_FAILED, {
      message:
        sendError.status === 429
          ? 'Supabase rate limit reached for this email. Try again later.'
          : 'The password reset email could not be sent. Please try again.',
      internalDetails: { step: 'auth.resetPasswordForEmail', cause: sendError.message, status: sendError.status },
    });
  }

  getLogger().info({ targetId }, 'Password reset email sent');
  return { email: target.email };
}

/**
 * Change a user's role (owner ⇄ user) — requested from the Manage User
 * dialog after an owner-side confirmation. Validation at this privileged
 * mutation boundary:
 *   requester: authenticated + verified + ACTIVE + owner (requireOwner,
 *              re-resolved live — a frontend owner flag is never trusted)
 *   target:    exists · provisioned · not the requester · email confirmed ·
 *              not blocked
 *   role:      'owner' | 'user' only (NULL can never be assigned)
 *   invariant: a demotion must leave another ACTIVE owner — checked here
 *              for a clean error and trigger-enforced in the DB (0005).
 */
export async function changeUserRole(
  requesterId: string,
  rawTargetId: string,
  rawRole: unknown,
): Promise<{ role: 'owner' | 'user'; email: string | null }> {
  const admin = requireAdminClient();
  const targetId = requireTargetId(rawTargetId);

  if (rawRole !== 'owner' && rawRole !== 'user') {
    throw new AppError(ErrorCode.API_REQUEST_INVALID, {
      message: 'Role must be "owner" or "user".',
    });
  }
  const role: 'owner' | 'user' = rawRole;

  if (targetId === requesterId) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'You cannot change your own role.',
    });
  }

  // The target's application row must exist and be provisioned.
  const { data, error } = await admin
    .from('users')
    .select('id, user_type, status')
    .eq('id', targetId)
    .maybeSingle();
  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      internalDetails: { step: 'users.select', pgError: error.message },
    });
  }
  const row = data as { id: string; user_type: string | null; status?: unknown } | null;
  if (!row) {
    throw new AppError(ErrorCode.USER_NOT_FOUND);
  }
  if (row.user_type !== 'owner' && row.user_type !== 'user') {
    // NULL / invalid role — not a provisioned application user.
    throw new AppError(ErrorCode.USER_NOT_FOUND, {
      message: 'This account has not been invited to FUSION ONE.',
    });
  }
  if (row.user_type === role) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: `This account already has the ${role === 'owner' ? 'Owner' : 'User'} role.`,
    });
  }

  // Email verification is Supabase Auth's truth — a pending invitation has
  // no confirmed identity and no role yet.
  const authRes = await admin.auth.admin.getUserById(targetId);
  if (authRes.error || !authRes.data.user) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      internalDetails: { step: 'admin.getUserById', cause: authRes.error?.message },
    });
  }
  const authUser = authRes.data.user;

  if (authUser.email_confirmed_at == null) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'This invitation is still pending. The user must accept it before their role can change.',
    });
  }
  if (row.status === 'blocked') {
    // Promoting a blocked account is impossible (owners can never be blocked
    // — DB CHECK from 0002); unblock first.
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'Unblock this user before changing their role.',
    });
  }

  // Owner invariant: a demotion must leave another active owner. The
  // requester (an active owner, ≠ target) normally guarantees this — the
  // explicit count also covers direct API races; the 0005 trigger is the
  // database-level backstop.
  if (row.user_type === 'owner' && role === 'user') {
    const { count, error: countError } = await admin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('user_type', 'owner')
      .eq('status', 'active')
      .neq('id', targetId);
    if (countError) {
      throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
        internalDetails: { step: 'users.count(owners)', pgError: countError.message },
      });
    }
    if (!count) {
      throw new AppError(ErrorCode.USER_ACTION_INVALID, {
        message: 'At least one other active owner must remain.',
      });
    }
  }

  const { error: updateError } = await admin
    .from('users')
    .update({ user_type: role })
    .eq('id', targetId);
  if (updateError) {
    throw new AppError(ErrorCode.USER_ACTION_FAILED, {
      internalDetails: { step: 'users.update(user_type)', pgError: updateError.message },
    });
  }

  getLogger().info({ targetId, role }, 'User role changed');
  return { role, email: authUser.email ?? null };
}

/**
 * Remove a managed user — permanently deletes their FUSION ONE ACCOUNT
 * through the trusted admin API. public.users follows via the FK cascade.
 * Shared business data (invoices, parties, payments, accounts, inventory,
 * financial years, WhatsApp configuration, store) has NO per-user ownership
 * and is never touched by a user's removal.
 */
export async function removeUser(requesterId: string, rawTargetId: string): Promise<void> {
  const admin = requireAdminClient();
  const targetId = requireTargetId(rawTargetId);
  if (targetId === requesterId) {
    throw new AppError(ErrorCode.USER_ACTION_INVALID, {
      message: 'You cannot remove your own account.',
    });
  }
  await requireManagedUser(admin, targetId);

  const removed = await admin.auth.admin.deleteUser(targetId);
  if (removed.error) {
    throw new AppError(ErrorCode.USER_ACTION_FAILED, {
      internalDetails: { step: 'admin.deleteUser', cause: removed.error.message },
    });
  }

  getLogger().info({ targetId }, 'User removed');
}
