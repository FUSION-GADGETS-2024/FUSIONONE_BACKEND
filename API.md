# FUSION ONE Backend — API Documentation

This document describes the complete public API for the FUSION ONE Backend.
It is written so that an external developer can build a client without access to
the backend source code.

---

## 1. Overview

The FUSION ONE Backend is the dedicated application backend for FUSION ONE —
a Node.js + TypeScript server that owns the complete WhatsApp lifecycle using
Baileys, the document/message pipeline, and user management. It provides:

- **Automatic WhatsApp onboarding** — the backend generates QR codes and manages
  pairing. The client never starts or initializes WhatsApp.
- **Real-time state updates** — via Server-Sent Events (SSE), the backend pushes
  state changes, QR availability, send results, and security events to connected
  clients.
- **Document message sending** — every message kind (invoice, payment
  receipt, payment statement, reminder) sends ONE WhatsApp **document**
  message: the document PDF (`application/pdf`, filename
  `<document-number>.pdf`) with the resolved message template as its caption
  and a JPEG preview thumbnail — all document kinds through the SAME
  document preparation pipeline. The backend owns the entire pipeline — the
  client supplies only the business-object reference.
- **Session management** — logout destroys the WhatsApp session and switches
  Baileys OFF; the state stays `IDLE` (no session) until an explicit
  `POST /api/whatsapp/login`.

### Architecture

- **One Node.js process** with a single Baileys WebSocket connection.
- **Backend-owned invoice pipeline** — given `{invoiceId, invoiceType}`, the
  backend loads the invoice from Supabase, renders the PDF (PDFKit), resolves
  the recipient and WhatsApp message template, and sends ONE document
  message. The client supplies only the invoice reference.
- **Backend-owned lifecycle** — the frontend is primarily a reader of state.
- **Closed registries** — states, error codes, and event types are fixed sets.
- **Fail-closed security** — authentication/security failures destroy the session.

### Environment Variables (server-only)

| Variable | Purpose |
|----------|---------|
| `PORT` / `HOST` | HTTP server bind (default 3000 / 0.0.0.0) |
| `SUPABASE_URL` | Supabase project URL (authoritative invoice data) |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key — combined with the requesting user's JWT for every data access (RLS-enforced). |
| `SUPABASE_SECRET_KEY` | Server-only Supabase secret key — the SYSTEM-CONTEXT credential, used for exactly two system-level responsibilities: owner-controlled Auth administration (user invitations / user listing) and the durable message system (scheduler job state + background business-data loads for job execution). Never used for user-requested business reads/writes (those run under the CALLER's JWT + RLS), never exposed to any frontend. Empty/unset = user management AND the message scheduler fail closed. |
| `APP_BASE_URL` | Public origin of the frontend app — invitation / password-reset email links redirect to `<APP_BASE_URL>/set-password`. |
| `CLIENT_ORIGIN` | Allowed CORS browser origins (comma-separated; production `https://one.fusiongadgets.in`; `*` for dev sandboxes only) |
| `WHATSAPP_AUTH_DIR` | Baileys auth state storage (default `./data/whatsapp/auth`) |
| `EXPECTED_WHATSAPP_JID` | Optional WhatsApp identity pin |
| `WHATSAPP_CLIENT_DISCONNECT_GRACE_MS` | Runtime retention: after the LAST authenticated frontend client disconnects (and no other runtime demand exists), the Baileys runtime keeps running for this long before the intentional stop (session preserved). Default 300000 (5 minutes). |
| `WHATSAPP_WAKE_TIMEOUT_MS` | Bounded wait for a runtime wake to reach `CONNECTED` |
| `REDIS_URL` / `WHATSAPP_BACKUP_ENCRYPTION_KEY` | Encrypted Redis session backup (recovery replica) — required together when set |
| `SEND_TIMEOUT_MS` / `SEND_MAX_RETRIES` / `SEND_RETRY_BASE_MS` | Send pipeline tuning (TRANSPORT-level retries within one message execution — separate from durable job retries) |
| `MESSAGE_POLL_INTERVAL_MS` | Durable message scheduler: due-job scan interval (default 15000, min 5000). |
| `MESSAGE_JOB_LEASE_MS` | Durable message scheduler: claim lease (default 300000, min 30000). A claimed-but-unfinished job whose lease expired is recovered (made retryable) by the next scan. Must exceed worst-case job execution (send timeout × retries + PDF + thumbnail generation). |
| `MAX_REQUEST_BODY_BYTES` | Request body limit (default 10 MB) |
| `LOG_LEVEL` | pino log level |
| `PING_TOKEN` | Secret for the `GET /ping` wakeup probe (checked via the `X-Ping-Token` request header). Environment-only — never exposed to any frontend. Unset/empty = `/ping` always returns 401 (fail closed). |

### Authentication Model

**Every `/api/*` endpoint requires a valid Supabase user JWT** (Bearer
`Authorization` header). The backend verifies the token cryptographically
against the Supabase project's JWKS (ES256/RS256; issuer + audience checked)
and derives the user identity from the verified `sub` claim. Identity NEVER
comes from request-body fields (`userId`/`ownerId`/`storeId` are rejected by
the strict request schema).

- Invoice data is loaded **under the requesting user's identity**
  (`publishable key + user JWT + RLS`) — a user can only send invoices their
  own store owns.
- **Health endpoints** (`live`, `ready`) and the service banner (`GET /`) are
  public.

### Communication Methods

- **HTTP** — for commands and status reads.
- **SSE** — for real-time event streaming (one-way, backend → client).
- **CORS** — the backend allows cross-origin requests from a configured client
  origin (see [CORS](#cors) below).

### CORS

The backend allows a list of browser origins via the `CLIENT_ORIGIN`
environment variable (comma-separated). Production uses
`https://one.fusiongadgets.in`; the local default is
`http://localhost:5173`.

- Only requests with an `Origin` header in the list receive CORS response
  headers.
- Same-origin requests (no `Origin` header) are always allowed.
- The wildcard `*` is supported for development sandboxes only; production
  deployments should list exact SPA origins.
- Credentials mode is disabled — the auth model uses `Authorization` headers,
  not cookies.

Allowed methods: `GET`, `POST`, `DELETE`, `OPTIONS`.

Allowed request headers: `Authorization`, `Content-Type`, `Accept`.

CORS applies to all endpoints, including the SSE stream (`GET /api/events`).
The backend merges CORS headers into the SSE response so that cross-origin
fetch-based SSE streaming works from the browser. (Native `EventSource` cannot
be used for the stream — it cannot send the required `Authorization` header.)

---

## 2. Requirements

### Backend URL

The backend runs on a configurable host and port (default: `http://localhost:3000`).

### Required Headers

| Header | Value | Required For |
|--------|-------|-------------|
| `Authorization` | `Bearer <Supabase access token>` | Every `/api/*` endpoint |
| `Content-Type` | `application/json` | POST requests with a body |
| `Origin` | `<CLIENT_ORIGIN>` | Cross-origin browser requests (set automatically by browsers) |

### Content Types

- Request bodies must be `application/json`.
- `sendInvoice` accepts only `invoiceId`, `invoiceType`, and an optional
  `requestId` — no image or file payloads (see
  [sendInvoice API](#7-sendinvoice-api)).
- SSE responses are `text/event-stream`.

### SSE Usage

- Connect to `GET /api/events` using a **fetch-based SSE client** that sets the
  `Authorization: Bearer <Supabase access token>` header. The native browser
  `EventSource` API cannot send request headers, so it cannot authenticate and
  must not be used.
- Events are sent as `data: <json>\n\n` lines.
- The connection is kept open; the backend sends keepalive pings every 30 seconds.
- If the connection drops, the client should reconnect with backoff and refresh
  its snapshot via `GET /api/status`.
- **SSE is observer-only** — client disconnects do not alter backend state.
- CORS headers are included in the SSE response, so cross-origin fetch-based
  streaming works without additional configuration.

---

## 3. API Authentication

### How Authentication Works

The backend authenticates users with their **Supabase access token** (JWT):

```
Authorization: Bearer <Supabase access token>
```

The token is verified cryptographically against the Supabase project's JWKS
(ES256/RS256; issuer `https://<ref>.supabase.co/auth/v1`, audience
`authenticated`).
The user id comes from the verified `sub` claim — request-body identity fields
are rejected. Because native `EventSource` cannot send headers, SSE clients
should use `fetch`-based streaming with the `Authorization` header.

### Application Authorization (above authentication)

A valid JWT proves the IDENTITY; the backend additionally decides what that
identity may do inside FUSION ONE before serving any `/api/*` route:

1. **Email verified?** — read live from Supabase Auth (`GET /auth/v1/user`
   with the caller's own token; cached briefly per user). Unverified → `403
   EMAIL_VERIFICATION_REQUIRED`.
2. **Provisioned application user?** — the caller's `public.users` row is
   read through the caller-scoped client (RLS self-read). Missing row or
   `user_type` NULL/invalid → `403 APP_ACCESS_REQUIRED` (fail closed).
3. **Owner-only routes** additionally require `user_type = 'owner'` → else
   `403 OWNER_REQUIRED`.

RLS remains the final database boundary; these checks make the backend fail
closed early. The WhatsApp runtime itself stays globally shared — it is never
user-specific.

### Endpoint Authorization Policy

| Endpoint | Auth | Authorization |
|----------|------|---------------|
| `GET /health/live` | No | — |
| `GET /health/ready` | No | — |
| `GET /` (service banner) | No | — |
| `GET /ping` (wakeup probe) | Dedicated `X-Ping-Token` header (NOT the JWT model) | — |
| `GET /api/status` | **Yes** (valid user JWT) | Authorized app user (owner or user) |
| `GET /api/events` (SSE) | **Yes** (valid user JWT) | Authorized app user (owner or user) |
| `POST /api/whatsapp/login` | **Yes** (valid user JWT) | **Owner only** (shared-connection configuration) |
| `POST /api/whatsapp/cancelPairing` | **Yes** (valid user JWT) | Authorized app user |
| `POST /api/messages/sendInvoice` | **Yes** (valid user JWT) | Authorized app user (shared business operation) |
| `POST /api/messages/autoSend` | **Yes** (valid user JWT) | Authorized app user (arms the durable server-side auto-send) |
| `POST /api/messages/sendReceipt` | **Yes** (valid user JWT) | Authorized app user (manual payment receipt message) |
| `POST /api/messages/sendStatement` | **Yes** (valid user JWT) | Authorized app user (manual payment statement message) |
| `POST /api/messages/sendReminder` | **Yes** (valid user JWT) | Authorized app user (manual reminder trigger) |
| `PUT /api/messages/reminder-settings/:saleId` | **Yes** (valid user JWT) | Authorized app user (per-invoice reminder configuration) |
| `POST /api/whatsapp/logout` | **Yes** (valid user JWT) | **Owner only** (shared-session destruction) |
| `GET /api/users` | **Yes** (valid user JWT) | **Owner only** |
| `POST /api/users/invite` | **Yes** (valid user JWT) | **Owner only** |
| `POST /api/users/:id/resend-invite` | **Yes** (valid user JWT) | **Owner only** |
| `POST /api/users/:id/block` | **Yes** (valid user JWT) | **Owner only** |
| `POST /api/users/:id/unblock` | **Yes** (valid user JWT) | **Owner only** |
| `POST /api/users/:id/reset-password` | **Yes** (valid user JWT) | **Owner only** |
| `DELETE /api/users/:id` | **Yes** (valid user JWT) | **Owner only** |

### Unauthorized Responses

**Missing token:**
```json
HTTP 401
{
  "error": {
    "code": "API_AUTH_REQUIRED",
    "message": "Authentication is required to access this endpoint."
  }
}
```

**Invalid token:**
```json
HTTP 401
{
  "error": {
    "code": "API_AUTH_INVALID",
    "message": "The provided authentication credentials are invalid."
  }
}
```

**Unverified email (valid JWT):**
```json
HTTP 403
{
  "error": {
    "code": "EMAIL_VERIFICATION_REQUIRED",
    "message": "Verify your email address before accessing FUSION ONE."
  }
}
```

**No FUSION ONE access (valid JWT, verified, no application user):**
```json
HTTP 403
{
  "error": {
    "code": "APP_ACCESS_REQUIRED",
    "message": "You do not have access to FUSION ONE."
  }
}
```

**Owner-only route called by a normal user:**
```json
HTTP 403
{
  "error": {
    "code": "OWNER_REQUIRED",
    "message": "Owner access is required for this operation."
  }
}
```

> **Security:** The Bearer token is the logged-in user's Supabase access token.
> Treat it like any session credential — never log it or embed long-lived
> tokens in shared/static code.

---

## 4. API Endpoints

### GET /

**Purpose:** Service banner (JSON) — basic service info for health checks.
This is a headless API — no web UI or static assets are served; the FUSIONONE
SPA talks to the backend cross-origin with the user's Supabase JWT.

**Headers:** None required.

**Response (200):**
```json
{
  "service": "fusion-one-backend",
  "version": "1.0.0",
  "status": "running"
}
```

---

### GET /health/live

**Purpose:** Liveness probe — indicates the Node.js process is alive.
This does NOT fail when WhatsApp is temporarily disconnected.

**Headers:** None required.

**Response (200):**
```json
{
  "status": "alive",
  "timestamp": "2026-08-14T12:00:00.000Z"
}
```

**Possible Errors:** None — this endpoint always returns 200 if the process is alive.

---

### GET /health/ready

**Purpose:** Readiness probe — indicates whether the backend is ready to handle
requests.

**Headers:** None required.

**Response (200) — Ready:**
```json
{
  "status": "ready",
  "state": "CONNECTED",
  "whatsappConnected": true
}
```

**Response (503) — Not Ready:**
```json
{
  "status": "not_ready",
  "reason": "starting",
  "state": "STARTING"
}
```

The `reason` field is either `"starting"` (in STARTING/STOPPING state) or
`"shutting_down"` (during graceful shutdown).

---

### GET /ping

**Purpose:** Token-protected wakeup probe for an external cron or monitoring
service (e.g. keeping a free-tier Render deployment from spinning down, or a
scheduled availability check). Deliberately outside the Supabase JWT model and
as cheap as possible: no Supabase query, no database access, no Baileys
initialization, no WhatsApp state change.

**Headers:** `X-Ping-Token: <PING_TOKEN>` (required) — the dedicated
environment-only secret (`PING_TOKEN`). Never send the token in a URL query
parameter; never expose it to a browser/frontend.

**Response:**

| Case | Status |
|------|--------|
| Correct token | `204 No Content` (empty body) |
| Missing token | `401` |
| Incorrect token (or `PING_TOKEN` unset) | `401` |

**Example:**
```bash
curl -o /dev/null -w '%{http_code}' \
  -H "X-Ping-Token: <PING_TOKEN>" \
  https://wa.one.fusiongadgets.in/ping
# → 204
```

---

### GET /api/status

**Purpose:** Read the current backend and WhatsApp state.

**Headers:** `Authorization: Bearer <Supabase access token>` (required).

**Response (200):**
```json
{
  "server": {
    "state": "running",
    "timestamp": "2026-08-14T12:00:00.000Z"
  },
  "whatsapp": {
    "state": "PAIRING",
    "session": "NONE",
    "connected": false,
    "jid": null,
    "qrAvailable": true,
    "qr": "data:image/png;base64,iVBORw0KGgo...",
    "qrExpiresInSeconds": 47,
    "qrExpiresAt": "2026-08-14T12:01:00.000Z"
  }
}
```

**Field Details:**

| Field | Type | Description |
|-------|------|-------------|
| `server.state` | string | `"running"` or `"STOPPING"` |
| `whatsapp.state` | string | One of the 9 WhatsApp RUNTIME states (see [State Model](#5-state-model)) |
| `whatsapp.session` | string | The SESSION dimension — `NONE`, `PRESENT`, or `RESTORING` (separate axis from the runtime state; see below) |
| `whatsapp.connected` | boolean | `true` only when state is `CONNECTED` |
| `whatsapp.jid` | string\|null | Connected WhatsApp JID, or `null` if not connected |
| `whatsapp.qrAvailable` | boolean | Whether a QR code is currently available |
| `whatsapp.qr` | string\|null | QR code data URL (for display), or `null` |
| `whatsapp.qrExpiresInSeconds` | number\|null | Seconds remaining on the current pairing QR (same generation/deadline the SSE countdown broadcasts), or `null` when no QR is held |
| `whatsapp.qrExpiresAt` | string\|null | ISO timestamp when the current pairing QR expires, or `null` when no QR is held |

**Runtime + session (two separate axes):**

| Combination | Meaning |
|---|---|
| `IDLE` + `session: NONE` | Runtime asleep, nothing paired — the Connect action applies |
| `IDLE` + `session: PRESENT` | Runtime asleep, session configured — wake-able WITHOUT QR pairing (the backend wakes it automatically when the first authenticated client becomes present; `sendInvoice` wakes it internally) |
| `CONNECTING` + `session: RESTORING` | A Redis-backed session is being restored and validated |

**Possible Errors:**
- `401 API_AUTH_REQUIRED` — missing Authorization header
- `401 API_AUTH_INVALID` — invalid token

---

### GET /api/events

**Purpose:** Server-Sent Events stream for real-time backend events.

**Headers:** `Authorization: Bearer <Supabase access token>` (required —
native `EventSource` cannot send headers; use a fetch-based SSE client).

**Response:** `text/event-stream`

Events are sent as:
```
data: {"type":"WHATSAPP_STATE_CHANGED","timestamp":"...","data":{...}}

```

See [Event Model](#6-event-model) for event types and payloads.

**Client Presence (runtime lifecycle):** every authenticated SSE stream
represents a PRESENT frontend client. The backend counts these connections
and uses them to drive the WhatsApp runtime lifecycle:

- The FIRST client appearing is a **wake signal** — the backend wakes an
  existing session automatically (never pairing: client presence is not
  pairing intent).
- The LAST client disconnecting starts a **5-minute shutdown grace** (when
  no other runtime demand exists); a client returning within it cancels the
  stop. After the grace the runtime sleeps intentionally (`IDLE`) with the
  session preserved.

**Client Behavior:**
- Use a fetch-based SSE client that sets the `Authorization` header (native
  `EventSource` cannot authenticate).
- The backend sends keepalive pings every 30 seconds.
- Reconnect with backoff if the connection drops; refresh the snapshot via
  `GET /api/status` (which includes the current QR when one is available).
- A brief client disconnect only affects the runtime after the 5-minute
  grace expires — reconnecting streams never stop WhatsApp prematurely.
- CORS headers are included in the SSE response — cross-origin fetch-based
  streaming works automatically when the client origin matches the backend's
  configured `CLIENT_ORIGIN`.

---

### POST /api/whatsapp/login

**Purpose:** Start an EXPLICIT WhatsApp login attempt (the Connect action).
This is the ONLY way to start QR pairing — the backend never pairs on its
own (client presence and `sendInvoice` wake the runtime internally and never
produce a QR).

**Headers:**
```
Authorization: Bearer <Supabase access token>
```

**Request Body:** None — the endpoint reads no request body. Send an empty
body (no `Content-Type` needed). If your HTTP client always attaches a JSON
body, send it with `Content-Type: application/json`; the body is ignored.

**Flow (candidate resolution — no unnecessary QR):**
- Local session material usable: `IDLE` → `CONNECTING` → `CONNECTED` (wake — no QR)
- Local missing + Redis backup usable: restore → `CONNECTING` → `CONNECTED` (no QR)
- Local candidate rejected by WhatsApp + Redis backup usable: Redis candidate tried → `CONNECTED` (no QR)
- No reusable session anywhere: deterministic cleanup → `PAIRING` → QR emitted via SSE (`WHATSAPP_QR_AVAILABLE`) → user scans → `CONNECTED`

Idempotent: calling login while already pairing/connecting/connected does
NOT create a second socket. Baileys refreshes the QR every 60 seconds while
pairing (`qrTimeout: 60_000`) — there is no artificial login deadline; the
pairing flow stays active until authentication succeeds, the server stops,
the Baileys connection genuinely fails, or the runtime retention policy
ends an abandoned pairing (last client gone + grace expired).

**Success Response (200):**
```json
{
  "success": true,
  "state": "PAIRING",
  "message": "WhatsApp login attempt started"
}
```

`state` is the state at response time: `PAIRING` (no stored session) or
`CONNECTING` (stored session being restored).

**Possible Errors:**
- `401 API_AUTH_REQUIRED` — missing auth token
- `401 API_AUTH_INVALID` — invalid auth token
- `503 SERVER_NOT_READY` — server is shutting down, or a login cannot be
  started from the current state

---

### POST /api/messages/sendInvoice

**Purpose:** Send an invoice **by reference** — the backend owns the entire
invoice pipeline. It loads the authoritative invoice data from Supabase,
renders the PDF with PDFKit, resolves the recipient and the WhatsApp message
template, and sends **one** WhatsApp document message (PDF + caption).

**Headers:**
```
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "invoiceId": "d0bbf4b3-14f8-453a-bb59-55d4b7571610",
  "invoiceType": "sale",
  "requestId": "optional-tracing-id"
}
```

**Field Details:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `invoiceId` | UUID string | Yes | The invoice to send (row id in `sales` / `purchases` / `proforma_invoices`) |
| `invoiceType` | enum | Yes | `sale` \| `purchase` \| `proforma` |
| `requestId` | string | No | Optional tracing identifier (auto-generated if absent, max 128 chars) |

Unknown fields are rejected (strict schema). The LEGACY image-based contract
(`{recipient, image, caption}`) is **removed** and rejected with a clear
error — it must not be used.

**What the backend does (in order):**
1. Loads the invoice from Supabase (header, party, items, trade-ins, store)
2. Resolves the recipient from the invoice party's phone number
   (Indian mobile numbers only — see
   [Recipient Resolution](#7-sendinvoice-api) in §7)
3. Resolves the WhatsApp message from the `whatsapp_settings` template for
   the invoice type (placeholders substituted with authoritative data; no
   hardcoded fallback — a missing template fails with
   `WHATSAPP_TEMPLATE_MISSING`)
4. Prepares the document through the unified pipeline: the PDF (PDFKit,
   Prestige design) renders **concurrently** with the chat preview — both
   from the same canonical document data (`Promise.all`)
5. Renders the WhatsApp chat-bubble preview: a crisp JPEG of the
   **upper section of the same Prestige design** (store header, party/meta
   block, the document's leading content — only complete rows, never a
   clipped row), drawn by a **persistent isolated Node canvas worker**
   (`@napi-rs/canvas`, spawned once at backend startup; never inside the
   Bun process). EVERY document kind (invoice, receipt, statement) renders
   its preview through this same worker. It is embedded as the document's
   `jpegThumbnail` so the chat bubble shows the preview, exactly like a
   manually attached PDF. Purely cosmetic: any generation failure (worker
   crash, timeout, render error) logs a warning and the document is still
   sent as a PDF without a preview — a preview failure can never fail a send
6. Sends **one** WhatsApp document message: the PDF attachment
   (`application/pdf`, filename `<document-number>.pdf`) with the resolved
   message as its caption and the upper-section preview as its thumbnail —
   never a separate text message, never an image

**Success Response (200):**
```json
{
  "success": true,
  "requestId": "req-1700000000-abcdef",
  "messageId": "3EB0C1A2B3C4D5E6"
}
```

**Possible Errors:**
- `400 API_REQUEST_INVALID` — malformed body, missing/non-UUID invoiceId, unknown fields, or the removed legacy image payload
- `400 INVALID_INVOICE_TYPE` — invoiceType is not sale/purchase/proforma
- `400 PARTY_PHONE_MISSING` — the invoice party has no phone number on file
- `400 WHATSAPP_RECIPIENT_INVALID` — the party phone number is not a valid Indian mobile number
- `401 API_AUTH_REQUIRED` — missing auth token
- `401 API_AUTH_INVALID` — invalid auth token
- `404 INVOICE_NOT_FOUND` — no invoice exists with that id
- `500 SERVER_INTERNAL_ERROR` — a Supabase query failed
- `500 STORE_CONFIGURATION_AMBIGUOUS` — multiple store rows exist (single-store deployment requires exactly one)
- `500 INVOICE_PDF_GENERATION_FAILED` — PDF rendering failed
- `503 WHATSAPP_NOT_CONNECTED` — WhatsApp is not connected
- `503 WHATSAPP_TEMPLATE_MISSING` — no message template configured for this invoice type
- `503 STORE_NOT_CONFIGURED` — no store row exists
- `503 SERVER_NOT_READY` — server is shutting down or sends are blocked
- `502 WHATSAPP_SEND_FAILED` — send operation failed (after retries)
- `504 WHATSAPP_SEND_TIMEOUT` — send operation timed out

See [sendInvoice API](#7-sendinvoice-api) for more details.

---

### POST /api/messages/autoSend

**Purpose:** Arm the DURABLE server-side auto-send for a freshly created
invoice. The backend re-validates the matching `whatsapp_settings.auto_send_*`
flag under the caller's identity (the browser's read is UX only), creates a
due-now `invoice_send` message job, and returns immediately — the scheduler
executes it (browser-independent, restart-safe, retried on failure). This
replaced the old browser sessionStorage intent entirely.

**Headers:**
```
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

**Request body** (same reference-only contract as sendInvoice):
```json
{ "invoiceId": "<uuid>", "invoiceType": "sale" }
```

**Responses:**
- `202` `{ "success": true, "created": true, "jobId": "<uuid>" }` — job created; execution is in progress (the outcome arrives as a `MESSAGE_JOB_RESULT` SSE event and is persisted in `message_jobs`).
- `200` `{ "success": true, "created": false, "reason": "disabled" }` — the auto-send flag is off server-side; nothing was created.
- `200` `{ "success": true, "created": false, "reason": "already_pending" }` — a pending/processing auto-send already exists (idempotent).
- `401/403` — authentication/authorization failures (standard model).
- `400 API_REQUEST_INVALID` / `INVALID_INVOICE_TYPE` — malformed request.
- `503 SERVER_NOT_READY` — the durable message system is not configured (missing server credentials).

---

### POST /api/messages/sendReceipt

**Purpose:** Manually send a payment receipt on WhatsApp — the Payments
dialog / Payments page action. Receipts are ALSO sent automatically for
SUBSEQUENT payments (a later payment against an existing invoice/bill) when
the store's `auto_send_receipt_in` / `auto_send_receipt_out` switch is ON:
those jobs are created TRANSACTIONALLY inside the `receive_payment` /
`pay_purchase` RPCs (migration 0007) and executed by the scheduler — this
endpoint is the manual path. The frontend identifies the payment; the
backend resolves the authoritative payment record, the linked invoice's
CURRENT totals, the party, the template, renders the receipt PDF (the
shared Prestige document system), and delivers it through the same
SendController/WhatsAppManager transport. A receipt message failure NEVER
affects the recorded payment.

**Headers:**
```
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

**Request body:**
```json
{ "paymentId": "<uuid>", "direction": "in" }
```
`direction` is `in` (payments_in) or `out` (payments_out). No financial
payload is accepted — amounts, dates and references always come from the
database.

**Responses:**
- `200` `{ "success": true, "status": "succeeded", "jobId": "<uuid>" }` — the receipt was delivered; the durable job record persists the outcome.
- `200` `{ "success": false, "status": "pending", "jobId": "...", "error": "..." }` — the message failed retryably (e.g. WhatsApp not connected); the job retries automatically with backoff.
- `200` `{ "success": true, "status": "processing", "jobId": "..." }` — the scheduler claimed the job concurrently; it is already executing.
- `200` `{ "success": false, "status": "failed" | "cancelled", "jobId": "...", "error": "..." }` — terminal outcome (invalid recipient, missing template, …).
- `409 MESSAGE_JOB_CONFLICT` — a receipt for this payment is already being delivered (double-click guard; this may be the payment's own AUTOMATIC receipt).
- `404 PAYMENT_NOT_FOUND` — no such payment (for the given direction).
- `503 SERVER_NOT_READY` — the durable message system is not configured.

---

### POST /api/messages/sendStatement

**Purpose:** Manually send the PAYMENT STATEMENT for an invoice/bill on
WhatsApp — the Payments dialog's "Send Payment Statement" action. A
statement represents ALL payments recorded against the invoice/bill
(INCLUDING the initial payment made during invoice/bill creation), composed
from CURRENT authoritative data at send time: the payment list comes from
the payment records and the aggregates (total paid / balance due) come from
the invoice row (`sales.paid/due`, `purchases.paid/due`) — never a stale
snapshot, never recomputed in the browser. Statements are MANUAL ONLY: no
payment operation ever creates one. The document is rendered by the same
shared Prestige renderer (STM-… number) and delivered through the same
transport. A message failure NEVER affects the recorded payments.

**Headers:**
```
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

**Request body:**
```json
{ "invoiceId": "<uuid>", "invoiceType": "sale" }
```
`invoiceType` is `sale` (statement In) or `purchase` (statement Out);
proforma is rejected (no payments). No financial payload is accepted.

**Responses:** the same outcome shapes as `sendReceipt`, with:
- `409 MESSAGE_JOB_CONFLICT` — a statement for this invoice is already being delivered. A LATER request (after the first job reached a terminal state) legitimately creates a fresh job — two intentionally separate user requests are not the same statement.
- `404 INVOICE_NOT_FOUND` — no such sale/purchase.

---

### POST /api/messages/sendReminder

**Purpose:** Manually trigger a payment reminder for a sale invoice NOW.
Converges with the scheduled reminder path on the SAME message
implementation: the backend pulls the scheduled reminder job forward to
run_at = now (or creates a one-off job when no chain is configured), claims
it, executes it, and returns the outcome. The reminder message always
renders the invoice's CURRENT balance due.

**Headers:**
```
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

**Request body:**
```json
{ "saleId": "<uuid>" }
```

**Responses:** the same outcome shapes as `sendReceipt`, plus:
- `409 REMINDER_NOT_ELIGIBLE` — the invoice is fully paid or cancelled.

---

### PUT /api/messages/reminder-settings/:saleId

**Purpose:** Create or update the per-invoice reminder configuration. The
backend validates the values, upserts the `reminder_settings` row, and
atomically reconciles the durable next job: enabling (re)starts the chain
only when the invoice is currently eligible (active + balance due + under
the limit); disabling cancels pending reminder jobs. The dialog never
schedules anything with client-side timers.

**Headers:**
```
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

**Request body:**
```json
{ "enabled": true, "frequencyDays": 7, "maxReminders": 3 }
```
(`frequencyDays` 1–365; `maxReminders` 1–50.)

**Responses:**
- `200` `{ "success": true, "config": { ... }, "jobCreated": bool, "jobsCancelled": int }` — the persisted configuration and the job reconciliation outcome.
- `400 API_REQUEST_INVALID` — values out of range.
- `404 INVOICE_NOT_FOUND` — no such sale.
- `503 SERVER_NOT_READY` — the durable message system is not configured.

---

### POST /api/whatsapp/logout

**Purpose:** Logout the connected WhatsApp session and destroy authentication state.

**Headers:**
```
Authorization: Bearer <Supabase access token>
```

**Request Body:** None required.

**Success Response (200):**
```json
{
  "success": true,
  "state": "IDLE",
  "message": "WhatsApp session destroyed"
}
```

After logout, the backend transitions `LOGGING_OUT` → `IDLE` and **stays
there** — Baileys is OFF until an explicit `POST /api/whatsapp/login`. The
session directory is wiped and verified. No QR code is generated until the
next login attempt.

**Possible Errors:**
- `401 API_AUTH_REQUIRED` — missing auth token
- `401 API_AUTH_INVALID` — invalid auth token
- `503 WHATSAPP_NOT_CONNECTED` — WhatsApp is not connected (nothing to logout)
- `503 SERVER_NOT_READY` — server is shutting down

See [Logout API](#8-logout-api) for more details.

---

### GET /api/users

**Owner only.** Lists the MANAGED users (rows with `user_type = 'user'`) for the
Profile page. The owner is never included (already shown in the Account
section) and NULL-role accounts are not managed users (fail-closed, not
listed). Rows join Supabase Auth (emails, verification, last sign-in) with
their `public.users` application rows, and carry a derived presentation
state — no duplicate database columns.

**Request:**
```
GET /api/users
Authorization: Bearer <Supabase access token>
```

**Success Response (200):**
```json
{
  "users": [
    {
      "id": "7a3ed254-8c15-4e83-aa3d-0add1c507bd9",
      "email": "user@fusionone.test",
      "displayName": "Wamiq Khan",
      "userType": "user",
      "status": "active",
      "emailConfirmed": true,
      "createdAt": "2026-10-01T19:56:16.164Z",
      "lastSignInAt": "2026-10-01T21:12:15.577Z",
      "state": "active"
    }
  ]
}
```

`status` is the account access state (`active` | `blocked`), independent of
the role. `displayName` is the personal profile name from
`public.users.display_name` (`null` when the user has not completed their
profile — never generated from the email, never an authorization signal).
`state` is the derived presentation state: `active` (verified +
active), `blocked`, or `invitation_pending` (invited, email not yet
confirmed).

**Possible Errors:**
- `401 API_AUTH_REQUIRED` / `401 API_AUTH_INVALID` — missing/invalid token
- `403 EMAIL_VERIFICATION_REQUIRED` — caller's email not verified
- `403 ACCOUNT_BLOCKED` — caller's account is blocked
- `403 APP_ACCESS_REQUIRED` — caller has no FUSION ONE access
- `403 OWNER_REQUIRED` — caller is not the owner
- `503 SERVER_NOT_READY` — user management not configured (missing `SUPABASE_SECRET_KEY`)

---

### POST /api/users/invite

**Owner only.** Invites a new FUSION ONE user by email. The invitation,
email verification and password setup are handled NATIVELY by Supabase Auth
(`inviteUserByEmail`): the owner never supplies a password or a role, the
invitee's email is never auto-confirmed, and the invitee sets their own
password on `/set-password` (the email link's redirect target). The
application row is provisioned automatically with `user_type = NULL`
(database trigger) and resolves to `user` ONLY through this controlled path.

**Request:**
```
POST /api/users/invite
Authorization: Bearer <Supabase access token>
Content-Type: application/json

{ "email": "teammate@example.com" }
```

**Success Response (200):**
```json
{ "invited": true, "email": "teammate@example.com" }
```

**Possible Errors:**
- `400 API_REQUEST_INVALID` — missing/invalid email
- `401 API_AUTH_REQUIRED` / `401 API_AUTH_INVALID` — missing/invalid token
- `403 EMAIL_VERIFICATION_REQUIRED` / `403 APP_ACCESS_REQUIRED` — caller not verified / no access
- `403 OWNER_REQUIRED` — caller is not the owner
- `409 USER_ALREADY_EXISTS` — an account with this email already exists
- `502 USER_INVITE_FAILED` — the invitation email could not be sent, or provisioning failed (the invitee stays `NULL` — fail closed)
- `503 SERVER_NOT_READY` — user management not configured (missing `SUPABASE_SECRET_KEY` / `APP_BASE_URL`)

---

### POST /api/users/:id/resend-invite

**Owner only.** Resends a GENUINELY pending invitation (target must be
`user_type = 'user'` with an unconfirmed email). Because Supabase exposes no
admin API that re-sends an invitation email for an existing account
(`generateLink(type: 'invite')` only CREATES a link — nothing is delivered —
and `/auth/v1/admin/users/:id/resend` does not exist, both verified live),
the resend DELIVERS by removing the never-used pending account (a pending
invitee has never authenticated and holds no data; `public.users` follows
via FK cascade) and issuing a FRESH native `inviteUserByEmail` invitation
to the same address, then re-provisioning the application row
(`user_type = 'user'`). The user id changes — semantically a new invitation.
The email redirects to `/set-password` exactly like the original invite.

**Request:**
```
POST /api/users/<user-id>/resend-invite
Authorization: Bearer <Supabase access token>
```

**Success Response (200):** `{ "resent": true, "email": "…" }`

**Possible Errors:**
- `400 API_REQUEST_INVALID` — malformed user id
- `403 OWNER_REQUIRED` / `403 ACCOUNT_BLOCKED` / … — authorization gates
- `404 USER_NOT_FOUND` — no managed user with this id
- `409 USER_ACTION_INVALID` — target is the owner, or the invitation was already accepted
- `502 USER_ACTION_FAILED` — the pending account could not be removed
- `502 USER_INVITE_FAILED` — the new invitation email could not be sent / provisioning failed (fail closed)

### POST /api/users/:id/block

**Owner only.** Blocks a managed user: `status = 'blocked'`. Blocking is
enforced by application authorization ONLY (this backend's
`requireAuthorizedUser`, the RLS helpers `private.can_access_app` /
`private.is_owner`, and the frontend access resolver) — every layer re-checks
the status live per request, so a blocked user is locked out immediately even
while a previously-issued access token remains cryptographically valid.
(Supabase Auth exposes no admin API to revoke another user's sessions by id;
session revocation is deliberately NOT part of the block.) Only verified, active users can be
blocked (an unconfirmed account is invitation-pending: resend or remove).

**Request:**
```
POST /api/users/<user-id>/block
Authorization: Bearer <Supabase access token>
```

**Success Response (200):** `{ "blocked": true }`

**Possible Errors:**
- `400 API_REQUEST_INVALID` — malformed user id
- `403 OWNER_REQUIRED` / authorization gates
- `404 USER_NOT_FOUND` — no managed user with this id
- `409 USER_ACTION_INVALID` — target is the owner / the requester / already blocked / invitation still pending
- `502 USER_ACTION_FAILED` — the status write failed

### POST /api/users/:id/unblock

**Owner only.** Unblocks a managed user: `status = 'active'`. The role is
never touched and neither is any business data.

**Success Response (200):** `{ "unblocked": true }`

**Possible Errors:** as above; `409 USER_ACTION_INVALID` when the target is
not blocked.

### POST /api/users/:id/reset-password

**Owner only.** Sends the NATIVE Supabase password-recovery email — actually
DELIVERED through `resetPasswordForEmail` (the admin `generateLink`
API only creates a link and never sends one — verified live). The owner
never chooses another user's password; only verified users are eligible
(unconfirmed accounts are invitation-pending — resend the invitation).

**Success Response (200):** `{ "sent": true, "email": "…" }`

**Possible Errors:** as above; `409 USER_ACTION_INVALID` when the target's
invitation is still pending; `502 USER_ACTION_FAILED` when Supabase refuses
the send (e.g. its per-email rate limit).

### DELETE /api/users/:id

**Owner only.** Permanently removes a managed user's FUSION ONE ACCOUNT via
the trusted admin API. `public.users` follows through the FK cascade.
Shared business data (invoices, parties, transactions, payments, accounts,
inventory, financial years, WhatsApp configuration, store) has NO per-user
ownership and is never deleted by a user's removal.

**Success Response (200):** `{ "removed": true }`

**Possible Errors:**
- `400 API_REQUEST_INVALID` — malformed user id
- `403 OWNER_REQUIRED` / authorization gates
- `404 USER_NOT_FOUND` — no managed user with this id (or a NULL-role account)
- `409 USER_ACTION_INVALID` — target is the owner or the requester
- `502 USER_ACTION_FAILED` — the Auth account could not be deleted

---

## 5. State Model

The backend exposes exactly **9 WhatsApp RUNTIME states** plus a separate
**session dimension** (`NONE` / `PRESENT` / `RESTORING`, reported by
`GET /api/status` as `whatsapp.session`). Runtime state and session state
are independent: a valid session can exist while the runtime is `IDLE`,
and a runtime can be active with no session (`PAIRING`).

| State | Description |
|-------|-------------|
| `STARTING` | Server is starting up; transitions to `IDLE` once startup completes (the runtime does not auto-start) |
| `IDLE` | The Baileys runtime is intentionally stopped. The session dimension tells whether a session is configured (`PRESENT` — wake-able without QR) or not (`NONE` — Connect applies). Idling NEVER deletes a valid session |
| `PAIRING` | No valid session; waiting for QR scan to pair |
| `CONNECTING` | Attempting to connect/wake/restore with session material |
| `CONNECTED` | WhatsApp is connected and ready to send messages |
| `RECONNECTING` | Connection lost (transient); attempting to reconnect with backoff |
| `LOGGING_OUT` | Logout in progress; session being destroyed |
| `SECURITY_INVALIDATED` | Security violation detected; session being destroyed |
| `STOPPING` | Server is shutting down |

### State Transitions (High-Level)

```
STARTING → IDLE (server startup — the runtime does not auto-start)

IDLE → PAIRING (explicit login, no reusable session anywhere → QR)
IDLE → CONNECTING (wake: session PRESENT or a Redis restoration — client
                   presence, sendInvoice, or explicit login)
IDLE → LOGGING_OUT (explicit logout of a stored session while idle)

PAIRING → CONNECTING (QR scanned, credentials obtained)
PAIRING → IDLE (abandoned pairing — last client gone + grace expired;
                unvalidated residue discarded)

CONNECTING → CONNECTED (connection established / session candidate VALIDATED)
CONNECTING → RECONNECTING (transient failure)
CONNECTING → SECURITY_INVALIDATED (all session candidates definitively
                                    rejected, or a validated session's auth
                                    failure)
CONNECTING → IDLE (runtime retention — last client gone + grace expired;
                   session PRESERVED)
CONNECTING → PAIRING (candidate rejected + Redis candidate rejected +
                      EXPLICIT login intent → cleanup → pairing; a wake
                      settles to IDLE + NONE instead)

CONNECTED → RECONNECTING (transient disconnect)
CONNECTED → LOGGING_OUT (user-initiated logout)
CONNECTED → SECURITY_INVALIDATED (security violation)
CONNECTED → IDLE (runtime retention — last client gone + grace expired;
                  session PRESERVED)

RECONNECTING → CONNECTED (reconnected successfully)
RECONNECTING → SECURITY_INVALIDATED (auth failure during reconnect)
RECONNECTING → IDLE (runtime retention — session PRESERVED)

LOGGING_OUT → IDLE (logout complete — session destroyed locally AND in Redis)

SECURITY_INVALIDATED → IDLE (session destroyed — locally AND in Redis)

ANY STATE → STOPPING (graceful shutdown — session always PRESERVED)
```

The runtime never auto-pairs: after boot (`STARTING → IDLE`), after logout,
after security invalidation, and after a stale-session cleanup, the state
stays `IDLE` with no session until an explicit `POST /api/whatsapp/login`
moves it to `PAIRING` (no reusable session) or `CONNECTING` (a reusable
session — wake, no QR). Client presence and `sendInvoice` may WAKE the
runtime (`IDLE → CONNECTING`) but never pair it.

**Runtime demand + the 5-minute client-disconnect grace:** the runtime is
retained while any real demand exists — one or more authenticated clients
present (SSE streams), an in-flight startup/restore, an active send
operation, or a transient reconnect flow. When the LAST client disconnects
and no other demand remains, a 5-minute shutdown grace
(`WHATSAPP_CLIENT_DISCONNECT_GRACE_MS`, default 300000) starts; a client
returning within it cancels the stop and reuses the running runtime. After
the grace the runtime performs an INTENTIONAL shutdown into `IDLE`: the
socket, keepalives, reconnect loops and QR runtime all stop; a validated
session is preserved and remains wake-able. An abandoned pairing (never
validated) additionally discards its unregistered residue. Status reads,
health checks, pings and protocol traffic are NOT demand. Intentional stops
never reconnect (the socket's event listeners are removed before it is
ended); transient failures still reconnect with the existing bounded
backoff.

### Session Candidate Resolution

Session recovery tries candidates IN ORDER and only promotes a candidate to
`PRESENT` after WhatsApp validates it over a real connection:

1. **LOCAL** auth directory (the active authoritative session).
2. **REDIS** backup (the durable recovery replica) — consulted only when
   local material is missing, corrupted, or definitively rejected by
   WhatsApp (a QR emitted during `CONNECTING`, or a security-coded
   disconnect during the pre-validation connect).

Rules:
- A definitively invalid backup (undecryptable/corrupt/format mismatch) is
  invalidated and the system converges to no-session; a Redis
  timeout/unavailability NEVER invalidates the backup (transient failures
  are not session invalidation).
- When every candidate is definitively rejected, ONE deterministic cleanup
  (the authoritative `destroySession`) removes the local material AND
  invalidates the Redis backup — the session becomes `NONE`, the runtime
  `IDLE`, with no reconnect loop, no restore loop, and no automatic pairing.
  Pairing then begins ONLY for an explicit login intent.
- The startup/restore path is protected by a session generation/epoch:
  every destructive operation invalidates the generation first, and an async
  restore that raced a destruction discards its result — a destroyed
  session can never resurrect. A successful restore is checkpointed back to
  Redis from the current validated local material (non-blocking).

### Key Behaviors

- **Transient failures** (network disconnect, timeout) trigger `RECONNECTING`
  with bounded exponential backoff (1s, 2s, 4s, 8s, 16s, 30s, 60s with jitter).
  This only applies when the session was previously authenticated (`CONNECTED`
  or `CONNECTING` state).
- **Pairing transient failures** — during `PAIRING` state, transient disconnects
  (e.g., Baileys code 515 `restartRequired`) do NOT enter `RECONNECTING`. The
  backend creates a new socket to obtain a fresh QR code while staying in
  `PAIRING` state.
- **Security/authentication failures** (logged out, bad session, identity
  mismatch) trigger `SECURITY_INVALIDATED` → session destruction →
  `IDLE` with no session. These are **fail-closed** — the backend never self-heals auth
  failures, and Baileys stays OFF until an explicit `POST /api/whatsapp/login`.
- **Normal shutdown** preserves the session (does NOT wipe credentials).
- **Logout** wipes the session (locally AND the Redis backup) and transitions to `IDLE` — Baileys stays
  OFF until an explicit `POST /api/whatsapp/login` (no QR is generated after
  logout).

---

## 6. Event Model

The backend emits exactly **6 event types** via SSE. All events conform to a
single envelope schema:

```json
{
  "type": "EVENT_TYPE",
  "timestamp": "2026-08-14T12:00:00.000Z",
  "data": { ... }
}
```

### Connection Method

Connect to `GET /api/events` with a **fetch-based SSE client** — the stream
requires the `Authorization: Bearer <Supabase access token>` header, which the
native `EventSource` API cannot send:

```javascript
const response = await fetch('http://localhost:3000/api/events', {
  headers: { Authorization: `Bearer ${supabaseAccessToken}` },
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split('\n\n');
  buffer = parts.pop() ?? '';
  for (const part of parts) {
    const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue; // keepalive/comment line
    const envelope = JSON.parse(dataLine.slice('data: '.length));
    console.log(envelope.type, envelope.data);
  }
}
```

> **Snapshot pattern:** SSE only delivers events from the moment of
> connection. After connecting, fetch `GET /api/status` (with the same
> `Authorization` header) for an initial snapshot — it includes the current
> WhatsApp state and the QR code when one is available.

### Event Types

#### SERVER_STATE_CHANGED

Emitted when the server's overall state changes (e.g., running → stopping).

```json
{
  "type": "SERVER_STATE_CHANGED",
  "timestamp": "...",
  "data": {
    "state": "stopping",
    "prevState": "running"
  }
}
```

#### WHATSAPP_STATE_CHANGED

Emitted on every WhatsApp state transition (see [State Model](#5-state-model)).

```json
{
  "type": "WHATSAPP_STATE_CHANGED",
  "timestamp": "...",
  "data": {
    "state": "CONNECTED",
    "prevState": "CONNECTING",
    "session": "PRESENT"
  }
}
```

`session` (optional) carries the SESSION dimension (`NONE` / `PRESENT` /
`RESTORING`) alongside the runtime states — the frontend needs it to
distinguish `IDLE` with a wake-able session from `IDLE` with nothing.

#### WHATSAPP_QR_AVAILABLE

Emitted when a new QR code is available for pairing. The `qr` field is a data
URL that can be displayed directly in an `<img>` tag. `expiresInSeconds` and
`expiresAt` are always set (each QR is valid for 60 seconds before Baileys
rotates it — `qrTimeout: 60_000`; rotation continues indefinitely while
pairing, and there is no manual refresh endpoint).

```json
{
  "type": "WHATSAPP_QR_AVAILABLE",
  "timestamp": "...",
  "data": {
    "qr": "data:image/png;base64,iVBORw0KGgo...",
    "expiresInSeconds": 60,
    "expiresAt": "2026-08-14T12:01:00.000Z"
  }
}
```

#### WHATSAPP_QR_COUNTDOWN

Emitted every second while a QR code is displayed, reporting the time
remaining before it expires. A stale countdown from an older QR cycle cannot
interfere with a newer one (generation-ID guarded).

```json
{
  "type": "WHATSAPP_QR_COUNTDOWN",
  "timestamp": "...",
  "data": {
    "remainingSeconds": 18,
    "expiresAt": "2026-08-14T12:01:00.000Z"
  }
}
```

#### MESSAGE_SEND_RESULT

Emitted when a `sendInvoice` operation completes (success or failure).

**Success:**
```json
{
  "type": "MESSAGE_SEND_RESULT",
  "timestamp": "...",
  "data": {
    "requestId": "req-1700000000-abcdef",
    "recipient": "919123456789@s.whatsapp.net",
    "result": "success"
  }
}
```

**Failure:**
```json
{
  "type": "MESSAGE_SEND_RESULT",
  "timestamp": "...",
  "data": {
    "requestId": "req-1700000000-abcdef",
    "recipient": "919123456789@s.whatsapp.net",
    "result": "failed",
    "errorCode": "WHATSAPP_SEND_FAILED"
  }
}
```

The `recipient` field contains the normalized WhatsApp JID (not the original
phone number input). The `errorCode` field is only present on failure and
contains one of the registered error codes (see [Error Codes](#9-error-codes)).

#### MESSAGE_JOB_RESULT

Emitted when a durable message job settles (auto-send, reminder, receipt,
or statement). The PERSISTENT truth is the `message_jobs` table (readable by
authorized app users under RLS); this event is the optional live UI
notification that a job finished — sent to every authenticated SSE client.

```json
{
  "type": "MESSAGE_JOB_RESULT",
  "timestamp": "...",
  "data": {
    "jobId": "0c7b5f8e-....",
    "jobType": "reminder",
    "refType": "sale",
    "refId": "9d2c1a34-....",
    "trigger": "automatic",
    "result": "succeeded",
    "errorCode": "WHATSAPP_SEND_FAILED: Failed to send the WhatsApp message."
  }
}
```

- `jobType` — `invoice_send` | `reminder` | `receipt` | `statement`.
- `refType` / `refId` — the business object the job references
  (`sale` / `purchase` / `proforma` / `payment_in` / `payment_out`).
- `trigger` — `automatic` (the scheduler picked the job up: invoice
  auto-send, reminder chain, or an AUTOMATIC receipt for a subsequent
  payment — nobody awaits these, so this event is their user-feedback
  channel) or `manual` (a user-awaiting inline execution whose HTTP response
  carries the UI feedback).
- `result` — `succeeded` | `retrying` | `failed` | `cancelled`
  (`retrying` = a retryable failure; the job returned to `pending` with
  backoff and will execute again; `cancelled` = the chain stopped: invoice
  fully paid / cancelled / reminders disabled / limit reached / superseded
  by a manual send).
- `errorCode` — present on `failed` (and retry information is persisted on
  the job row, not the event).

#### SECURITY_EVENT

Emitted when a security invariant is violated (e.g., identity mismatch,
corrupted session).

```json
{
  "type": "SECURITY_EVENT",
  "timestamp": "...",
  "data": {
    "code": "WHATSAPP_AUTH_INVALID",
    "reason": "WhatsApp security failure (code: 401)"
  }
}
```

The `code` field contains a registered error code. The `reason` field contains
a human-readable description of the security violation.

---

## 7. sendInvoice API

### Endpoint

```
POST /api/messages/sendInvoice
```

### Purpose

Sends an invoice as **one** WhatsApp document message (PDF attachment with the
resolved message as caption), composing everything from the invoice reference.

### The Backend Owns the Invoice Pipeline

**The backend is the invoice engine.** Given only `{invoiceId, invoiceType}`:

- It loads the authoritative invoice data from Supabase **under the requesting
  user's identity** (publishable key + the caller's Supabase JWT — every read
  is RLS-enforced, so the caller can only load invoices, parties, store
  branding, and `whatsapp_settings` their own store owns): invoice header,
  party, items, trade-ins, store branding, and `whatsapp_settings`.
- It computes the canonical invoice (the same proven derivations the
  frontend used: subtotal = Σ base_selling_price, item/additional discount
  composition, trade-in credit mapping).
- It resolves the **recipient** from the invoice's party phone number
  (India-only normalization).
- It resolves the **message** from the `whatsapp_settings` template for the
  invoice type — placeholders (`{{customer_name}}`, `{{invoice_number}}`,
  `{{invoice_date}}`, `{{company_name}}`, `{{grand_total}}`, `{{due_date}}`,
  `{{payment_status}}`, `{{company_phone}}`, `{{company_address}}`) are
  substituted with authoritative data. There is NO hardcoded fallback: a
  missing template fails with `WHATSAPP_TEMPLATE_MISSING`.
- It renders the invoice PDF with **PDFKit** (Prestige design: gold accent,
  black/gold palette, item table with repeated headers across pages, totals
  block, signature area, footer with page numbers on every page).
- It sends the PDF as a Baileys **document** message:
  `{ document: Buffer, mimetype: 'application/pdf', fileName: '<bill_number>.pdf', caption }`.

The client (the FUSIONONE frontend) never supplies invoice rows, totals,
recipients, captions, images, or binaries — only the invoice identity.

### Input

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `invoiceId` | string (UUID) | Yes | Must be a UUID; the row id in `sales` / `purchases` / `proforma_invoices` |
| `invoiceType` | string | Yes | One of `sale`, `purchase`, `proforma` |
| `requestId` | string | No | Max 128 characters; auto-generated if absent |

The schema is **strict** — unknown keys are rejected. The legacy
image-based payload (`recipient` / `image` / `caption`) is rejected with
`API_REQUEST_INVALID` and an explicit "contract has been removed" message.

### Recipient Resolution

The recipient is ALWAYS taken from the invoice's party (`parties.number`,
via the invoice join) — never from the request. The stored number is
normalized to a WhatsApp JID:

| Stored number | Normalized JID |
|-------|----------------|
| `9123456789` (10 digits) | `919123456789@s.whatsapp.net` |
| `919123456789` (91 prefix) | `919123456789@s.whatsapp.net` |
| `+919123456789` (+91 prefix) | `919123456789@s.whatsapp.net` |

- Indian mobile numbers only: 10 digits starting with 6–9, country code 91.
- A missing/empty party phone fails with `PARTY_PHONE_MISSING`.
- A non-Indian (or otherwise invalid) number fails with
  `WHATSAPP_RECIPIENT_INVALID`.

### Store Resolution (single-store deployment)

Store resolution runs under the caller's identity (RLS-scoped — only the
caller's own store rows are visible) and is deterministic and fail-closed:

- Exactly one visible `store` row must exist.
- Zero stores → `STORE_NOT_CONFIGURED` (503).
- Multiple stores → `STORE_CONFIGURATION_AMBIGUOUS` (500).

Identity always comes from the verified JWT. The strict request schema rejects
body-supplied identity fields (`userId` / `ownerId` / `storeId`), so a caller
can never read or send another store's data.

### One WhatsApp Message Behavior

The PDF document and the resolved message are sent as a **single** WhatsApp
document message — the message text is the document's caption. The backend
**never** sends a separate text message and **never** sends an image.

### Success Response

```json
HTTP 200
{
  "success": true,
  "requestId": "req-1700000000-abcdef",
  "messageId": "3EB0C1A2B3C4D5E6"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` on success |
| `requestId` | string | The request ID (client-provided or auto-generated) |
| `messageId` | string | WhatsApp message ID returned by Baileys |

### Error Responses

| HTTP | Code | When |
|------|------|------|
| 400 | `API_REQUEST_INVALID` | Malformed body, missing/non-UUID `invoiceId`, unknown fields, or the removed legacy image payload |
| 400 | `INVALID_INVOICE_TYPE` | `invoiceType` is not `sale`/`purchase`/`proforma` |
| 400 | `PARTY_PHONE_MISSING` | The invoice party has no phone number on file |
| 400 | `WHATSAPP_RECIPIENT_INVALID` | The party's phone number is not a valid Indian mobile number |
| 401 | `API_AUTH_REQUIRED` | No Authorization header |
| 401 | `API_AUTH_INVALID` | Invalid or malformed token |
| 404 | `INVOICE_NOT_FOUND` | No invoice exists with that id |
| 500 | `SERVER_INTERNAL_ERROR` | A Supabase query failed |
| 500 | `STORE_CONFIGURATION_AMBIGUOUS` | Multiple store rows exist |
| 500 | `INVOICE_PDF_GENERATION_FAILED` | PDF rendering failed |
| 503 | `WHATSAPP_NOT_CONNECTED` | WhatsApp is not in `CONNECTED` state |
| 503 | `WHATSAPP_TEMPLATE_MISSING` | No message template configured for this invoice type |
| 503 | `STORE_NOT_CONFIGURED` | No store row exists |
| 503 | `SERVER_NOT_READY` | Server is shutting down or sends are blocked (security/logout) |
| 502 | `WHATSAPP_SEND_FAILED` | Send failed after all retries (transient transport error) |
| 504 | `WHATSAPP_SEND_TIMEOUT` | Send operation did not complete within the timeout |

### Example Request

```bash
curl -X POST http://localhost:3000/api/messages/sendInvoice \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "invoiceId": "d0bbf4b3-14f8-453a-bb59-55d4b7571610",
    "invoiceType": "sale"
  }'
```

`$SUPABASE_ACCESS_TOKEN` is the logged-in user's Supabase access token (e.g.
from `supabase.auth.getSession()` in the FUSIONONE SPA).

### Send Serialization

Only **one** send operation executes at a time. If a second `sendInvoice`
request arrives while one is in progress, it is queued (not rejected). The
send mutex serializes all sends — concurrency = 1. (Invoice composition —
Supabase load + PDF render — happens before the mutex; only the WhatsApp
send itself is serialized.)

### Retry Behavior

- **Retryable errors** (`WHATSAPP_SEND_FAILED`): retried with bounded
  exponential backoff (up to `SEND_MAX_RETRIES` times, default: 3).
- **Non-retryable errors** (all others): returned immediately without retry.

### Send Timeout

Each send attempt has a timeout (default: 30 seconds, via `SEND_TIMEOUT_MS`).
If the send does not complete within this time, it fails with
`WHATSAPP_SEND_TIMEOUT`.

---

## 8. Durable Message System (jobs, scheduler, receipts, reminders)

### Overview

All server-side message work runs through ONE durable job system:

```
Supabase (message_jobs + reminder_settings + business data)
        ▲  due-job polling (periodic scan + poke)
        │
Fastify MessageScheduler  ──  discover → claim → execute → persist
        │
        ├── invoice_send  → invoice document (PDF + thumbnail) + template message
        ├── reminder      → CURRENT sale check → invoice doc + reminder message
        ├── receipt       → payment record → receipt doc (PDF + thumbnail)
        └── statement     → invoice payment history → statement doc (PDF + thumbnail)
        │
        ▼
existing SendController → WhatsAppManager (Baileys) — the ONE transport
```

- **message_jobs** is the single job table (no per-type tables, no Redis
  queue, no external broker). Jobs reference business objects by typed
  foreign keys and never copy financial payload — execution always composes
  from CURRENT authoritative data.
- **reminder_settings** is the per-invoice reminder configuration + durable
  progress (one row per sale; `reminders_sent` counts DELIVERED reminders
  only — attempts live on the job row).
- Job state is SYSTEM-OWNED: `message_jobs` and `reminder_settings` are
  SELECT-only for browser roles (RLS `can_access_app`); writes happen
  exclusively through the backend via the service-role RPCs
  (`claim_due_message_jobs`, `recover_expired_message_jobs`,
  `complete_message_job`, `upsert_reminder_config`,
  `trigger_reminder_now`), which are granted to `service_role` ONLY.
- Ownership boundaries: user-requested operations load business data under
  the CALLER's JWT (RLS — the established repository pattern); durable
  background execution (the scheduler) and job state run under the
  backend's system context. No privileged credential is ever exposed to
  the browser.

### Job lifecycle

```
pending ──claim (SKIP LOCKED, lease)──► processing ──success──► succeeded
   ▲                                        │
   │                                        ├──retry──► pending (run_at = now + backoff)
   │                                        ├──fail───► failed (terminal)
   │                                        └──cancel─► cancelled (chain stopped)
   └── lease expired while processing ────────┘ (recovered automatically)
```

- **Claiming** is atomic (`FOR UPDATE SKIP LOCKED`): two scheduler
  executions (or two backend processes during a deploy overlap) can never
  execute the same job. `attempts` increments on every claim.
- **Recovery** is continuous (every scan, not only startup): a
  `processing` job whose `claim_expires_at` passed becomes `pending` again
  with exponential backoff (60s × 2^(n−1), capped 1h) — or `failed` once
  `attempts` reaches `max_attempts`. Claims are never blindly reset.
- **Restart safety:** jobs live in PostgreSQL. A backend crash at 09:58 and
  restart at 10:07 still executes a 10:00 job (the database IS the
  schedule; no browser, timer, or memory involved).
- **Idempotent creation:** partial unique indexes enforce at most ONE
  pending/processing job per business object per job type — double-clicks,
  re-arms, and retries cannot create duplicate future work.
- **No DB transaction is held during WhatsApp operations**: the claim RPC
  returns before execution; the lease covers the gap.

### Job-level vs transport-level retries

The SendController's existing behavior is unchanged and remains the
TRANSPORT layer: serialized sends, per-attempt timeout, bounded in-request
retries for `WHATSAPP_SEND_FAILED`. The JOB layer owns durable retry
decisions: temporary unavailability (including `WHATSAPP_NOT_CONNECTED`,
timeouts, internal errors) returns the job to `pending` with backoff;
terminal conditions (invalid recipient, missing template/config, gone
business objects) fail or cancel the job.

### Reminder behavior

- Reminders are configured PER INVOICE (sale invoices with an outstanding
  balance). Enabling starts a next-job chain: the first job runs one
  frequency interval after configuration; each successful reminder
  increments `reminders_sent` and creates the next job ONLY if the invoice
  is still active, still has `sales.due > 0`, and the configured maximum
  has not been reached.
- The reminder message always renders the invoice's CURRENT balance due
  (never a frozen amount), and the reminder re-sends the invoice PDF with
  the reminder message.
- Manual ("Send Reminder Now") and scheduled reminders use the SAME
  executor — the manual trigger simply pulls the scheduled job forward
  (or creates a one-off when no chain is configured).
- Full payment or cancellation stops the chain automatically; fully-paid
  invoices never start one.

### Payment receipts

Receipts have TWO triggers, one document framework:

- **Manual** — every payment (including the initial payment made during
  invoice/bill creation) can be receipted at any time from the invoice's
  Payments dialog or the Payments page (`POST /api/messages/sendReceipt`).
- **Automatic (optional, per direction, default OFF)** — a SUBSEQUENT
  payment (`receive_payment` / `pay_purchase`) creates its receipt job
  TRANSACTIONALLY inside the payment RPC (via the private
  `create_auto_receipt_job` SECURITY DEFINER bridge, migration 0007): the
  payment, its accounting updates, and the job commit as ONE database
  transaction — a closed browser or restarted backend can never lose the
  job. The INITIAL payment recorded during `create_sale` /
  `create_purchase` NEVER triggers an automatic receipt (the invoice/bill
  message already carries it); the store switches are
  `whatsapp_settings.auto_send_receipt_in` / `auto_send_receipt_out`.

Both directions (`in`/`out`) use one receipt framework: the receipt
represents the payment that occurred, prepared by the SHARED document
pipeline (Prestige renderer + the same chat-preview thumbnail worker as
invoices — no second renderer, no PDF-only path), delivered as ONE PDF
document message with a caption from the `whatsapp_settings` receipt
templates. A receipt
failure never touches accounting state — the payment remains recorded
regardless. Automatic receipt jobs are idempotent per payment (ONE
pending/processing job; the manual endpoint converges on the same unique
index).

### Payment statements

A Payment Statement represents the ENTIRE payment history of one
invoice/bill — the deliberate counterpart to the one-payment receipt. It is
MANUAL ONLY (no payment operation ever creates one), sent from the
invoice's Payments dialog (`POST /api/messages/sendStatement`). The
document lists EVERY payment (including the initial creation-time payment)
with date/mode/amount, and its aggregates come from the AUTHORITATIVE
invoice row (`sales.paid/due`, `purchases.paid/due`) — composed from CURRENT
data at send time, never a stale snapshot. Rendered by the same shared
Prestige renderer with the same PDF + chat-preview preparation as every
other document (deterministic `STM-` number; `PAID IN FULL` state on a
settled invoice) and a caption from the `payment_statement_in/out`
templates. Idempotency: ONE pending/processing statement per invoice; a
later request after a terminal outcome legitimately creates a fresh job.

### Delivery semantics (honest disclosure)

Delivery is AT-LEAST-ONCE: Baileys/WhatsApp cannot guarantee exactly-once
transport, so a crash between transport acceptance and state persistence
can produce a duplicate send after lease recovery. Claiming + idempotent
creation minimize the window; no exactly-once claim is made.

### Observability

Structured logs cover job creation, claim, execution start, success,
failure, retry scheduling, reminder stop reasons, receipt and statement
composition/failures, auto-send execution, and scheduler start/stop. Empty
scans are silent. Scheduler internals (ticks, claim counts, worker state)
are backend implementation details — not exposed on any API.

## 9. Logout API

### Endpoint

```
POST /api/whatsapp/logout
```

### Purpose

Logs out the connected WhatsApp session and destroys all authentication state.

### What the Backend Does

1. Blocks new send operations
2. Cancels any active send (stateless pipeline — in-flight sends finish or time out)
3. Closes the Baileys WebSocket connection
4. Destroys the session (wipes the authentication directory)
5. Verifies the directory is removed
6. Transitions state: `CONNECTED` → `LOGGING_OUT` → `IDLE` (destroys the local session AND invalidates the Redis backup)

After logout the backend stays `IDLE` with no session — Baileys is OFF and no QR is
generated until an explicit `POST /api/whatsapp/login`.

### What the Frontend Should Expect

- The `POST /api/whatsapp/logout` request returns once the session is destroyed.
- The response includes the final state (`IDLE`).
- SSE events (`WHATSAPP_STATE_CHANGED`) will fire for each state transition.
- No QR code is generated after logout — a `WHATSAPP_QR_AVAILABLE` event only
  appears after a new `POST /api/whatsapp/login`.
- The frontend does NOT need to do anything except observe the state changes.

### Success Response

```json
HTTP 200
{
  "success": true,
  "state": "IDLE",
  "message": "WhatsApp session destroyed"
}
```

### Error Responses

| HTTP | Code | When |
|------|------|------|
| 401 | `API_AUTH_REQUIRED` | No Authorization header |
| 401 | `API_AUTH_INVALID` | Invalid token |
| 503 | `WHATSAPP_NOT_CONNECTED` | Already logged out or in `PAIRING` state (nothing to logout) |
| 503 | `SERVER_NOT_READY` | Server is shutting down |

### Example Request

```bash
curl -X POST http://localhost:3000/api/whatsapp/logout \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

---

## 10. Error Codes

The backend exposes exactly **35 error codes**. No other error codes exist.
All error responses use the canonical envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Safe public message"
  }
}
```

Raw internal exceptions are never exposed — they are mapped to
`SERVER_INTERNAL_ERROR`.

### API Errors

| Code | HTTP | Meaning | When It Occurs |
|------|------|---------|----------------|
| `API_AUTH_REQUIRED` | 401 | Authentication is required | Command endpoint called without `Authorization` header |
| `API_AUTH_INVALID` | 401 | Invalid credentials | Malformed `Authorization` header or wrong token |
| `API_FORBIDDEN` | 403 | Not authorized | Authenticated but not permitted (reserved for future use) |
| `API_RATE_LIMITED` | 429 | Too many requests | Rate limit exceeded (reserved for future use) |
| `API_REQUEST_INVALID` | 400 | Malformed request | Missing/invalid fields (non-UUID `invoiceId`), unknown/extra keys (including the removed legacy payload keys `recipient`/`image`/`caption`), validation failure |
| `API_REQUEST_TOO_LARGE` | 413 | Body too large | Request body exceeds `MAX_REQUEST_BODY_BYTES` |
| `API_METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method | e.g., `GET` on a `POST`-only endpoint |
| `API_NOT_FOUND` | 404 | Endpoint not found | Unknown URL path |

### WhatsApp Errors

| Code | HTTP | Meaning | When It Occurs |
|------|------|---------|----------------|
| `WHATSAPP_NOT_CONNECTED` | 503 | Not connected | `sendInvoice` or `logout` called when not in `CONNECTED` state |
| `WHATSAPP_CONNECTION_FAILED` | 503 | Connection failed | Failed to establish a WhatsApp connection (registered; not emitted by any current code path) |
| `WHATSAPP_AUTH_INVALID` | 401 | Auth invalid | WhatsApp authentication is invalid (session may be destroyed) |
| `WHATSAPP_SESSION_INVALID` | 401 | Session invalid | WhatsApp session is no longer valid (registered; not emitted by any current code path) |
| `WHATSAPP_RECIPIENT_INVALID` | 400 | Bad recipient | The invoice party's stored phone number is not a valid Indian mobile number |
| `WHATSAPP_SEND_FAILED` | 502 | Send failed | Message send failed after all retries |
| `WHATSAPP_SEND_TIMEOUT` | 504 | Send timed out | Send operation did not complete within the timeout |

### Invoice Errors (backend-owned invoice pipeline)

| Code | HTTP | Meaning | When It Occurs |
|------|------|---------|----------------|
| `INVALID_INVOICE_TYPE` | 400 | Invalid invoice type | `invoiceType` is not `sale`/`purchase`/`proforma` |
| `INVOICE_NOT_FOUND` | 404 | Invoice not found | No invoice with that id is visible to the caller (RLS-enforced) |
| `STORE_NOT_CONFIGURED` | 503 | Store missing | No `store` row is visible to the caller |
| `STORE_CONFIGURATION_AMBIGUOUS` | 500 | Ambiguous store | Multiple `store` rows are visible to the caller |
| `PARTY_PHONE_MISSING` | 400 | Party phone missing | The invoice party has no phone number on file |
| `WHATSAPP_TEMPLATE_MISSING` | 503 | Template missing | No message template configured for this invoice type |
| `INVOICE_PDF_GENERATION_FAILED` | 500 | PDF failed | Invoice PDF rendering failed |
| `INVOICE_SEND_FAILED` | 502 | Send failed | Registered invoice-send failure code (reserved — current transport failures surface as `WHATSAPP_SEND_FAILED`) |
| `PAYMENT_NOT_FOUND` | 404 | The requested payment was not found. |
| `PAYMENT_DIRECTION_INVALID` | 400 | The payment direction is invalid. Allowed: in, out. |
| `REMINDER_NOT_ELIGIBLE` | 409 | This invoice is not eligible for a payment reminder (fully paid or cancelled). |
| `MESSAGE_JOB_CONFLICT` | 409 | A message for this document is already being sent. |

### Security Errors

| Code | HTTP | Meaning | When It Occurs |
|------|------|---------|----------------|
| `SECURITY_POLICY_VIOLATION` | 403 | Security violation | A security invariant was violated |
| `SECURITY_IDENTITY_MISMATCH` | 403 | Identity mismatch | Connected JID does not match configured expected JID |
| `SECURITY_SESSION_CORRUPTED` | 500 | Session corrupted | Session state is corrupted and cannot be used (registered; not emitted by any current code path) |
| `SECURITY_SESSION_CLEANUP_FAILED` | 500 | Cleanup failed | Failed to wipe the session directory (fail-closed) |

### Server Errors

| Code | HTTP | Meaning | When It Occurs |
|------|------|---------|----------------|
| `SERVER_NOT_READY` | 503 | Server not ready | Server is starting, shutting down, or sends are blocked |
| `SERVER_BUSY` | 503 | Server busy | Server cannot process the request at this time (registered; not emitted by any current code path) |
| `SERVER_OPERATION_TIMEOUT` | 504 | Operation timed out | A server operation timed out (registered; not emitted by any current code path) |
| `SERVER_INTERNAL_ERROR` | 500 | Internal error | Unhandled internal error (raw details are never exposed) |

---

## 11. Client Implementation Guide

### Recommended Client Flow

```
1. Load status
   → GET /api/status (Authorization header)
   → Display current WhatsApp state
     (IDLE after boot — the runtime does not auto-start)

2. Connect SSE
   → GET /api/events (fetch-based SSE with Authorization header)
   → Subscribe to all event types
   → Refresh the snapshot via GET /api/status
     (includes the QR when one is available)

3. Start login when the user wants to connect
   → POST /api/whatsapp/login (Authorization header, no body)
   → Idempotent — safe to re-issue to surface a fresh QR

4. Wait for WhatsApp state
   → Listen for WHATSAPP_STATE_CHANGED events
   → Update UI based on state

5. Display QR while pairing
   → Listen for WHATSAPP_QR_AVAILABLE / WHATSAPP_QR_COUNTDOWN events
   → Show QR image when available

6. Send invoice request
   → POST /api/messages/sendInvoice {invoiceId, invoiceType}
   → Observe MESSAGE_SEND_RESULT event for outcome

7. Logout when required
   → POST /api/whatsapp/logout
   → Observe state transitions via SSE (ends at IDLE —
     no QR until a new POST /api/whatsapp/login)
```

### Key Implementation Notes

1. **Do not poll aggressively.** Use SSE for real-time updates. A periodic
   status refresh (e.g., every 30s) is acceptable as a fallback.

2. **Handle SSE reconnection.** A fetch-based SSE client does not
   auto-reconnect — implement reconnect with backoff yourself and refresh the
   snapshot via `GET /api/status` after every reconnect.

3. **Validate client-side, but trust server-side validation.** The backend
   validates all inputs — client-side validation is for UX only.

4. **Display errors cleanly.** All errors use the canonical envelope with a
   `code` and `message`. Never show raw exceptions or stack traces.

5. **The backend owns the lifecycle.** The client should never:
   - Start, stop, or initialize WhatsApp
   - Generate QR codes
   - Reconnect the WebSocket
   - Destroy session files

6. **No invoice data on the client.** `sendInvoice` takes only `invoiceId`,
   `invoiceType`, and an optional `requestId` — the backend loads the invoice,
   renders the PDF, and resolves the recipient and message itself.

7. **Authentication.** Send the `Authorization: Bearer <Supabase access token>`
   header (the logged-in user's token) with EVERY `/api/*` request, including
   the SSE stream. Native `EventSource` cannot send headers — use fetch-based
   SSE.

8. **Recipient resolution.** The recipient is resolved server-side from the
   invoice party's stored phone number (Indian mobile: 10 digits starting with
   6–9, with or without the `91` country code). Clients never supply a
   recipient.

9. **CORS.** The backend allows requests from the configured `CLIENT_ORIGIN`
   (production: `https://one.fusiongadgets.in`; local default:
   `http://localhost:5173`). No additional CORS configuration is
   needed on the client side — the browser handles it automatically.

---

## 12. Example Client Flow

### Startup

```
Client opens
    ↓
GET /api/status (Authorization header)
  → { whatsapp: { state: "IDLE", session: "NONE", qrAvailable: false, qr: null } }
    ↓
Connect SSE → GET /api/events (fetch-based, Authorization header)
    ↓
User chooses to connect → POST /api/whatsapp/login (no body)
    ↓
Receive WHATSAPP_STATE_CHANGED → { state: "PAIRING", prevState: "IDLE", session: "NONE" }
    ↓
Receive WHATSAPP_QR_AVAILABLE → display QR
    ↓
User scans QR with phone
    ↓
Receive WHATSAPP_STATE_CHANGED → { state: "CONNECTING", prevState: "PAIRING" }
    ↓
Receive WHATSAPP_STATE_CHANGED → { state: "CONNECTED", prevState: "CONNECTING" }
    ↓
Client is ready to send invoices
```

### Send Invoice

```
User clicks "Send on WhatsApp" for a saved invoice
    ↓
POST /api/messages/sendInvoice (Authorization header)
    {
      "invoiceId": "d0bbf4b3-14f8-453a-bb59-55d4b7571610",
      "invoiceType": "sale"
    }
    ↓
Backend: loads the invoice under the caller's identity (RLS) → renders the
PDF → resolves the party's phone + message template → sends ONE document
message (application/pdf, <bill_number>.pdf, caption, JPEG preview)
    ↓
HTTP 200 → { success: true, requestId: "...", messageId: "..." }
    ↓
Receive MESSAGE_SEND_RESULT → { result: "success", requestId: "...", recipient: "919123456789@s.whatsapp.net" }
    ↓
Display success to user
```

### Send Invoice Failure

```
POST /api/messages/sendInvoice (when not connected)
    ↓
HTTP 503 → { error: { code: "WHATSAPP_NOT_CONNECTED", message: "WhatsApp is not connected." } }
    ↓
Display error code and message to user
```

### Logout

```
User clicks "Logout"
    ↓
POST /api/whatsapp/logout
    ↓
Receive response → { success: true, state: "IDLE", session: "NONE", message: "WhatsApp session destroyed" }
    ↓
Receive SSE events:
  WHATSAPP_STATE_CHANGED → { state: "LOGGING_OUT", prevState: "CONNECTED" }
  WHATSAPP_STATE_CHANGED → { state: "IDLE", prevState: "LOGGING_OUT", session: "NONE" }
    ↓
Session destroyed — Baileys is OFF; no QR is generated
until a new POST /api/whatsapp/login
```

### Security Invalidation (Automatic)

```
WhatsApp auth fails (e.g., session revoked from phone)
    ↓
Receive SECURITY_EVENT → { code: "WHATSAPP_AUTH_INVALID", reason: "..." }
    ↓
Receive WHATSAPP_STATE_CHANGED → { state: "SECURITY_INVALIDATED", prevState: "CONNECTED" }
    ↓
Backend destroys session automatically
    ↓
Receive WHATSAPP_STATE_CHANGED → { state: "IDLE", prevState: "SECURITY_INVALIDATED", session: "NONE" }
    ↓
Baileys is OFF — the user must POST /api/whatsapp/login
to pair again
```
