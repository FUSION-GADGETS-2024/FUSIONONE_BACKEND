/**
 * Configuration: loads, validates, and freezes all application configuration
 * at startup. Invalid or missing required values cause a hard startup
 * failure; security-sensitive values never fall back to insecure defaults.
 */
import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']),
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),

  /** Supabase user-identity access model: publishable key + the requesting
   *  user's JWT (RLS enforces the data boundary) for ordinary reads/writes. */
  supabaseUrl: z.string().url(),
  supabasePublishableKey: z.string().min(1),

  /** Server-only Supabase secret key. Used EXCLUSIVELY by privileged Auth
   *  administration (owner-controlled user invitations / user listing) —
   *  never for ordinary business operations, never sent to any frontend.
   *  Empty = user management endpoints fail closed with a clear error. */
  supabaseSecretKey: z.string().default(''),

  /** Public origin of the frontend app (invitation / password-reset email
   *  links redirect here). Required by the invite endpoint; empty = fail
   *  closed with a clear error. */
  appBaseUrl: z.string().default(''),

  /** CORS: allowed browser origins (comma-separated). "*" only for dev sandboxes. */
  allowedOrigins: z.array(z.string().min(1)).min(1),

  whatsappAuthDir: z.string().min(1),

  expectedWhatsappJid: z.string().optional().default(''),

  reconnectBaseMs: z.number().int().min(100),
  reconnectMaxMs: z.number().int().min(1000),

  /** Runtime retention: when the LAST authenticated frontend client
   *  disconnects and no other runtime demand exists, the runtime keeps
   *  running for this grace period before the intentional stop (session
   *  preserved). A client returning within the grace cancels it. */
  whatsappClientDisconnectGraceMs: z.number().int().min(100),

  /** Bounded wait for a runtime wake to reach CONNECTED. */
  whatsappWakeTimeoutMs: z.number().int().min(1000),

  /** Redis backup layer (SECONDARY session persistence). Empty = disabled. */
  redisUrl: z.string().default(''),

  /** Server-side secret encrypting the Redis backup at rest. Required when
   *  REDIS_URL is set; never exposed to any frontend and never logged. */
  backupEncryptionKey: z.string().default(''),

  sendTimeoutMs: z.number().int().min(1000),
  sendMaxRetries: z.number().int().min(0).max(10),
  sendRetryBaseMs: z.number().int().min(100),

  /** Durable message scheduler: periodic due-job scan interval. */
  messagePollIntervalMs: z.number().int().min(5000),

  /** Durable message scheduler: claim lease. A claimed-but-unfinished job
   *  whose lease expired is recovered (made retryable again) by the next
   *  scan. Must exceed worst-case job execution (send timeout × retries +
   *  PDF generation). */
  messageJobLeaseMs: z.number().int().min(30000),

  maxRequestBodyBytes: z.number().int().min(1024),

  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),

  /** GET /ping probe token (X-Ping-Token header). Empty/unset = /ping fails
   *  closed (always 401). Environment-only — never shipped to any frontend. */
  pingToken: z.string().default(''),

  // ── Party documents (private Cloudflare R2 + envelope encryption) ──────
  /** R2 account id (the S3 endpoint host component). Empty = document
   *  endpoints fail closed — the same unconfigured-fail-closed convention
   *  as the message scheduler. */
  r2AccountId: z.string().default(''),
  r2AccessKeyId: z.string().default(''),
  r2SecretAccessKey: z.string().default(''),
  r2Bucket: z.string().default(''),

  /** Server-only master key (base64 of 32 bytes) wrapping every per-document
   *  data encryption key. NEVER exposed to any frontend and never logged. */
  documentsMasterKey: z.string().default(''),

  /** Maximum accepted document upload size in bytes (enforced while the
   *  multipart stream is read — never after buffering). */
  maxDocumentFileBytes: z.number().int().min(1024),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function parseEnv(): unknown {
  const num = (v: string | undefined, fallback?: number): number => {
    if (v === undefined || v === '') return fallback ?? NaN;
    const n = Number(v);
    return Number.isNaN(n) ? NaN : n;
  };

  const str = (v: string | undefined, fallback = ''): string =>
    v === undefined ? fallback : v;

  return {
    nodeEnv: str(process.env.NODE_ENV, 'development') as 'development' | 'production' | 'test',
    port: num(process.env.PORT, 3000),
    host: str(process.env.HOST, '0.0.0.0'),
    supabaseUrl: str(process.env.SUPABASE_URL),
    supabasePublishableKey: str(process.env.SUPABASE_PUBLISHABLE_KEY),
    supabaseSecretKey: str(process.env.SUPABASE_SECRET_KEY),
    appBaseUrl: str(process.env.APP_BASE_URL).replace(/\/+$/, ''),
    allowedOrigins: str(process.env.CLIENT_ORIGIN, 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    whatsappAuthDir: str(process.env.WHATSAPP_AUTH_DIR, './data/whatsapp/auth'),
    expectedWhatsappJid: str(process.env.EXPECTED_WHATSAPP_JID, ''),
    reconnectBaseMs: num(process.env.RECONNECT_BASE_MS, 1000),
    reconnectMaxMs: num(process.env.RECONNECT_MAX_MS, 60000),
    whatsappClientDisconnectGraceMs: num(process.env.WHATSAPP_CLIENT_DISCONNECT_GRACE_MS, 300_000),
    whatsappWakeTimeoutMs: num(process.env.WHATSAPP_WAKE_TIMEOUT_MS, 20_000),
    redisUrl: str(process.env.REDIS_URL, ''),
    backupEncryptionKey: str(process.env.WHATSAPP_BACKUP_ENCRYPTION_KEY, ''),
    sendTimeoutMs: num(process.env.SEND_TIMEOUT_MS, 30000),
    sendMaxRetries: num(process.env.SEND_MAX_RETRIES, 3),
    sendRetryBaseMs: num(process.env.SEND_RETRY_BASE_MS, 2000),
    messagePollIntervalMs: num(process.env.MESSAGE_POLL_INTERVAL_MS, 15000),
    messageJobLeaseMs: num(process.env.MESSAGE_JOB_LEASE_MS, 300000),
    maxRequestBodyBytes: num(process.env.MAX_REQUEST_BODY_BYTES, 10485760),
    logLevel: str(process.env.LOG_LEVEL, 'info') as AppConfig['logLevel'],
    pingToken: str(process.env.PING_TOKEN, ''),
    r2AccountId: str(process.env.R2_ACCOUNT_ID),
    r2AccessKeyId: str(process.env.R2_ACCESS_KEY_ID),
    r2SecretAccessKey: str(process.env.R2_SECRET_ACCESS_KEY),
    r2Bucket: str(process.env.R2_BUCKET, 'fusionone-documents'),
    documentsMasterKey: str(process.env.DOCUMENTS_MASTER_KEY),
    maxDocumentFileBytes: num(process.env.MAX_DOCUMENT_FILE_BYTES, 10485760),
  };
}

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  const raw = parseEnv();

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const cfg = result.data;

  if (cfg.reconnectBaseMs >= cfg.reconnectMaxMs) {
    throw new Error('RECONNECT_BASE_MS must be less than RECONNECT_MAX_MS');
  }

  // Session material must never rest in Redis as plaintext.
  if (cfg.redisUrl.length > 0 && cfg.backupEncryptionKey.length < 16) {
    throw new Error(
      'WHATSAPP_BACKUP_ENCRYPTION_KEY must be set (at least 16 characters) when REDIS_URL is configured',
    );
  }

  _config = Object.freeze({ ...cfg });
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) {
    return loadConfig();
  }
  return _config;
}
