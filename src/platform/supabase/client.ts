import { createBrowserClient } from '@supabase/ssr'

/**
 * THE single browser Supabase client for the whole application.
 *
 * - Publishable key only — RLS enforces the data boundary for every request.
 * - Cookie-based session storage via @supabase/ssr (no tokens in
 *   localStorage, no custom storage).
 * - Singleton: createBrowserClient returns the same instance on every import.
 * - detectSessionInUrl: false — this client NEVER adopts URL auth callbacks
 *   (OAuth codes, email-action codes, implicit grants). The application has
 *   no URL-based login flows: sessions enter ONLY through an explicit
 *   signInWithPassword or restoration of the cookie-backed session.
 *   Invitation/recovery email links are consumed exclusively by the
 *   isolated setup client (platform/supabase/setup-client.ts) used by
 *   /set-password — a setup session must never land in this client.
 *
 * There is intentionally NO admin/secret client anywhere in the browser app.
 */
export const supabase = createBrowserClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      detectSessionInUrl: false,
    },
  },
)
