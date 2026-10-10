/**
 * SSE Manager — Server-Sent Events connections for the event stream.
 * The backend remains authoritative: SSE is an observer channel and client
 * disconnects never alter backend state.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getEventBus, type EventEnvelope } from '../events/emitter.js';
import { serializeForSSE } from '../events/registry.js';
import { getLogger } from '../logging/logger.js';

interface SSEClient {
  id: number;
  reply: FastifyReply;
  alive: boolean;
}

class SSEManagerImpl {
  private clients: Map<number, SSEClient> = new Map();
  private nextId = 1;

  constructor() {
    getEventBus().onAll((envelope) => {
      this.broadcast(envelope);
    });
  }

  addClient(req: FastifyRequest, reply: FastifyReply): SSEClient {
    const id = this.nextId++;

    // reply.raw.writeHead() bypasses Fastify's reply system — merge the
    // CORS headers @fastify/cors already set, or EventSource connections
    // from the browser would be blocked by same-origin policy.
    const fastifyHeaders = reply.getHeaders() as Record<string, string | number | string[] | undefined>;
    reply.raw.writeHead(200, {
      ...fastifyHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering
    });

    reply.raw.write(': connected\n\n');

    const client: SSEClient = { id, reply, alive: true };
    this.clients.set(id, client);

    getLogger().info(
      { clientId: id, totalClients: this.clients.size },
      'SSE client connected',
    );

    req.raw.on('close', () => {
      this.removeClient(id);
    });

    const pingInterval = setInterval(() => {
      if (client.alive) {
        try {
          reply.raw.write(': ping\n\n');
        } catch {
          clearInterval(pingInterval);
          this.removeClient(id);
        }
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    return client;
  }

  removeClient(id: number): void {
    const client = this.clients.get(id);
    if (client) {
      client.alive = false;
      this.clients.delete(id);
      getLogger().info(
        { clientId: id, totalClients: this.clients.size },
        'SSE client disconnected',
      );
    }
  }

  private broadcast(envelope: EventEnvelope): void {
    const data = serializeForSSE(envelope);

    for (const [id, client] of this.clients) {
      if (client.alive) {
        try {
          client.reply.raw.write(data);
        } catch {
          this.removeClient(id);
        }
      }
    }
  }

  /** Close all SSE connections (graceful shutdown). */
  closeAll(): void {
    for (const [id, client] of this.clients) {
      client.alive = false;
      try {
        client.reply.raw.end();
      } catch {
        // ignore
      }
      this.clients.delete(id);
    }
    getLogger().info('All SSE connections closed');
  }
}

let _instance: SSEManagerImpl | null = null;

export function getSSEManager(): SSEManagerImpl {
  if (!_instance) {
    _instance = new SSEManagerImpl();
  }
  return _instance;
}
