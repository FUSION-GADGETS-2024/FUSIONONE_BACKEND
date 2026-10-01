/**
 * Session Backup — the ONE Redis backup/recovery abstraction.
 *
 * Redis is a BACKUP layer for the Baileys session (auth directory), never
 * the normal fast path:
 *
 *   PRIMARY:   local persistent filesystem (Baileys useMultiFileAuthState)
 *   SECONDARY: this encrypted Redis backup, consulted ONLY when the local
 *              session is missing or unusable
 *
 * Redis is never called from routes, controllers, or the security manager.
 * The payload is encrypted with AES-256-GCM (scrypt-derived key from the
 * server-side WHATSAPP_BACKUP_ENCRYPTION_KEY secret, which is never exposed
 * to any frontend and never logged); only whitelisted Baileys auth files are
 * serialized, and the Redis URL (which contains credentials) is never logged.
 *
 * Backup writes go through a debounced scheduler so the normal operation is
 * never blocked — saves are fire-and-forget background work that always
 * converges to the latest valid session state.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { getConfig } from '../../config/index.js';
import { getLogger } from '../../logging/logger.js';

const BACKUP_KEY = 'fusionone:whatsapp:session:backup';

/** Serialized backup format version. Bump on incompatible format changes. */
const BACKUP_FORMAT_VERSION = 1;

/** Bounded Redis timeouts — the backup layer must never hang the app.
 *
 *  WHY no `socketTimeout`: node-redis maps it to net.Socket.setTimeout() —
 *  an IDLE-socket timeout that destroys the connection N ms after the last
 *  byte in either direction, regardless of pending commands. The backup
 *  layer is idle for minutes between saves, so it killed every healthy
 *  connection (the production "Socket timeout — Expecting data" error after
 *  every save). Per-COMMAND bounds are enforced by withTimeout() instead;
 *  TCP keepalive (node-redis default) keeps idle connections alive. */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;
const REDIS_COMMAND_TIMEOUT_MS = 10_000;

/** Files that may be serialized from the Baileys auth directory. Mirrors
 *  the auth-dir isolation whitelist used by the SecurityManager. */
const AUTH_FILE_WHITELIST: readonly (string | RegExp)[] = [
  'creds.json',
  /^app-state-sync-key-.+$/,
  /^app-state-sync-version-.+$/,
  /^pre-key-.+$/,
  /^sender-key-.+$/,
  /^session-.+$/,
  /^noise-key-.+$/,
  /^signal-identity-.+$/,
];

function isWhitelistedAuthFile(name: string): boolean {
  return AUTH_FILE_WHITELIST.some((pattern) =>
    typeof pattern === 'string' ? pattern === name : pattern.test(name),
  );
}

/**
 * The backup blob is DEFINITIVELY invalid: undecryptable (rotated key or
 * tampered payload), corrupt JSON, an unsupported format version, or a
 * payload that contains non-auth files. Only THIS class of failure may
 * invalidate (delete) the backup — infrastructure failures (Redis
 * unreachable, command timeout, filesystem errors) are TRANSIENT and must
 * NEVER invalidate it: a backup we cannot read right now may be perfectly
 * valid (and needed) later.
 */
export class BackupInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupInvalidError';
  }
}

interface SerializedBackup {
  version: number;
  savedAt: string;
  files: Array<{ name: string; content: string }>;
}

async function serializeAuthDirectory(authDir: string): Promise<string> {
  const files: Array<{ name: string; content: string }> = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    throw new Error('Auth directory does not exist or is not readable');
  }
  for (const name of entries.sort()) {
    if (!isWhitelistedAuthFile(name)) continue;
    const filePath = path.join(authDir, name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const content = await fs.readFile(filePath);
    files.push({ name, content: content.toString('base64') });
  }
  if (files.length === 0) {
    throw new Error('Auth directory contains no serializable auth files');
  }
  return JSON.stringify({
    version: BACKUP_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    files,
  } satisfies SerializedBackup);
}

async function writeBackupToDirectory(authDir: string, serialized: string): Promise<number> {
  let parsed: SerializedBackup;
  try {
    parsed = JSON.parse(serialized) as SerializedBackup;
  } catch {
    throw new BackupInvalidError('Backup payload is not valid JSON (corrupt)');
  }
  if (parsed.version !== BACKUP_FORMAT_VERSION) {
    throw new BackupInvalidError(`Unsupported backup format version: ${parsed.version}`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new BackupInvalidError('Backup payload contains no files');
  }
  await fs.mkdir(authDir, { recursive: true });
  let written = 0;
  for (const file of parsed.files) {
    if (!isWhitelistedAuthFile(file.name)) {
      throw new BackupInvalidError(`Backup payload contains a non-auth file: ${file.name}`);
    }
    await fs.writeFile(path.join(authDir, file.name), Buffer.from(file.content, 'base64'));
    written += 1;
  }
  return written;
}

interface EncryptedEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  // Fresh random salt per save keeps the envelope self-contained.
  return scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptPayload(plaintext: string, secret: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: EncryptedEnvelope = {
    v: 1,
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(envelope);
}

function decryptPayload(blob: string, secret: string): string {
  const envelope = JSON.parse(blob) as EncryptedEnvelope;
  if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm') {
    throw new Error('Unrecognized backup envelope');
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const key = deriveKey(secret, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ─── Redis client (lazy singleton, never fatal) ─────────────────────────────

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;
let degraded = false;
/** Backup generation — bumped by every invalidation. An in-flight save that
 *  started before an invalidation must never write afterwards (that would
 *  resurrect destroyed session material after the DEL). */
let backupGeneration = 0;

function isEnabled(): boolean {
  return getConfig().redisUrl.length > 0;
}

async function getClient(): Promise<RedisClientType> {
  if (client && client.isOpen) {
    return client;
  }
  if (connecting) {
    return connecting;
  }
  const cfg = getConfig();
  connecting = (async () => {
    const c = createClient({
      url: cfg.redisUrl,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        // NO socketTimeout (idle-socket killer — see constants above) and NO
        // background reconnect: a failed operation surfaces its error and the
        // next operation re-connects lazily through getClient().
        reconnectStrategy: false,
      },
    }) as RedisClientType;
    // Never log the URL or any connection options — only the message.
    c.on('error', (err: Error) => {
      if (!degraded) {
        degraded = true;
        getLogger().warn(
          { err: err.message },
          'Redis backup client error (backup layer degraded until next operation)',
        );
      }
    });
    await c.connect();
    client = c;
    degraded = false;
    return c;
  })();
  try {
    return await connecting;
  } catch (err) {
    getLogger().error(
      { err: err instanceof Error ? err.message : String(err) },
      'Redis backup connection failed',
    );
    throw err;
  } finally {
    connecting = null;
  }
}

/** Race a Redis operation against the command timeout (a pure race — the
 *  teardown/retry policy lives in executeCommand). */
async function withTimeout<T>(op: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis ${what} timed out after ${REDIS_COMMAND_TIMEOUT_MS}ms`)),
      REDIS_COMMAND_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether an error is a TRANSPORT-LEVEL Redis failure — the connection is
 * in an unknown/unusable state afterwards (socket read/connect timeout,
 * refused/reset/dropped connection, a command on an already-closed client).
 * Fast server-side error replies (WRONGTYPE, MOVED, ACL denials, …) are NOT
 * transport failures: the connection stays healthy and must be neither torn
 * down nor retried.
 */
function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND'
  ) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes('timed out') || // our command bound + node-redis timeouts
    msg.includes('timeout') ||
    msg.includes('socket') || // socket-level failures (unknown state)
    msg.includes('connection is closed') ||
    msg.includes('connection closed') ||
    msg.includes('disconnect')
  );
}

/**
 * Run ONE Redis command: bounded by the command timeout, with deterministic
 * recovery after a transport-level failure.
 *
 *   transport failure → the unusable client is reset (torn down) →
 *   AT MOST ONE immediate retry of the SAME operation on a fresh
 *   connection → if that also fails, a clean backup error is thrown (a
 *   degraded backup layer — NEVER a session/runtime state change).
 *
 * There is NO background reconnect worker, NO retry scheduler, NO queue —
 * recovery is exactly one bounded retry inside the failed operation, and
 * every later operation lazily establishes a fresh connection anyway.
 *
 * `mayRetry` (optional): a caller whose operation must NOT run again after
 * something happened in between (e.g. the backup was invalidated during the
 * failed save) can veto the retry.
 */
async function executeCommand<T>(
  what: string,
  run: (c: RedisClientType) => Promise<T>,
  options?: { mayRetry?: () => boolean },
): Promise<T> {
  const attempt = async (): Promise<T> => {
    try {
      const c = await getClient();
      return await withTimeout(run(c), what);
    } catch (err) {
      if (isTransportFailure(err)) {
        // The connection is in an unknown state (a command may still hang on
        // a dead socket). Reset so the retry — or any later operation —
        // starts from a fresh, usable connection.
        await teardownClient();
      }
      throw err;
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isTransportFailure(err)) throw err;
    if (options?.mayRetry && !options.mayRetry()) throw err;
    getLogger().warn(
      { what, err: err instanceof Error ? err.message : String(err) },
      'Redis transport failure — one bounded retry on a fresh connection',
    );
    return await attempt();
  }
}

/** Destroy the current client (if any) so the next operation reconnects.
 *  Used when the connection state is unknown — never as a normal-path close
 *  (graceful shutdown uses closeBackupClient/quit). */
async function teardownClient(): Promise<void> {
  const c = client;
  client = null;
  if (c) {
    try {
      c.destroy();
    } catch {
      // best-effort — the socket may already be gone
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Save the current auth directory as an encrypted backup.
 * Throws when the backup layer is disabled, the directory is empty, or
 * Redis cannot be reached within the bounded timeout.
 */
export async function saveBackup(authDir: string): Promise<void> {
  if (!isEnabled()) {
    throw new Error('Session backup is not configured (REDIS_URL unset)');
  }
  const cfg = getConfig();
  const generationAtStart = backupGeneration;
  const serialized = await serializeAuthDirectory(authDir);
  const encrypted = encryptPayload(serialized, cfg.backupEncryptionKey);
  // An invalidation that raced this save must never be resurrected by it.
  if (generationAtStart !== backupGeneration) {
    throw new Error('Backup save aborted: invalidated during save');
  }
  await executeCommand(
    'SET',
    (c) => c.set(BACKUP_KEY, encrypted),
    { mayRetry: () => generationAtStart === backupGeneration },
  );
  getLogger().info('WhatsApp session backup saved to Redis');
}

/**
 * Whether a backup blob exists in Redis. Returns false when the layer is
 * disabled or Redis is unreachable (a backup we cannot confirm does not
 * exist for restore purposes).
 */
export async function backupExists(): Promise<boolean> {
  if (!isEnabled()) return false;
  try {
    const exists = await executeCommand('EXISTS', (c) => c.exists(BACKUP_KEY));
    return exists === 1;
  } catch {
    return false;
  }
}

/**
 * Restore the backup into the given auth directory; returns the number of
 * files written. BackupInvalidError is DEFINITIVE (missing blob, decrypt
 * failure, format/corruption) and the caller may invalidate the backup.
 * Plain Errors are TRANSIENT (Redis/timeout/filesystem) and the caller must
 * NOT invalidate the backup.
 */
export async function restoreBackup(authDir: string): Promise<number> {
  if (!isEnabled()) {
    throw new Error('Session backup is not configured (REDIS_URL unset)');
  }
  const cfg = getConfig();
  const blob = await executeCommand('GET', (c) => c.get(BACKUP_KEY));
  if (typeof blob !== 'string' || blob.length === 0) {
    // The key vanished between the existence check and this GET (e.g. a
    // concurrent invalidation) — there is no candidate.
    throw new BackupInvalidError('No session backup present in Redis');
  }
  let serialized: string;
  try {
    serialized = decryptPayload(blob, cfg.backupEncryptionKey);
  } catch {
    throw new BackupInvalidError('Session backup failed decryption (invalid or key-rotated)');
  }
  const written = await writeBackupToDirectory(authDir, serialized);
  getLogger().info({ files: written }, 'WhatsApp session backup restored locally from Redis');
  return written;
}

/**
 * Invalidate (delete) the backup — used by logout, security invalidation,
 * and stale-backup classification. Throws when Redis cannot confirm the
 * deletion (callers fail closed on this).
 */
export async function invalidateBackup(): Promise<void> {
  if (!isEnabled()) {
    return; // nothing to invalidate
  }
  // DEL is idempotent — one bounded retry after a transport failure is safe.
  // An unconfirmed deletion still throws, preserving the fail-closed
  // destructive-cleanup contract.
  await executeCommand('DEL', (c) => c.del(BACKUP_KEY));
  backupGeneration++;
  getLogger().info('WhatsApp session backup invalidated in Redis');
}

/** Close the Redis connection during graceful shutdown (best-effort). */
export async function closeBackupClient(): Promise<void> {
  const c = client;
  client = null;
  if (c?.isOpen) {
    try {
      await c.quit();
    } catch {
      // best-effort
    }
  }
}

/**
 * Prewarm the Redis connection at startup (fire-and-forget, never fatal) so
 * the moments the backup layer is consulted (restore-check on login, the
 * fail-closed invalidation during logout) do not pay a cold connect.
 */
export async function prewarmBackupClient(): Promise<void> {
  if (!isEnabled()) return;
  try {
    await getClient();
    getLogger().info('Redis backup client prewarmed');
  } catch {
    // never fatal — the next operation retries lazily
  }
}

// ─── Debounced backup scheduler ─────────────────────────────────────────────

/**
 * Coalesces frequent credential updates into bounded background saves:
 *   - a save runs DEBOUNCE_MS after the last request
 *   - a save never waits more than MAX_WAIT_MS after the first pending one
 *   - failures are logged and retried on the next request (never fatal)
 */
export class SessionBackupScheduler {
  private readonly authDir: string;
  private readonly debounceMs = 2_000;
  private readonly maxWaitMs = 10_000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private inFlight = false;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  /** Schedule a (coalesced) backup save. Fire-and-forget — never throws. */
  schedule(): void {
    if (!isEnabled()) return;
    if (this.firstPendingAt === 0) {
      this.firstPendingAt = Date.now();
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    const waited = Date.now() - this.firstPendingAt;
    const delay = waited >= this.maxWaitMs ? 0 : Math.min(this.debounceMs, this.maxWaitMs - waited);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Run a pending save immediately (bounded). Used at shutdown/idle. */
  async flush(timeoutMs = 5_000): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight || !isEnabled() || this.firstPendingAt === 0) {
      return;
    }
    await Promise.race([
      this.runSave(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Cancel any pending save WITHOUT saving — used when the session is being
   *  destroyed (a stale save must never resurrect destroyed material). */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstPendingAt = 0;
  }

  private async runSave(): Promise<void> {
    this.inFlight = true;
    this.firstPendingAt = 0;
    try {
      await saveBackup(this.authDir);
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'WhatsApp session backup save failed (will retry on next credential update)',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
