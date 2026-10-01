/**
 * Closed event registry — the complete set of public event types and their
 * payload schemas. No other event type may exist; the frontend never
 * receives raw internal events.
 */
import { z } from 'zod';
import { WhatsAppState } from '../state/whatsapp-states.js';
import { isValidErrorCode } from '../errors/registry.js';

export const EventType = {
  SERVER_STATE_CHANGED: 'SERVER_STATE_CHANGED',
  WHATSAPP_STATE_CHANGED: 'WHATSAPP_STATE_CHANGED',
  WHATSAPP_QR_AVAILABLE: 'WHATSAPP_QR_AVAILABLE',
  WHATSAPP_QR_COUNTDOWN: 'WHATSAPP_QR_COUNTDOWN',
  SEND_INVOICE_RESULT: 'SEND_INVOICE_RESULT',
  SECURITY_EVENT: 'SECURITY_EVENT',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

const ALL_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(EventType));

export function isValidEventType(type: string): type is EventTypeValue {
  return ALL_EVENT_TYPES.has(type);
}

/** `state`/`prevState` are RUNTIME states; `session` (optional) carries the
 *  SESSION dimension so the frontend can distinguish "IDLE with a reusable
 *  session" from "IDLE with nothing". */
const WhatsAppStateDataSchema = z.object({
  state: z.enum(Object.values(WhatsAppState) as [string, ...string[]]),
  prevState: z.enum(Object.values(WhatsAppState) as [string, ...string[]]),
  session: z.enum(['NONE', 'PRESENT', 'RESTORING']).optional(),
});

/** Per-event-type payload schemas. */
const DATA_SCHEMAS: Readonly<Record<EventTypeValue, z.ZodTypeAny>> = {
  SERVER_STATE_CHANGED: z.object({
    state: z.string(),
    prevState: z.string(),
  }),
  WHATSAPP_STATE_CHANGED: WhatsAppStateDataSchema,
  WHATSAPP_QR_AVAILABLE: z.object({
    qr: z.string().min(1),
    expiresInSeconds: z.number().int().min(1),
    expiresAt: z.string(),
  }),
  WHATSAPP_QR_COUNTDOWN: z.object({
    remainingSeconds: z.number().int().min(0),
    expiresAt: z.string(),
  }),
  SEND_INVOICE_RESULT: z.object({
    requestId: z.string().min(1),
    recipient: z.string().min(1),
    result: z.enum(['success', 'failed']),
    errorCode: z.string().optional(),
  }),
  SECURITY_EVENT: z.object({
    code: z.string().refine((c) => isValidErrorCode(c), 'Must be a registered error code'),
    reason: z.string(),
  }),
};

export const EventEnvelopeSchema = z.object({
  type: z.enum(Object.values(EventType) as [string, ...string[]]),
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Validate and construct an event envelope; throws on invalid input so no
 *  malformed event can reach the frontend. */
export function buildEvent(
  type: EventTypeValue,
  data: unknown,
): EventEnvelope {
  if (!isValidEventType(type)) {
    throw new Error(`Invariant violation: unknown event type '${type}'`);
  }
  const validatedData = DATA_SCHEMAS[type].parse(data) as Record<string, unknown>;
  return {
    type,
    timestamp: new Date().toISOString(),
    data: validatedData,
  };
}

/** Serialize an event envelope to an SSE frame. */
export function serializeForSSE(envelope: EventEnvelope): string {
  return `data: ${JSON.stringify(envelope)}\n\n`;
}
