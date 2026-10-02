/**
 * Supabase client boundary — the ONE owner of every Supabase client the
 * backend creates. Three access layers, separated by security boundary:
 *
 *   getUserClient(token) — user-context data access (publishable key + the
 *     requesting user's JWT; RLS enforces the data boundary).
 *   getAdminClient()     — server-privileged Auth administration (secret
 *     key). Null when SUPABASE_SECRET_KEY is unset — callers fail closed.
 *   getMailClient()      — publishable-key client for NATIVE email delivery.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../errors/registry.js';

// ─── User-context clients (LRU-bounded, one per access token) ──────────────

const userClients = new Map<string, SupabaseClient>();
const USER_CLIENT_MAX = 16;

/**
 * Create (or reuse) a client running under the requesting user's identity —
 * publishable key + the user's Bearer JWT. RLS applies to every query made
 * through this client.
 */
export function getUserClient(accessToken: string): SupabaseClient {
  let client = userClients.get(accessToken);
  if (!client) {
    const cfg = getConfig();
    client = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    if (userClients.size >= USER_CLIENT_MAX) {
      // Drop the oldest entry (Map preserves insertion order).
      const oldest = userClients.keys().next().value;
      if (oldest) userClients.delete(oldest);
    }
    userClients.set(accessToken, client);
  }
  return client;
}

// ─── Privileged admin client (server-only) ─────────────────────────────────

let adminClient: SupabaseClient | null = null;

/**
 * The secret-key client for privileged Auth administration — owner-controlled
 * user invitations, listing and role changes ONLY, never for ordinary
 * business reads/writes. Null when SUPABASE_SECRET_KEY is not configured.
 */
export function getAdminClient(): SupabaseClient | null {
  const cfg = getConfig();
  if (!cfg.supabaseSecretKey) return null;
  if (!adminClient) {
    adminClient = createClient(cfg.supabaseUrl, cfg.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}

/** The admin client, failing closed with a clear error when unconfigured. */
export function requireAdminClient(): SupabaseClient {
  const admin = getAdminClient();
  if (!admin) {
    throw new AppError(ErrorCode.SERVER_NOT_READY, {
      message: 'User management is not configured on this server.',
      internalDetails: { reason: 'SUPABASE_SECRET_KEY missing' },
    });
  }
  return admin;
}

// ─── Mail delivery client ──────────────────────────────────────────────────

let mailClient: SupabaseClient | null = null;

/**
 * Publishable-key client used exclusively for NATIVE email delivery:
 * resetPasswordForEmail is Supabase's supported mechanism for actually
 * SENDING a recovery email (the admin generateLink() API only CREATES a
 * link — it never delivers one). Server-side only.
 */
export function getMailClient(): SupabaseClient {
  if (!mailClient) {
    const cfg = getConfig();
    mailClient = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return mailClient;
}
