/**
 * Application authorization — the layer ABOVE JWT authentication.
 *
 * JWT validity (api/auth.ts) proves the IDENTITY. This module decides what
 * that identity may do inside FUSION ONE:
 *
 *   valid JWT → email verified? (Supabase Auth) → account active?
 *   (public.users.status) → user_type owner | user? (NULL → fail closed)
 *
 * status (active | blocked) is INDEPENDENT of the role: a blocked user loses
 * ALL application access here, at the RLS helpers and in the frontend
 * resolver — a still-valid Supabase access token never outlives the block.
 */
import type { FastifyRequest } from 'fastify';
import { getConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import { getUserClient } from '../supabase/clients.js';
import type { AuthenticatedUser } from './auth.js';

export type AppUserType = 'owner' | 'user';

/** An authenticated + verified + provisioned FUSION ONE application user. */
export interface AuthorizedUser {
  id: string;
  email: string | null;
  token: string;
  userType: AppUserType;
}

// ─── Email verification (Supabase Auth is the source of truth) ──────────────

const VERIFICATION_TTL_MS = 5_000;
const verificationCache = new Map<string, { verified: boolean; at: number }>();

/**
 * Whether the caller's email is verified, per Supabase Auth itself. The JWT
 * carries no trustworthy email_verified claim (verified against the live
 * project), so the authoritative record is read via /auth/v1/user with the
 * CALLER's own token. Cached briefly per user to bound the extra hop.
 */
async function isEmailVerified(user: AuthenticatedUser): Promise<boolean> {
  const cached = verificationCache.get(user.id);
  if (cached && Date.now() - cached.at < VERIFICATION_TTL_MS) {
    return cached.verified;
  }

  const cfg = getConfig();
  let verified = false;
  try {
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${user.token}`,
        apikey: cfg.supabasePublishableKey,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = (await res.json()) as { email_confirmed_at?: string | null };
      verified = body.email_confirmed_at != null;
    }
    // Non-OK responses fail closed (treated as unverified below).
  } catch (err) {
    // Network failure is an internal error, not an authorization decision.
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      internalDetails: { step: 'auth.user_lookup', cause: err instanceof Error ? err.message : String(err) },
    });
  }

  verificationCache.set(user.id, { verified, at: Date.now() });
  return verified;
}

// ─── Application account (public.users via the caller's own identity) ──────

/** The caller's application account facts (role + access status). */
interface AppUserRow {
  userType: AppUserType | null;
  status: 'active' | 'blocked';
}

/**
 * The caller's application role and account status from public.users, read
 * through the caller-scoped client — RLS already confines the read to the
 * caller's own row. NULL / missing / non-role user_type → fail closed;
 * anything other than an exactly-'active' status is treated as blocked.
 */
async function loadAppUser(user: AuthenticatedUser): Promise<AppUserRow> {
  const db = getUserClient(user.token);
  const { data, error } = await db
    .from('users')
    .select('user_type, status')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      internalDetails: { step: 'users.select', pgError: error.message },
    });
  }

  const row = data as { user_type?: unknown; status?: unknown } | null;
  const userType = row?.user_type;
  return {
    userType: userType === 'owner' || userType === 'user' ? userType : null,
    status: row?.status === 'active' ? 'active' : 'blocked',
  };
}

/**
 * Require a fully authorized FUSION ONE user: NORMAL application
 * authentication context + verified email + ACTIVE account + provisioned
 * application user (owner or user). Throws distinct 403s so clients can
 * tell context, verification, blocked and access problems apart.
 *
 * The authentication-context boundary is mandatory: an invitation/recovery
 * email-link session (JWT amr method 'otp') is cryptographically valid and
 * may belong to a verified, provisioned, active user — but it is NOT a
 * normal application login and must never reach business APIs. Only
 * 'password' counts as a normal application authentication context (the
 * same rule the RLS helpers enforce; the amr claim is server-verified and
 * stable across token refresh).
 */
export async function requireAuthorizedUser(req: FastifyRequest): Promise<AuthorizedUser> {
  const user = req.user;
  if (!user) {
    // Defensive: the authHook guarantees req.user for /api/* routes.
    throw new AppError(ErrorCode.API_AUTH_REQUIRED);
  }

  if (user.amrMethod !== 'password') {
    throw new AppError(ErrorCode.AUTH_CONTEXT_INVALID); // fail closed for any non-password context
  }

  if (!(await isEmailVerified(user))) {
    throw new AppError(ErrorCode.EMAIL_VERIFICATION_REQUIRED);
  }

  const appUser = await loadAppUser(user);
  if (appUser.status === 'blocked') {
    // Enforced live per request (also at the RLS helpers and in the frontend
    // resolver) — revoking sessions alone is never sufficient.
    throw new AppError(ErrorCode.ACCOUNT_BLOCKED);
  }
  if (!appUser.userType) {
    throw new AppError(ErrorCode.APP_ACCESS_REQUIRED);
  }

  return { id: user.id, email: user.email, token: user.token, userType: appUser.userType };
}

/** Require the (single) application owner. */
export async function requireOwner(req: FastifyRequest): Promise<AuthorizedUser> {
  const authorized = await requireAuthorizedUser(req);
  if (authorized.userType !== 'owner') {
    throw new AppError(ErrorCode.OWNER_REQUIRED);
  }
  return authorized;
}
