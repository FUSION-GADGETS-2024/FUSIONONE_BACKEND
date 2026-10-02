/**
 * API Server — Fastify with all application routes. Route-level
 * authorization: "[app user]" = verified + provisioned FUSION ONE user
 * (owner or user); "[owner]" = owner only. Every /api route passes the JWT
 * authentication hook (api/auth.ts) and then an explicit application-
 * authorization check — a valid JWT alone never suffices.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/logger.js';
import { getLifecycle } from '../session/lifecycle.js';
import { getSSEManager } from './sse.js';
import { authHook } from './auth.js';
import { requireAuthorizedUser, requireOwner } from './authorize.js';
import { registerUserRoutes } from './users.js';
import { AppError, ErrorCode, toAppError } from '../errors/registry.js';
import { WhatsAppState } from '../state/whatsapp-states.js';
import { parseSendInvoiceRequest } from '../send/schema.js';
import { sendInvoiceById } from '../invoice/send.js';
import type { WhatsAppManager } from '../whatsapp/WhatsAppManager.js';
import type { SecurityManager } from '../security/SecurityManager.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { SendController } from '../send/SendController.js';
import type { StateMachine } from '../state/state-machine.js';
import type { WhatsAppStateValue } from '../state/whatsapp-states.js';
import type { ClientPresence } from '../whatsapp/ClientPresence.js';

export interface ServerDeps {
  whatsappManager: WhatsAppManager;
  securityManager: SecurityManager;
  sessionManager: SessionManager;
  sendController: SendController;
  stateMachine: StateMachine<WhatsAppStateValue>;
  /** Authenticated client presence (fed by the SSE route; drives runtime
   *  demand and the automatic wake). */
  clientPresence: ClientPresence;
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const cfg = getConfig();

  const app = Fastify({
    logger: false, // we use our own pino logger
    bodyLimit: cfg.maxRequestBodyBytes,
  });

  // CORS: only the configured CLIENT_ORIGIN list is allowed. No wildcard in
  // production — the API uses Bearer tokens, not cookies.
  await app.register(cors, {
    origin: (origin, cb) => {
      if (
        origin === undefined ||
        cfg.allowedOrigins.includes('*') ||
        cfg.allowedOrigins.includes(origin)
      ) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    credentials: false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'Accept-Language', 'Cache-Control', 'Pragma', 'X-Client-Info', 'X-Supabase-Api-Version'],
  });

  app.addHook('preHandler', authHook);

  // Bodyless API calls: several endpoints (block/unblock/reset/remove) take
  // their target from the URL and their actor from the JWT — an empty body
  // with Content-Type: application/json must not fail parsing. Malformed
  // JSON still fails as 400 (standard Fastify recipe).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if ((body as string) === '' || (body as string) === undefined) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // Error handler: AppError passes through as-is; Fastify-native errors map
  // to canonical registry codes; unknown errors never expose raw internals.
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const appError = toAppError(err);

    if (err instanceof AppError) {
      getLogger().error(
        { err: err.message, errorCode: err.code, internalDetails: err.internalDetails, url: req.url, method: req.method },
        'Request error',
      );
      reply.code(err.statusCode).send(err.toJSON());
      return;
    }

    // Fastify-native errors → canonical registry codes.
    if (err && typeof err === 'object' && 'statusCode' in err) {
      const statusCode = (err as { statusCode: number }).statusCode;
      const code = (err as { code?: string }).code;

      if (statusCode === 404) {
        const notFound = new AppError(ErrorCode.API_NOT_FOUND);
        reply.code(notFound.statusCode).send(notFound.toJSON());
        return;
      }

      if (statusCode === 413 || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        const tooLarge = new AppError(ErrorCode.API_REQUEST_TOO_LARGE);
        reply.code(tooLarge.statusCode).send(tooLarge.toJSON());
        return;
      }

      if (statusCode === 400 || code === 'FST_ERR_VALIDATION' || statusCode === 415) {
        const invalid = new AppError(ErrorCode.API_REQUEST_INVALID, {
          internalDetails: {
            validation: (err as { validation?: unknown }).validation,
            fastifyCode: code,
          },
        });
        reply.code(invalid.statusCode).send(invalid.toJSON());
        return;
      }

      if (statusCode === 405) {
        const notAllowed = new AppError(ErrorCode.API_METHOD_NOT_ALLOWED);
        reply.code(notAllowed.statusCode).send(notAllowed.toJSON());
        return;
      }
    }

    // Unknown error — canonical mapping (never expose raw internals).
    getLogger().error(
      {
        err: err instanceof Error ? err.message : String(err),
        errorCode: appError.code,
        internalDetails: appError.internalDetails,
        url: req.url,
        method: req.method,
      },
      'Request error',
    );

    reply.code(appError.statusCode).send(appError.toJSON());
  });

  // GET / — service banner (headless API; the SPA talks to it cross-origin).
  app.get('/', async () => {
    return {
      service: 'fusion-one-backend',
      version: '1.0.0',
      status: 'running',
    };
  });

  // GET /health/live — the Node process is alive.
  app.get('/health/live', async () => {
    return { status: 'alive', timestamp: new Date().toISOString() };
  });

  // GET /health/ready — ready to serve (not while starting/shutting down).
  app.get('/health/ready', async (_req: FastifyRequest, reply: FastifyReply) => {
    const state = deps.stateMachine.state;
    const lifecycle = getLifecycle();

    if (lifecycle.shuttingDown) {
      reply.code(503);
      return { status: 'not_ready', reason: 'shutting_down', state };
    }

    if (state === WhatsAppState.STARTING || state === WhatsAppState.STOPPING) {
      reply.code(503);
      return { status: 'not_ready', reason: 'starting', state };
    }

    return {
      status: 'ready',
      state,
      whatsappConnected: deps.whatsappManager.isConnected(),
    };
  });

  // GET /ping — token-protected wakeup probe for external cron/monitoring.
  // Deliberately outside the JWT model: never touches Supabase, Baileys, the
  // session, or the state machine. Fails closed (401) when PING_TOKEN is
  // unset or the header does not match.
  app.get('/ping', async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = cfg.pingToken;
    const provided = req.headers['x-ping-token'];

    const authorized =
      expected.length > 0 &&
      typeof provided === 'string' &&
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

    if (!authorized) {
      throw new AppError(ErrorCode.API_AUTH_REQUIRED);
    }

    reply.code(204).send();
  });

  // GET /api/status — runtime state and the session dimension as two
  // SEPARATE axes (IDLE + PRESENT = asleep but reusable; IDLE + NONE =
  // nothing paired). Reading status is not WhatsApp activity. The QR fields
  // carry the full QR lifecycle so a freshly mounted panel renders
  // immediately.
  app.get('/api/status', async (req: FastifyRequest) => {
    await requireAuthorizedUser(req);
    const state = deps.stateMachine.state;
    const lifecycle = getLifecycle();

    return {
      server: {
        state: lifecycle.shuttingDown ? 'STOPPING' : 'running',
        timestamp: new Date().toISOString(),
      },
      whatsapp: {
        state,
        session: deps.sessionManager.session,
        connected: deps.whatsappManager.isConnected(),
        jid: deps.whatsappManager.getConnectedJid(),
        qrAvailable: deps.whatsappManager.getQrCode() !== null,
        qr: deps.whatsappManager.getQrCode(),
        qrExpiresInSeconds: deps.whatsappManager.getQrExpiresInSeconds(),
        qrExpiresAt: deps.whatsappManager.getQrExpiresAt(),
      },
    };
  });

  // GET /api/events — the authenticated SSE stream. Each live stream is a
  // PRESENT frontend client (feeds the presence tracker: automatic wake on
  // the first client, shutdown grace after the last).
  app.get('/api/events', async (req: FastifyRequest, reply: FastifyReply) => {
    // Authorized app users only — unverified / unprovisioned identities must
    // not observe the shared WhatsApp runtime state.
    await requireAuthorizedUser(req);
    getSSEManager().addClient(req, reply);
    deps.clientPresence.clientConnected();
    req.raw.on('close', () => {
      deps.clientPresence.clientDisconnected();
    });
    // Keep the connection open — do not return a value
    return reply;
  });

  // POST /api/whatsapp/login — the EXPLICIT user action (Connect button):
  // the only way to start QR pairing (owner-only). Candidate resolution runs
  // first — a reusable session (local, or recovered from Redis) connects
  // WITHOUT a QR. The server NEVER auto-pairs.
  app.post('/api/whatsapp/login', async (req: FastifyRequest, reply: FastifyReply) => {
    await requireOwner(req);
    await deps.whatsappManager.startLogin();

    reply.code(200).send({
      success: true,
      state: deps.whatsappManager.state,
      session: deps.sessionManager.session,
      message: 'WhatsApp login attempt started',
    });
  });

  // POST /api/whatsapp/cancelPairing — cancels an ACTIVE pairing (stops the
  // QR runtime, discards unvalidated residue, converges to IDLE + NONE).
  // NOT logout: a validated session is preserved — the cancel-vs-scan race
  // is resolved by the lifecycle's state dispatch. Idempotent; available to
  // any authorized app user.
  app.post('/api/whatsapp/cancelPairing', async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuthorizedUser(req);
    await deps.whatsappManager.cancelPairing();

    reply.code(200).send({
      success: true,
      state: deps.whatsappManager.state,
      session: deps.sessionManager.session,
      message: 'Pairing cancelled',
    });
  });

  // POST /api/whatsapp/sendInvoice — send an invoice by reference
  // {invoiceId, invoiceType, requestId?}. The backend loads the authoritative
  // invoice from Supabase (under the VERIFIED user's JWT — identity never
  // comes from the body), renders the PDF, and sends ONE WhatsApp document
  // message. The legacy image-based contract is rejected. Any authorized app
  // user may send.
  app.post('/api/whatsapp/sendInvoice', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuthorizedUser(req);
    const input = parseSendInvoiceRequest(req.body);

    const result = await sendInvoiceById(deps.sendController, { ...input, accessToken: user.token });

    reply.code(200).send(result);
  });

  // POST /api/whatsapp/logout — destroy the session (fail closed).
  // Owner-only. Meaningful whenever session material exists; after logout
  // the runtime stays IDLE + NONE until an explicit login.
  app.post('/api/whatsapp/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    await requireOwner(req);
    const state = deps.stateMachine.state;
    const session = deps.sessionManager.session;

    if (session === 'NONE' && state !== WhatsAppState.CONNECTED) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONNECTED, {
        message: 'WhatsApp is not connected; nothing to logout',
      });
    }

    if (state === WhatsAppState.STOPPING) {
      throw new AppError(ErrorCode.SERVER_NOT_READY, {
        message: 'Server is shutting down',
      });
    }

    // Blocks new sends; in-flight sends abort via the sendsBlocked flag.
    await deps.sendController.cancelActive('logout');

    await deps.sessionManager.destroySession('user logout', 'logout');

    reply.code(200).send({
      success: true,
      state: deps.stateMachine.state,
      session: deps.sessionManager.session,
      message: 'WhatsApp session destroyed',
    });
  });

  // User management (owner-only) — list + invite.
  registerUserRoutes(app);

  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
    const notFound = new AppError(ErrorCode.API_NOT_FOUND);
    reply.code(notFound.statusCode).send(notFound.toJSON());
  });

  return app;
}
