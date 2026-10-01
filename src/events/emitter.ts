/**
 * Typed event bus. Broadcasts validated event envelopes to subscribers;
 * emitting events never alters backend state (SSE is an observer channel).
 */
import { EventEmitter } from 'node:events';
import { buildEvent, type EventEnvelope, type EventTypeValue } from './registry.js';
import { getLogger } from '../logging/logger.js';

export type EventListener = (envelope: EventEnvelope) => void;

class EventBusImpl extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // allow many SSE clients
  }

  /** Emit a validated event; malformed events are dropped and logged. */
  emitEvent(type: EventTypeValue, data: unknown): void {
    let envelope: EventEnvelope;
    try {
      envelope = buildEvent(type, data);
    } catch (err) {
      getLogger().error(
        { type, err: err instanceof Error ? err.message : String(err) },
        'Invariant violation: failed to build event — event dropped',
      );
      return;
    }

    getLogger().info(
      { eventType: envelope.type, timestamp: envelope.timestamp },
      'Event emitted',
    );

    this.emit('event', envelope);
    this.emit(envelope.type, envelope);
  }

  onAll(listener: EventListener): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

let _bus: EventBusImpl | null = null;

export function getEventBus(): EventBusImpl {
  if (!_bus) {
    _bus = new EventBusImpl();
  }
  return _bus;
}

export type { EventEnvelope };
