/**
 * API authentication — Supabase user JWTs.
 *
 *   request → extract Bearer token → verify cryptographically against the
 *   project's JWKS (ES256/RS256; issuer + audience checked) → authorize under
 *   the verified identity (sub claim). Identity ALWAYS comes from the
 *   verified JWT — never from request-body fields.
 *
 * Every /api/* endpoint requires a valid user JWT. /health/*, / and /ping
 * stay outside this model (/ping carries its own X-Ping-Token check).
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../errors/registry.js';

/** The verified user identity attached to an authenticated request. */
export interface AuthenticatedUser {
  id: string;
  email: string | null;
  /** The verified access token — used for user-context Supabase requests
   *  (publishable key + this JWT + RLS). Never echoed back to clients. */
  token: string;
  /** The authentication method from the VERIFIED JWT's amr claim
   *  ('password' for a normal application login, 'otp' for an
   *  invitation/recovery email-link session, null when absent — fail
   *  closed downstream). This is a server-verified claim, never a
   *  client-submitted value. */
  amrMethod: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/** Cached JWKS client (refreshes automatically on unknown key ids). */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    const cfg = getConfig();
    jwks = createRemoteJWKSet(new URL(`${cfg.supabaseUrl}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

function requiresAuth(url: string): boolean {
  return url.split('?')[0].startsWith('/api/');
}

/**
 * Verify a Supabase access token and return the authenticated user.
 * @throws AppError(API_AUTH_REQUIRED / API_AUTH_INVALID)
 */
export async function verifySupabaseToken(token: string): Promise<AuthenticatedUser> {
  const cfg = getConfig();
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: `${cfg.supabaseUrl}/auth/v1`,
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
    });

    const id = typeof payload.sub === 'string' ? payload.sub : null;
    if (!id) {
      throw new AppError(ErrorCode.API_AUTH_INVALID, {
        internalDetails: { reason: 'missing sub claim' },
      });
    }
    const email =
      typeof payload.email === 'string' ? payload.email : null;
    // amr[0].method from the VERIFIED claims: 'password' = normal application
    // login, 'otp' = invitation/recovery email-link session, null → fail
    // closed downstream. Stable across token refresh (verified live).
    const amr = Array.isArray(payload.amr) ? payload.amr : null;
    const amrMethod =
      amr && typeof amr[0] === 'object' && amr[0] !== null && typeof (amr[0] as { method?: unknown }).method === 'string'
        ? (amr[0] as { method: string }).method
        : null;
    return { id, email, token, amrMethod };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(ErrorCode.API_AUTH_INVALID, {
      internalDetails: { reason: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Extract and verify the Bearer token from the Authorization header.
 * @throws AppError if auth is required but missing/invalid.
 */
export async function authenticateRequest(req: FastifyRequest): Promise<AuthenticatedUser | null> {
  if (!requiresAuth(req.url)) {
    return null;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new AppError(ErrorCode.API_AUTH_REQUIRED);
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    throw new AppError(ErrorCode.API_AUTH_INVALID);
  }

  const user = await verifySupabaseToken(parts[1]);
  req.user = user;
  return user;
}

/** Require an authenticated user (handlers that must never run anonymously). */
export function requireUser(req: FastifyRequest): AuthenticatedUser {
  if (!req.user) {
    throw new AppError(ErrorCode.API_AUTH_REQUIRED);
  }
  return req.user;
}

/** Fastify preHandler hook for authentication. */
export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await authenticateRequest(req);
  } catch (err) {
    if (err instanceof AppError) {
      reply.code(err.statusCode).send(err.toJSON());
      return;
    }
    const appError = new AppError(ErrorCode.SERVER_INTERNAL_ERROR, { cause: err });
    reply.code(appError.statusCode).send(appError.toJSON());
  }
}
