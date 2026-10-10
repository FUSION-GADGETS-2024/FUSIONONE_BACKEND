/**
 * FUSION ONE backend URL builder.
 *
 * The browser talks to the hosted FUSION ONE backend DIRECTLY (cross-origin,
 * Bearer JWT per request). There is no gateway, no proxy and no
 * port-forwarding hint in front of the SPA.
 *
 * Configuration (build-time env):
 *   VITE_FUSIONONE_BACKEND_BASE — the backend origin, e.g.
 *                                https://wa.one.fusiongadgets.in
 *
 * The origin must be listed in the backend's CLIENT_ORIGIN, since every
 * backend call is cross-origin and carries an Authorization header.
 */

const BASE = (import.meta.env.VITE_FUSIONONE_BACKEND_BASE ?? '').replace(/\/+$/, '')

/** Absolute URL for a backend path (e.g. '/api/status'). */
export function waUrl(path: string): string {
  return `${BASE}${path}`
}