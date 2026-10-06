# Project Worklog

---
Task ID: P0
Agent: main (Z.ai Code)
Task: Repository reset — remove obsolete Next.js/Prisma application, initialize clean Node.js/TypeScript backend project

Work Log:
- Inspected repository: found Next.js 16 + Prisma + Tailwind + shadcn/ui application
- Stopped running Next.js dev server and telemetry processes
- Removed all obsolete artifacts: src/, public/, prisma/, db/, .next/, next.config.ts, postcss.config.mjs, tailwind.config.ts, components.json, eslint.config.mjs, next-env.d.ts, bun.lock, node_modules/, .env
- Created new package.json with Fastify 5, @whiskeysockets/baileys, pino, zod, qrcode, vitest, typescript
- Created strict tsconfig.json for Node.js ESNext (ESM)
- Created .env.example with all configuration variables
- Updated .gitignore for Node.js backend project
- Created directory structure: src/{config,logging,errors,state,events,session,whatsapp,security,invoice,watchdog,api/routes,storage,utils} tests data/whatsapp/auth
- Installed dependencies (338 packages)
- Created minimal src/index.ts (Fastify server on port 3000, GET / and /health/live)
- Verified: server starts on port 3000, responds 200, typecheck passes, build compiles

Stage Summary:
- Clean Node.js/TypeScript backend project established
- No Next.js or Prisma code remains
- Baseline scripts work: dev, build, start, test, typecheck, db:push (no-op)
- Server compatible with .zscripts/dev.sh infrastructure (port 3000, GET / health check)
- Ready for Phase 1 (config, logging, error foundation)

---
Task ID: P1
Agent: main (Z.ai Code)
Task: Configuration, structured logging, closed error registry

Work Log:
- Created src/config/index.ts: zod-validated config, frozen singleton, security checks (rejects insecure default API_TOKEN in production, warns in development)
- Created src/logging/logger.ts: pino-based structured logger with redaction of credentials/keys/secrets/QR/session/sensitive payloads, context logger with requestId/deliveryId/invoiceId
- Created src/errors/registry.ts: closed error registry with exactly 28 error codes across 5 families (API, WhatsApp, Invoice, Security, Server), HTTP status mapping, AppError class, toAppError() for mapping unknown errors to SERVER_INTERNAL_ERROR
- Created vitest.config.ts
- Wrote tests/errors.test.ts (11 tests) and tests/config.test.ts (7 tests)
- All 18 tests pass, typecheck passes

Stage Summary:
- Config validates required values, never invents secrets, rejects insecure defaults in production
- Logger redacts all sensitive fields (apiToken, creds, keys, qr, sessionData, etc.)
- Error registry is a closed set — no public error code exists outside it
- AppError.toJSON() exposes only code + safe message, never internal details
- toAppError() ensures no raw exception escapes to frontend
- Ready for Phase 2 (closed state model)

---
Task ID: P2
Agent: main (Z.ai Code)
Task: Closed state model with validated transitions

Work Log:
- Created src/state/whatsapp-states.ts: 9 canonical WhatsApp states (STARTING, PAIRING, CONNECTING, CONNECTED, RECONNECTING, LOGGING_OUT, LOGGED_OUT, SECURITY_INVALIDATED, STOPPING), forbidden states guard
- Created src/state/invoice-states.ts: 5 canonical invoice states (QUEUED, SENDING, SENT, FAILED, CANCELLED), terminal state identification
- Created src/state/transitions.ts: explicit transition tables for both WhatsApp and invoice states, validation functions
- Created src/state/state-machine.ts: generic deterministic StateMachine<TState> with transition enforcement, lock for shutdown, forceTransition for security recovery
- Created tests/setup.ts: test environment configuration loader
- Wrote tests/state.test.ts: 59 tests covering every valid transition, every invalid transition, forbidden states, terminal states, state machine enforcement
- All 77 tests pass (18 from Phase 1 + 59 from Phase 2), typecheck passes

Stage Summary:
- Closed state model: exactly 9 WhatsApp states + 5 invoice states, no others
- All transitions explicitly validated against the specification's transition matrix
- Any active state → STOPPING is supported for graceful shutdown
- Invalid transitions are rejected internally and logged as invariant failures
- State machine can be locked (for shutdown) and force-transitioned (for security recovery)
- Ready for Phase 3 (closed event contract)

---
Task ID: P3
Agent: main (Z.ai Code)
Task: Closed event contract registry with validated SSE schema

Work Log:
- Created src/events/registry.ts: 5 canonical event types (SERVER_STATE_CHANGED, WHATSAPP_STATE_CHANGED, WHATSAPP_QR_AVAILABLE, INVOICE_STATE_CHANGED, SECURITY_EVENT), zod-validated per-event data schemas, buildEvent() constructor, serializeForSSE() serializer
- Created src/events/emitter.ts: typed EventBus with onAll/onType subscriptions, emitEvent() validates and broadcasts, invalid events are dropped and logged
- Wrote tests/events.test.ts: 16 tests covering closed set, schema validation for each event type, invalid event rejection, SSE serialization, bus delivery and unsubscribe
- All 93 tests pass, typecheck passes

Stage Summary:
- Closed event model: exactly 5 event types, no others
- All events validated against per-type zod schemas before emission
- Invalid events are dropped (never reach frontend) and logged as invariant failures
- EventBus supports multiple SSE subscribers, unsubscribe is clean
- QR content is sent to frontend via event data but redacted from logs
- Ready for Phase 4 (SessionManager)

---
Task ID: P4
Agent: main (Z.ai Code)
Task: SessionManager - isolated auth dir, destroySession authoritative op

Work Log:
- Created src/utils/mutex.ts: AsyncMutex for serializing critical sections
- Created src/session/lifecycle.ts: LifecycleManager singleton (lifecycle lock, sends-blocked flag, shutting-down flag)
- Created src/session/SessionManager.ts: 
  - Isolated auth directory at <DATA_DIR>/whatsapp/auth/
  - sessionExists() checks for creds.json
  - isSessionCorrupted() checks if creds.json exists but is invalid
  - ensureAuthDir() creates the directory
  - destroySession(reason, mode) — the single authoritative destruction operation
  - Supports 'logout', 'security', 'shutdown' modes
  - Full sequence: lock → block sends → transition → close socket → invalidate auth → remove dir → verify removal → clear QR → transition → emit → release lock
  - Fail-closed on cleanup failure: SECURITY_SESSION_CLEANUP_FAILED, sends remain blocked
  - WhatsAppLifecycleHooks interface for Baileys-specific operations (avoids circular imports)
- Wrote tests/session.test.ts: 16 tests covering session existence, corruption detection, all 3 destruction modes, cleanup failure (fail closed), socket error during destruction, isolation
- All 109 tests pass, typecheck passes

Stage Summary:
- SessionManager owns the isolated auth directory — only auth/session material stored there
- destroySession is the single authoritative destruction operation used by both logout and security
- Fail-closed behavior: if directory removal fails, SECURITY_SESSION_CLEANUP_FAILED is emitted and sends stay blocked
- Cleanup verification: directory removal is verified, not assumed
- Lifecycle lock serializes destruction; sends-blocked flag prevents new sends during destruction
- Ready for Phase 5 (WhatsAppManager with Baileys)

---
Task ID: P5-P7
Agent: main (Z.ai Code)
Task: WhatsAppManager (Baileys), automatic onboarding, reconnect/self-healing

Work Log:
- Created src/whatsapp/WhatsAppManager.ts:
  - Owns exactly ONE Baileys socket (singleton, no per-request sockets)
  - Implements WhatsAppLifecycleHooks for SessionManager coordination
  - initialize(): checks session existence/corruption, enters PAIRING/CONNECTING, creates socket
  - createSocket(): closes old socket, loads auth state, creates new socket with proper config
  - onConnectionUpdate(): handles QR, connection open, connection close
  - Security failure detection: loggedOut(401), badSession(500), connectionReplaced(440), multideviceMismatch(411), forbidden(403) → destroy session, fail closed
  - Transient failure detection: connectionClosed(428), connectionLost(408), timedOut(408), restartRequired(515), unavailableService(503) → reconnect with backoff
  - Bounded exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, 30s, 60s
  - handleSecurityFailure(): transitions to SECURITY_INVALIDATED, emits event, destroys session, re-creates socket for pairing
  - validateIdentity(): checks connected JID against configured EXPECTED_WHATSAPP_JID
  - sendMessage(): validates recipient, checks sends-blocked, checks connection, sends via Baileys
  - isValidJid(): validates WhatsApp JID format (individual and group)
  - QR generation via qrcode package (data URL for frontend)
- Phase 6 (automatic onboarding): fully implemented in initialize() — backend creates QR automatically, frontend only reads
- Phase 7 (reconnect/self-healing): scheduleReconnect() with bounded backoff+jitter; security failures fail-closed (no reconnect)
- Wrote tests/whatsapp.test.ts: 19 tests covering initialization (no session/existing/corrupted), connection events (open/QR/transient disconnect), security failures (auth failure, SECURITY_EVENT), sendMessage (success/invalid JID/not connected/blocked), lifecycle hooks
- All 128 tests pass, typecheck passes

Stage Summary:
- Single Baileys socket — never multiple concurrent sockets
- Backend owns complete WhatsApp lifecycle (onboarding, connection, reconnect, logout, security)
- Transient failures self-heal with bounded backoff; security failures destroy session (fail-closed)
- Identity validation enforced when EXPECTED_WHATSAPP_JID is configured
- Corrupted sessions detected and destroyed at startup
- QR generated automatically, never logged (redacted by logger)
- Ready for Phase 8 (SecurityManager)

---
Task ID: P8
Agent: main (Z.ai Code)
Task: SecurityManager - explicit invariants, fail-closed

Work Log:
- Created src/security/SecurityManager.ts:
  - triggerSecurityInvalidation(reason, code): centralized fail-closed response (block sends → SECURITY_INVALIDATED → emit event → destroy session → re-create socket)
  - assertSendAllowed(): checks shutdown, sends-blocked, and connection state; throws appropriate AppError
  - verifyInvariants(): checks 4 runtime invariants (sends blocked in SECURITY_INVALIDATED/LOGGING_OUT, identity match, auth dir isolation)
  - isSecurityCompromised() / isOperational(): state checks
  - Only explicitly defined security conditions trigger invalidation (no heuristics)
- Wrote tests/security.test.ts: 17 tests covering assertSendAllowed (all states), triggerSecurityInvalidation (blocks, transitions, emits, destroys), verifyInvariants (clean, violations, auth dir isolation), state checks
- All 145 tests pass, typecheck passes

Stage Summary:
- SecurityManager is the central authority for security decisions
- Fail-closed: security invalidation always blocks sends and destroys session
- Only explicitly defined conditions trigger invalidation (no behavioral heuristics)
- 10 security invariants enforced across the system (most by existing code, SecurityManager centralizes verification)
- Auth directory isolation verified: only Baileys auth files allowed
- Ready for Phases 9-16 (API layer, invoice system)

---
Task ID: P9-P19
Agent: main (Z.ai Code)
Task: API layer, authentication, SSE, invoice system, graceful shutdown, watchdog, health

Work Log:
- Created src/invoice/InvoiceStore.ts: persistent JSON file store with atomic writes, idempotency indexes (byRequestId, byDeliveryId, byInvoiceId), promise-based init (race-condition safe)
- Created src/invoice/InvoiceFormatter.ts: formats invoice content as WhatsApp text message
- Created src/invoice/InvoiceSender.ts: serialized sending (concurrency=1 via AsyncMutex), idempotency (requestId/invoiceId), retry (transient only), timeout, state transitions, cancelActive
- Created src/api/auth.ts: Bearer token authentication, command endpoints require auth, read endpoints configurable, health endpoints public
- Created src/api/sse.ts: SSE manager with keepalive, broadcast to all clients, clean disconnect (no state change)
- Created src/api/server.ts: Fastify server with all routes (GET /, /health/live, /health/ready, /api/status, /api/events, POST /api/invoices/send, /api/whatsapp/logout), error handler maps to closed error registry, 404/405/413 handling
- Created src/watchdog/Watchdog.ts: periodic checks for stuck sends, security invariants, connection state
- Created src/app.ts: Application class tying everything together, graceful shutdown (SIGTERM/SIGINT), session preserved on shutdown
- Updated src/index.ts: entry point using Application class
- Wrote tests/invoice.test.ts: 15 tests covering store CRUD/persistence/idempotency, sender serialization/idempotency/validation/failure-handling
- Fixed critical race condition in InvoiceStore.init() — concurrent calls could overwrite each other's data
- All 160 tests pass, typecheck passes

Stage Summary:
- Complete API layer: 7 endpoints, no additional lifecycle APIs
- API auth: Bearer token for commands, configurable for reads, health always public
- SSE: real-time event streaming, observer-only (no state changes on disconnect)
- Invoice system: serialized (1 concurrent send), idempotent (requestId/invoiceId), retryable (transient only), timeout-protected
- Graceful shutdown: SIGTERM/SIGINT, preserves session, closes SSE/HTTP/Baileys
- Watchdog: stuck send detection, security invariant verification
- Health: live (process alive), ready (operational state)
- Ready for Phase 20 (comprehensive API tests) and Phase 21 (E2E)

---
Task ID: P20-P22
Agent: main (Z.ai Code)
Task: Test suite, E2E verification, final audit

Work Log:
- Wrote tests/api.test.ts: 18 tests covering health endpoints, authentication (missing/invalid/malformed), invoice send (valid/invalid body, status codes), status, error handling (404, internal errors), logout, schema validation
- Wrote tests/invoice.test.ts: 15 tests covering store CRUD/persistence/idempotency, sender serialization/idempotency/validation/failure-handling
- Fixed critical race condition in InvoiceStore.init() — concurrent calls could overwrite data
- Fixed idempotency for CANCELLED/FAILED invoices — re-send with new requestId now updates existing record
- Fixed Baileys import issue — changed from default import to named import for Node.js ESM compatibility
- Fixed Fastify error handler — 415 (Unsupported Media Type) now maps to API_REQUEST_INVALID
- Silenced Baileys internal logger to prevent credential/key leakage to logs
- Added unhandledException/unhandledRejection handlers to prevent silent crashes
- All 178 tests pass (9 test files): config(7), errors(11), state(59), events(16), session(16), whatsapp(19), security(17), invoice(15), api(18)
- Typecheck passes, build compiles successfully

E2E Verification:
- Server starts on port 3000, all API endpoints verified working:
  - GET / → 200 (service info)
  - GET /health/live → 200 (alive)
  - GET /health/ready → 200 (ready, PAIRING state)
  - GET /api/status → 200 (PAIRING, QR available)
  - POST /api/invoices/send without auth → 401 (API_AUTH_REQUIRED)
  - POST /api/invoices/send with bad auth → 401 (API_AUTH_INVALID)
  - POST /api/invoices/send with invalid body → 400 (INVOICE_INVALID)
  - POST /api/invoices/send valid (not connected) → CANCELLED + WHATSAPP_NOT_CONNECTED
  - POST /api/invoices/send same requestId → idempotent (returns existing result)
  - GET /api/unknown → 404 (API_NOT_FOUND)
- QR code generation works (data URL returned in status and SSE events)
- Serialized invoice sending verified (concurrency=1)
- Idempotency verified (same requestId returns existing result)

Environmental Limitation:
- The Baileys library's WebSocket connection causes intermittent process crashes after ~20-30 seconds in this sandbox environment
- This is a runtime compatibility issue: Bun has incomplete ws package support; Node.js also experiences crashes from the WhatsApp WebSocket connection
- The server functions correctly for all API operations during its uptime
- A full real WhatsApp E2E test (scanning QR, sending real invoice to real recipient) could not be performed because:
  1. No real WhatsApp account is available for pairing in this sandbox
  2. The WebSocket connection to WhatsApp servers is unstable in this environment
- All testable functionality has been verified via unit tests (178 passing) and API-level E2E tests

Stage Summary:
- 178 unit/integration tests pass
- All API endpoints verified working via curl
- Backend is fully implemented across all 22 phases
- State machine, error registry, event system, security manager, invoice system all operational
- Environmental limitation: Baileys WebSocket instability prevents sustained server uptime and real WhatsApp pairing

---
Task ID: REFACTOR
Agent: main (Z.ai Code)
Task: Surgical refactor — replace invoice business domain with minimal sendInvoice media-message pipeline

Work Log:
- Phase 1: Established baseline (178 tests pass). Built dependency map classifying all components as KEEP/MODIFY/REMOVE.
- Phase 2: Removed invoice-domain persistence:
  - Deleted src/invoice/InvoiceStore.ts (persistent invoice records, idempotency indexes)
  - Deleted src/invoice/InvoiceFormatter.ts (invoice-to-text formatting)
  - Deleted src/invoice/InvoiceSender.ts (invoice state machine, persistence-coupled sending)
  - Deleted src/state/invoice-states.ts (invoice state model QUEUED/SENDING/SENT/FAILED/CANCELLED)
  - Deleted tests/invoice.test.ts
  - Updated src/state/transitions.ts — removed invoice transition table, kept WhatsApp transitions
  - Updated src/errors/registry.ts — removed 5 invoice-specific error codes (INVOICE_INVALID, INVOICE_MISSING, INVOICE_ALREADY_SENT, INVOICE_ALREADY_PROCESSING, INVOICE_SEND_REJECTED)
  - Updated src/events/registry.ts — replaced INVOICE_STATE_CHANGED with SEND_INVOICE_RESULT (payload: requestId, recipient, result, errorCode)
  - Updated src/security/SecurityManager.ts — changed blocked-sends error from INVOICE_SEND_REJECTED to SERVER_NOT_READY
  - Updated src/config/index.ts — removed invoiceStorePath, renamed invoiceSendTimeoutMs→sendTimeoutMs, invoiceMaxRetries→sendMaxRetries, invoiceRetryBaseMs→sendRetryBaseMs
  - Updated src/logging/logger.ts — added image/caption to redact paths, simplified createContextLogger
- Phase 3: Created minimal send pipeline:
  - Created src/send/schema.ts — zod validation for sendInvoice request (recipient, image data URL, caption?), parseDataUrl, parseSendInvoiceRequest
  - Created src/send/SendController.ts — serialized send (concurrency=1 via AsyncMutex), timeout, transient retry, SEND_INVOICE_RESULT event emission, stateless (no persistence)
  - Modified src/whatsapp/WhatsAppManager.ts — replaced sendMessage(recipient, text) with sendImageMessage(recipient, imageBuffer, mimeType, caption?) — sends image + optional caption as ONE WhatsApp message
- Phase 4: Updated API/event contract:
  - Updated src/api/server.ts — replaced POST /api/invoices/send with POST /api/whatsapp/sendInvoice, removed invoice store from /api/status, updated ServerDeps to use SendController
  - Updated src/api/auth.ts — updated COMMAND_PATHS from /api/invoices/send to /api/whatsapp/sendInvoice
  - Updated src/watchdog/Watchdog.ts — removed InvoiceStore dependency and stuck-invoice check (send pipeline is stateless; SendController timeout handles stuck sends)
  - Updated src/app.ts — wired up SendController instead of InvoiceSender, removed InvoiceStore initialization
  - Updated src/session/lifecycle.ts — updated comments (invoice→send)
  - Updated .env.example and .env — renamed config fields, removed INVOICE_STORE_PATH
- Phase 5: Updated all tests:
  - Updated tests/setup.ts — renamed config env vars
  - Updated tests/config.test.ts — renamed config field assertions, added test verifying invoice fields removed
  - Updated tests/errors.test.ts — removed invoice codes from REQUIRED_CODES, added test verifying they're absent
  - Updated tests/events.test.ts — replaced INVOICE_STATE_CHANGED tests with SEND_INVOICE_RESULT tests
  - Updated tests/state.test.ts — removed all invoice state/transition tests (59→40 tests)
  - Updated tests/security.test.ts — changed INVOICE_SEND_REJECTED reference to SERVER_NOT_READY
  - Updated tests/whatsapp.test.ts — changed sendMessage tests to sendImageMessage tests, added test verifying image+caption sent as ONE message
  - Updated tests/api.test.ts — replaced /api/invoices/send with /api/whatsapp/sendInvoice, updated payloads (image data URL), removed invoice store, added tests for missing recipient/image/invalid image/unsupported type/old endpoint gone
  - Created tests/send.test.ts — 17 tests covering SendController success/failure/serialization/timeout/stateless + schema validation
- Phase 6: E2E validation:
  - Server starts on port 3000
  - GET /health/live → alive
  - GET /api/status → PAIRING, no invoices field
  - POST /api/whatsapp/sendInvoice no auth → 401 API_AUTH_REQUIRED
  - POST /api/whatsapp/sendInvoice bad auth → 401 API_AUTH_INVALID
  - POST /api/whatsapp/sendInvoice invalid body → 400 API_REQUEST_INVALID
  - POST /api/whatsapp/sendInvoice invalid recipient → 400 API_REQUEST_INVALID
  - POST /api/whatsapp/sendInvoice when not connected → 503 WHATSAPP_NOT_CONNECTED
  - POST /api/invoices/send (old endpoint) → 404 API_NOT_FOUND
  - Server remains alive after all API tests

Final Results:
- Typecheck: PASS
- Build: PASS
- Tests: 177/177 PASS (9 test files)
- E2E: All API endpoints verified working

Components Changed:
- REMOVED: src/invoice/InvoiceStore.ts, src/invoice/InvoiceFormatter.ts, src/invoice/InvoiceSender.ts, src/state/invoice-states.ts, tests/invoice.test.ts
- CREATED: src/send/SendController.ts, src/send/schema.ts, tests/send.test.ts
- MODIFIED: src/api/server.ts, src/api/auth.ts, src/events/registry.ts, src/errors/registry.ts, src/state/transitions.ts, src/watchdog/Watchdog.ts, src/app.ts, src/config/index.ts, src/logging/logger.ts, src/security/SecurityManager.ts, src/whatsapp/WhatsAppManager.ts, src/session/lifecycle.ts, .env.example, .env, tests/setup.ts, tests/config.test.ts, tests/errors.test.ts, tests/events.test.ts, tests/state.test.ts, tests/security.test.ts, tests/whatsapp.test.ts, tests/api.test.ts
- KEPT UNCHANGED: src/state/whatsapp-states.ts, src/state/state-machine.ts, src/session/SessionManager.ts, src/api/sse.ts, src/events/emitter.ts, src/utils/mutex.ts, src/index.ts

Stage Summary:
- The backend no longer creates, stores, updates, persists, or understands invoices as business objects
- The sendInvoice operation sends image + optional caption as ONE WhatsApp message
- All security/reliability infrastructure preserved (auth, state machine, session manager, security manager, reconnect, watchdog, graceful shutdown, SSE, health)
- No invoice persistence remains — the send pipeline is fully stateless
- The closed error registry has 23 codes (5 invoice codes removed)
- The closed event registry has 5 types (INVOICE_STATE_CHANGED replaced with SEND_INVOICE_RESULT)
- The WhatsApp state machine is unchanged (9 states)
- No invoice state machine exists

---
Task ID: RECONNECT-FIX
Agent: main (Z.ai Code)
Task: Fix WhatsApp reconnect state transition bug

Work Log:
- Inspected WhatsAppManager.onConnectionUpdate() — identified the bug:
  - In the transient failure branch, scheduleReconnect() was called unconditionally
  - Even when the transition to RECONNECTING was rejected (e.g., from PAIRING state)
  - This meant a reconnect timer would fire during initial QR pairing, but reconnect() would abort because state wasn't RECONNECTING
- Fix: Added transitionToReconnecting() helper method that:
  - Returns true only if the state transition to RECONNECTING succeeds (or is already RECONNECTING)
  - Returns false if the transition is invalid (e.g., from PAIRING, LOGGED_OUT, etc.)
  - scheduleReconnect() is now only called when transitionToReconnecting() returns true
- Refactored both transient failure and unknown status code branches to use the new helper
- Preserved the RECONNECTING state guard in reconnect() — it still checks state === RECONNECTING before proceeding
- Did NOT add new states, did NOT weaken state validation, did NOT modify the state machine
- Added 3 tests to tests/whatsapp.test.ts:
  1. CONNECTED → transient disconnect → RECONNECTING → reconnect executes (verifies new socket created after backoff)
  2. PAIRING → transient disconnect → remains PAIRING (verifies no reconnect scheduled, no new socket created)
  3. authentication failure → SECURITY_INVALIDATED (verifies fail-closed, session destroyed, not retried)
- All 180 tests pass (177 original + 3 new), typecheck passes, build compiles

Stage Summary:
- Bug fixed: reconnect timer only schedules when state successfully transitions to RECONNECTING
- PAIRING state no longer incorrectly schedules reconnect attempts on transient disconnect
- RECONNECTING state guard preserved in reconnect() method
- State machine, state validation, and all existing tests unchanged

---
Task ID: p1-audit
Agent: main (Z.ai Code architect)
Task: Phase 1 — Audit existing WhatsApp lifecycle, map socket create/destroy paths, find root causes, classify KEEP/MODIFY/REMOVE

Work Log:
- Read all 20 source files in src/ + all client files + test setup
- Ran baseline typecheck (PASS) and tests (197 pass, 2 flaky QR timer fails — pre-existing)
- Mapped complete socket lifecycle and dependency graph

Stage Summary — ROOT CAUSES IDENTIFIED:

1. AUTO-START AT STARTUP: app.ts calls whatsappManager.initialize() which auto-creates a Baileys socket. Must change to transition STARTING → LOGGED_OUT (Baileys OFF).

2. NO EXPLICIT LOGIN: No POST /api/whatsapp/login endpoint, no WhatsAppManager.startLogin(). Must add both.

3. NO 10-MINUTE TIMEOUT: No login attempt tracking. Must add loginAttemptId + deadline + race-protected callback.

4. AUTO-RECREATE AFTER SECURITY: WhatsAppManager.handleSecurityFailure() (line 575) and SecurityManager.triggerSecurityInvalidation() (line 115) both call createSocket() after session destruction. Must remove — Baileys stays OFF until explicit login.

5. AUTO-TRANSITION TO PAIRING AFTER DESTRUCTION: SessionManager.destroySession() transitions LOGGED_OUT → PAIRING and calls unblockSends(). Must change to stay in LOGGED_OUT (no auto-onboarding).

6. LOGOUT ENDPOINT CREATES NEW SOCKET: server.ts line 241 calls createSocket() after destroySession. Must remove.

7. PAIRING → SECURITY_INVALIDATED BUG: ALREADY FIXED in current code — AUTHENTICATED_STATES excludes PAIRING, security-coded disconnects during PAIRING go to schedulePairingRetry(). Verify this remains intact.

SOCKET CREATION PATHS (exactly 1 owner = WhatsAppManager.createSocket):
- initialize() at startup → REMOVE
- handleSecurityFailure() → REMOVE
- SecurityManager.triggerSecurityInvalidation() → REMOVE
- reconnect() → KEEP (transient reconnect)
- retryPairing() → KEEP (QR refresh during pairing)
- NEW: startLogin() → ADD

CLASSIFICATION:
- KEEP (unchanged): StateMachine, WhatsAppState, EventRegistry, ErrorRegistry, EventBus, SSEManager, SendController, SendSchema, LifecycleManager, Watchdog, Mutex, Logger, Config, QR countdown logic (generation ID already implemented)
- MODIFY: transitions.ts, WhatsAppManager.ts, SessionManager.ts, SecurityManager.ts, app.ts, server.ts, auth.ts, client App.tsx + client.ts + types/api.ts
- REMOVE: none

TRANSITION TABLE CHANGES:
- STARTING: +LOGGED_OUT
- PAIRING: +LOGGED_OUT (login timeout)
- CONNECTING: +LOGGED_OUT (login timeout)
- LOGGED_OUT: +CONNECTING (login with stored session)
- SECURITY_INVALIDATED: PAIRING→LOGGED_OUT (changed)

---
Task ID: p2-p7
Agent: main (Z.ai Code architect)
Task: Phases 2-7 — Implement explicit login lifecycle, 10-min timeout, fix failure classification, QR correctness, client updates, and comprehensive tests

Work Log:
- transitions.ts: Added LOGGED_OUT transitions (STARTING→LOGGED_OUT, PAIRING→LOGGED_OUT, CONNECTING→LOGGED_OUT, LOGGED_OUT→CONNECTING). Changed SECURITY_INVALIDATED→LOGGED_OUT (was →PAIRING).
- WhatsAppManager.ts: Added startLogin() with idempotency, loginAttemptId tracking, 10-min timeout with 5-condition race protection, completeLoginAttempt() on CONNECTED, cancelLoginAttempt() in closeSocket/stop. Removed auto-createSocket from handleSecurityFailure. Added unblockSends() on CONNECTED.
- SessionManager.ts: destroySession now transitions to LOGGED_OUT (not PAIRING). Both logout and security modes end in LOGGED_OUT. Sends unblocked after destruction.
- SecurityManager.ts: Removed auto-createSocket from triggerSecurityInvalidation.
- app.ts: Replaced whatsappManager.initialize() with stateMachine.transition(LOGGED_OUT). Baileys OFF at startup.
- server.ts: Added POST /api/whatsapp/login endpoint. Removed createSocket() from logout endpoint.
- auth.ts: Added /api/whatsapp/login to COMMAND_PATHS.
- Client: Added login() API function, LoginResponse type, Login button in App.tsx (shown when LOGGED_OUT), updated ConnectionStatus for LOGGED_OUT color.
- Fixed 3 flaky QR countdown tests by mocking qrcode module and using full fake timers with microtask flushing.
- Created tests/lifecycle.test.ts with 25 new tests covering: login lifecycle, 10-min timeout, race condition, QR generation identity, connected state (no app-imposed lifetime), failure classification (PAIRING 500/515, CONNECTED transient/auth), logout, security, sendInvoice-when-OFF, session persistence.

Stage Summary:
- typecheck: PASS
- tests: 227/227 PASS (10 test files, 0 failures)
- All architectural invariants verified by tests

---
Task ID: p8-verification
Agent: main (Z.ai Code architect)
Task: Phase 8 — Full validation: typecheck, build, test suite, E2E browser verification

Work Log:
- typecheck: PASS (tsc --noEmit, zero errors)
- build: PASS (tsc compiles to dist/)
- test suite: 227/227 PASS across 10 test files (0 failures)
- E2E browser verification (Agent Browser):
  - GET / → 200, JSON {"service":"whatsapp-invoice-backend","status":"running"}
  - GET /api/status → state=LOGGED_OUT, connected=false, qrAvailable=false (Baileys OFF at startup)
  - POST /api/whatsapp/login → state=PAIRING, success=true (Baileys started on demand)
  - GET /api/status after login → state=PAIRING (correct)
  - GET /api/status without auth → 200 (public read endpoint)
  - POST /api/whatsapp/sendInvoice when OFF → WHATSAPP_NOT_CONNECTED (503, does NOT auto-start Baileys)
  - dev.log confirms NO "Baileys socket created" at startup — only after explicit login

Stage Summary:
- All 20+ architectural invariants verified
- Final WhatsApp lifecycle: STARTING→LOGGED_OUT (OFF)→[login]→PAIRING/CONNECTING→CONNECTED→[logout]→LOGGED_OUT
- 10-minute login timeout with race protection verified by tests
- QR generation identity verified by tests
- Failure classification verified: PAIRING 500/515 stays PAIRING, CONNECTED transient→RECONNECTING, CONNECTED auth failure→SECURITY_INVALIDATED→LOGGED_OUT
- No duplicate Baileys socket path
- No abandoned login timer leak
- No session wipe during pairing
- No periodic forced reconnect
- No accidental automatic Baileys startup
- sendInvoice returns WHATSAPP_NOT_CONNECTED when OFF (does NOT start Baileys)
- SSE remains the frontend observation channel

---
Task ID: render-disconnect-fix
Agent: main (Z.ai Code architect)
Task: Investigate and fix Render-specific Baileys pairing disconnects (25-second statusCode 500 cycle)

Work Log:
- Audited all 7 items requested:
  1. PID logging added to app.ts startup — detect duplicate Render instances
  2. Verified isCreatingSocket guard prevents duplicate sockets (already correct)
  3. Auth directory path + sessionExists logged in createSocket() — verify persistent volume on Render
  4. Added describeDisconnect() helper with full Boom error diagnostics: statusCode, reasonName, errorMessage, errorName, boomPayload, boomErrorType, disconnectDate, hasOutput. All 3 close-handler branches now log full disconnect details.
  5. Verified retryPairing() state check prevents retry during active authentication (already correct)
  6. Verified QR countdown timer (startQrCountdown) only emits events — never creates sockets (already correct)
  7. Added diagnostic guard in retryPairing(): logs warning if this.socket is non-null when retry fires

ROOT CAUSE IDENTIFIED AND FIXED:
- createSocket() and closeSocket() called this.socket.end() and set this.socket = null, but did NOT remove event listeners from the old socket's EventEmitter (socket.ev).
- The event handler closures capture `this`, not a specific socket instance. So a delayed connection.update event from a CLOSED socket would still be processed by onConnectionUpdate().
- On local networks (near-zero latency), the old socket's close event is fully drained before the new socket processes anything — invisible.
- On Render (higher latency), a stale connection: 'close' from the old socket arrives AFTER the new socket is created, triggering a spurious schedulePairingRetry() → creating the 25-second disconnect cycle.
- FIX: Added socket.ev.removeAllListeners('connection.update') and removeAllListeners('creds.update') BEFORE socket.end() in both createSocket() and closeSocket(). This guarantees no event from the old socket can reach the handler after cleanup.

Stage Summary:
- typecheck: PASS
- build: PASS
- tests: 227/227 PASS (no regression)
- No security logic changed
- No QR lifecycle rules changed
- No reconnect systems added
- Only diagnostic logging + event-listener cleanup added

---
Task ID: THUMB-PROD-FIX-1
Agent: main (Z.ai Code)
Task: Apply the confirmed production fix for the WhatsApp invoice document-thumbnail rendering issue (pixel-dimension envelope) and remove the investigation-driven overengineering.

Work Log:
- Inspected the current repository: backend at /home/z/my-project/backend; read src/invoice/thumbnail.ts (1208 lines), src/invoice/send.ts, src/send/SendController.ts, src/whatsapp/WhatsAppManager.ts, tests/{thumbnail,document-transport,send-pipeline,send}.test.ts
- Confirmed the structured DocumentThumbnail {jpeg,width,height} contract was already flowing end-to-end (send.ts → SendController → WhatsAppManager → jpegThumbnail/thumbnailWidth/thumbnailHeight on the Baileys document message)
- src/invoice/thumbnail.ts: changed ONLY the production geometry/quality configuration — THUMBNAIL_WIDTH_PX 587→444, THUMBNAIL_MAX_HEIGHT_PX 440→250, JPEG quality ladder 65/55/45→100/90/80 (fallback rungs are byte-budget safeguard only, never reduce resolution); rewrote the stale constant comments (removed 587×300 / 640×327 / 640×480 / 300×225 / "50-70 band" claims; documented the live-verified 444×250 production-safe envelope and the width=444 / height=min(safe crop,250) invariant); renderer, crop semantics, worker protocol, failure isolation untouched
- src/whatsapp/WhatsAppManager.ts: removed the investigation-only runtime diagnostics (proto.Message.DocumentMessage.fromObject protoThumbnailBytes inspection + 'Document message thumbnail attachment' forensic log block) and the now-dead `proto` import; the send path is now simply: construct {document, mimetype, fileName, caption?, jpegThumbnail?, thumbnailWidth?, thumbnailHeight?} → socket.sendMessage()
- tests/thumbnail.test.ts: S = 444/595.28; SHORT dimensions 587×300 → 444×227 (bottomPt 304.12pt derivation); LONG asserts rows≥1, rows<14, width=444, height≤250; TRADE_IN renamed to "never renders a partial trade-in section" (tradeInRows=0 — the trade-in section no longer fits the ~335pt crop budget), bottomPt ≤ 335.21; header-only preview height = 200 (267.05pt derivation); gold-bar comment 2.2px → 1.7px
- tests/document-transport.test.ts: production geometry 587×264/440 → 444×227/250; REMOVED the forensic "Baileys serialization" describe (3 tests replaying content through generateWAMessageContent + proto encode/decode round-trips — investigation machinery introduced to rule out Baileys stripping the thumbnail, conclusively ruled out by live testing) plus the now-dead stubUpload helper and generateWAMessageContent/proto/WAMediaUploadFunction imports; kept the permanent socket-boundary regression (ONE sendMessage with document/mimetype/fileName/caption/jpegThumbnail/thumbnailWidth/thumbnailHeight + null/empty/NaN degradation) and the SendController chain tests
- tests/send-pipeline.test.ts: mocked generator geometry 587×300 → 444×227
- Verified NO other stale references remain (587/440/640/327/65-55-45/protoThumbnail/stubUpload sweeps clean; remaining matches are phone-number false positives and intentional historical-context comments)
- Validation: typecheck PASS; full suite 331 passed / 7 skipped (pre-existing Redis-gated integration skips); thumbnail tests 15/15; transport+pipeline 11/11; production build (tsc) PASS
- Test-only local render sanity check (NO WhatsApp messages sent): short invoice → 444×227 @ 24,385 bytes, long invoice → 444×227 @ 25,213 bytes (quality 100, comfortably under the 65,536-byte ceiling — no ladder fallback triggered)

Stage Summary:
- Exact constants now: THUMBNAIL_WIDTH_PX=444, THUMBNAIL_MAX_HEIGHT_PX=250, THUMBNAIL_JPEG_QUALITY=100, FALLBACK=90, LAST_RESORT=80, SOFT_LIMIT=65,536 (unchanged)
- Files changed (5): src/invoice/thumbnail.ts, src/whatsapp/WhatsAppManager.ts, tests/{thumbnail,document-transport,send-pipeline}.test.ts; files removed: none (one forensic test describe + dead imports removed from document-transport.test.ts)
- One coherent production thumbnail design: generator renders the final 444×(≤250) envelope at quality 100 from the canvas worker; DocumentThumbnail {jpeg,width,height} passes unchanged through SendController into the Baileys documentMessage; nothing re-encoded/resized downstream
- Untouched as required: pdf.ts, prestige.ts, builders.ts, repository.ts, types.ts, session lifecycle, SessionManager, Redis backup, auth, SSE, API routes, SendController retry/mutex

---
Task ID: backend-cleanup-1
Agent: main (Z.ai Code)
Task: BACKEND-ONLY cleanup and simplification pass — remove excessive comments, dead code, test-only infrastructure and all backend tests; preserve architecture and behavior exactly. No frontend changes.

Work Log:
- Phase 1 inspection: read every src module, all 21 test files' surface, package.json, tsconfig, vitest.config, .env.example, Caddyfile, API.md; mapped ownership (WhatsAppManager runtime / SessionManager session / SessionBackup Redis / state machine / SSE+presence / SendController+invoice pipeline / SecurityManager / API layer).
- Created the single pre-cleanup ZIP backup at /home/z/my-project/backend-pre-cleanup.zip (82 files: all source, tests, config incl. .env, docs; excludes node_modules, dist, live data/) — untouched afterward.
- Support modules: whatsapp-states.ts (removed unused FORBIDDEN_STATES/isWhatsAppState/assertNotForbiddenState), transitions.ts (removed unused WHATSAPP_TRANSITIONS re-export), state-machine.ts (removed unused isLocked()), lifecycle.ts (removed test-only reset()/__resetLifecycle), emitter.ts (removed unused onType, __resetEventBus), events/registry.ts (buildEvent switch replaced by a DATA_SCHEMAS record — same schemas, same parse semantics), logger.ts (removed unused createContextLogger, __resetLogger), config (removed __test__), mutex/ClientPresence (removed unused reset(); comment trims).
- Session layer: SessionManager (inlined the removeAuthDirectory/verifyDirectoryRemoved/emitSecurityEvent wrappers — identical operations; removed unused get state()), SessionBackup (removed clientCreationCount, __test__, __resetBackupClientForTests, unused scheduler enabled/pending getters; compacted the socket-timeout WHY note).
- WhatsAppManager: comments rewritten to WHY-only (2199 -> 1813 lines); code-verified diff vs backup shows ONLY: calculateBackoff/isValidJid unexported, test-only dispose() removed, unsubscribeState field removed (subscription lives for the process lifetime), one Render-specific log message simplified. All lifecycle logic byte-identical.
- API layer: auth.ts (requiresAuth simplified to the equivalent /api/ prefix check; test seams removed), sse.ts (unused clientCount getter, __resetSSEManager removed), server.ts (route comments compacted; CORS/error-handler logic untouched), app.ts (securityManager kept as a local — same wiring; test-only accessors removed; Watchdog constructed with its new 2-arg signature), Watchdog (unused constructor deps dropped; no-op checkConnectionState removed; checkSecurityInvariants inlined — identical logic), SecurityManager (unused isSecurityCompromised removed).
- Send/invoice: SendController (comment trims; `return await` merge), schema/send/delivery/builders/types/repository comment trims; repository internals unexported; __setSupabaseForTests removed. thumbnail.ts (FROZEN): removed ONLY the stats counters, getThumbnailWorkerStats, and the two __*ForTests functions — worker protocol, renderer, geometry, quality untouched. pdf.ts/prestige.ts untouched (their comments are genuine geometry/encoder WHY notes).
- Deleted all backend tests: tests/ (21 files, 8245 lines), data-test/ fixture, vitest.config.ts; removed the test/test:watch scripts and the vitest devDependency; bun.lock updated (vitest gone); tsconfig exclude list trimmed to node_modules/dist.
- Behavior comparison: comments-stripped code diff of every src file vs the backup — every difference is on the intended-change list, nothing else moved (code lines 5658 -> 5396).
- Verification: typecheck PASS, production build (tsc -> dist) PASS, clean restart (also exercised graceful shutdown: SSE closed -> watchdog stopped -> shutdown complete, zero errors), full endpoint sweep: / 200, /health/live 200, /health/ready 200 (ready/IDLE), /ping 204 with token + 401 fail-closed without, all /api/* 401 without JWT (authHook contract), bad JWT -> API_AUTH_INVALID, /api/status 200 with real test JWT (exact response shape incl. the two-axis state/session + QR lifecycle fields), cancelPairing idempotent no-op 200 from IDLE+NONE, logout-without-session 503 WHATSAPP_NOT_CONNECTED, legacy sendInvoice body rejected 400, unknown invoice 404 INVOICE_NOT_FOUND, unknown non-API path 404 canonical envelope, SSE stream connects and drives client presence (first client -> automatic wake -> "found no reusable session — remaining idle" -> last client gone), CORS preflight allowed for configured origins, no unexpected errors in the backend log, redaction active. No CJK characters introduced.

Stage Summary:
- SAME SYSTEM, SIMPLER IMPLEMENTATION: src 9148 -> 7601 lines (-17%), comments now explain WHY only; all 21 test files + test fixtures + vitest infra removed from the working backend (preserved in backend-pre-cleanup.zip); every removed code member was verified unused; architecture and externally observable behavior unchanged (verified by code-diff audit + live API/SSE/shutdown checks).
- Pre-cleanup backup: /home/z/my-project/backend-pre-cleanup.zip (single, untouched).
- Frontend untouched. Thumbnail transport/geometry/quality untouched.
