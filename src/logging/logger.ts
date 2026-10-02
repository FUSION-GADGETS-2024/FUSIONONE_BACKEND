/**
 * Structured logging with built-in redaction. Logs never contain Baileys
 * credentials, auth keys, API secrets, QR contents, session file contents,
 * image bytes, or caption content — enough context (requestId, state, error
 * codes) to diagnose failures without exposing secrets.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getConfig } from '../config/index.js';

const REDACT_PATHS: string[] = [
  // Credentials and secrets
  'supabasePublishableKey',
  'apiKey',
  'secret',
  'password',
  'token',
  'authorization',
  'auth',
  'creds',
  'keys',
  'privateKey',
  'sessionKey',
  'me.keys',
  // QR contents (never log the actual QR data)
  'qr',
  'qrCode',
  'qrString',
  // Session/auth file contents
  'sessionData',
  'authState',
  'authStateContents',
  'state',
  'state.creds',
  'state.keys',
  // Image and caption (never log media content)
  'image',
  'image.data',
  'image.mimeType',
  'caption',
  'body.image',
  'body.caption',
  'body.recipient',
  'payload.image',
  'payload.caption',
  'payload.recipient',
  // Baileys internal auth structures
  'signalIdentities',
  'account',
  'accountDetails',
];

let _logger: Logger | null = null;

function buildLogger(): Logger {
  const cfg = getConfig();

  const opts: LoggerOptions = {
    level: cfg.logLevel,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    serializers: {
      err(err: unknown) {
        if (err instanceof Error) {
          return {
            type: err.constructor.name,
            message: err.message,
            stack: cfg.nodeEnv === 'development' ? err.stack : undefined,
          };
        }
        return { value: String(err) };
      },
    },
    base: {
      service: 'fusion-one-backend',
      pid: process.pid,
    },
  };

  if (cfg.nodeEnv === 'development') {
    return pino(opts, pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    }));
  }

  return pino(opts);
}

export function getLogger(): Logger {
  if (!_logger) {
    _logger = buildLogger();
  }
  return _logger;
}

export type { Logger };
