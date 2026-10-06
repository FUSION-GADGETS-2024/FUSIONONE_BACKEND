/**
 * Message job-result events — a tiny pub/sub bridge between the ONE
 * app-scope SSE connection (useWhatsAppPlatform) and the feature code that
 * reacts to settled message jobs (query invalidation, toasts).
 *
 * The SSE layer stays dumb (it publishes mapped envelopes); message-side
 * side effects live in features/messages/useMessageJobEvents.ts. The
 * database remains the persistent truth — these events are the optional
 * live UI notification channel.
 */
import type { MessageJobResultEvent } from './backend'

type Listener = (event: MessageJobResultEvent) => void

const listeners = new Set<Listener>()

/** Publish a settled-job event to every subscriber (never throws). */
export function publishMessageJobResult(event: MessageJobResultEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A subscriber failure must never break the SSE stream.
    }
  }
}

/** Subscribe to settled-job events; returns the unsubscribe function. */
export function subscribeMessageJobResult(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
