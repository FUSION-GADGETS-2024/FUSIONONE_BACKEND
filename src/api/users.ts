/**
 * User management endpoints — OWNER ONLY.
 *
 *   GET    /api/users                    — list managed users
 *   POST   /api/users/invite             — invite a new user by email
 *   POST   /api/users/:id/resend-invite  — resend a pending invitation
 *   POST   /api/users/:id/block          — block a user (status = 'blocked')
 *   POST   /api/users/:id/unblock        — unblock a user (status = 'active')
 *   POST   /api/users/:id/reset-password — send the native recovery email
 *   DELETE /api/users/:id                — permanently remove the account
 *
 * Handlers stay thin: every request is authorized first (JWT → verified →
 * ACTIVE account → owner), then the trusted user-management service runs
 * with the server-only Supabase admin client. The owner is never a managed
 * user (no self-blocking, no self-removal, no role management); shared
 * business data is never tied to user lifecycle.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireOwner } from './authorize.js';
import {
  listManagedUsers,
  inviteUser,
  resendInvitation,
  blockUser,
  unblockUser,
  sendPasswordReset,
  removeUser,
} from './user-management.js';

function targetIdFrom(req: FastifyRequest): unknown {
  const params = (req.params ?? {}) as { id?: unknown };
  return params.id;
}

async function listUsersHandler(_req: FastifyRequest, reply: FastifyReply) {
  await requireOwner(_req);
  const users = await listManagedUsers();
  reply.code(200).send({ users });
}

async function inviteUserHandler(req: FastifyRequest, reply: FastifyReply) {
  await requireOwner(req);
  const body = (req.body ?? {}) as { email?: unknown };
  const { email } = await inviteUser(body.email);
  reply.code(200).send({ invited: true, email });
}

async function resendInviteHandler(req: FastifyRequest, reply: FastifyReply) {
  await requireOwner(req);
  const { email } = await resendInvitation(String(targetIdFrom(req) ?? ''));
  reply.code(200).send({ resent: true, email });
}

async function blockUserHandler(req: FastifyRequest, reply: FastifyReply) {
  const owner = await requireOwner(req);
  await blockUser(owner.id, String(targetIdFrom(req) ?? ''));
  reply.code(200).send({ blocked: true });
}

async function unblockUserHandler(req: FastifyRequest, reply: FastifyReply) {
  const owner = await requireOwner(req);
  await unblockUser(owner.id, String(targetIdFrom(req) ?? ''));
  reply.code(200).send({ unblocked: true });
}

async function resetPasswordHandler(req: FastifyRequest, reply: FastifyReply) {
  await requireOwner(req);
  const { email } = await sendPasswordReset(String(targetIdFrom(req) ?? ''));
  reply.code(200).send({ sent: true, email });
}

async function removeUserHandler(req: FastifyRequest, reply: FastifyReply) {
  const owner = await requireOwner(req);
  await removeUser(owner.id, String(targetIdFrom(req) ?? ''));
  reply.code(200).send({ removed: true });
}

export function registerUserRoutes(app: FastifyInstance): void {
  app.get('/api/users', listUsersHandler);
  app.post('/api/users/invite', inviteUserHandler);
  app.post('/api/users/:id/resend-invite', resendInviteHandler);
  app.post('/api/users/:id/block', blockUserHandler);
  app.post('/api/users/:id/unblock', unblockUserHandler);
  app.post('/api/users/:id/reset-password', resetPasswordHandler);
  app.delete('/api/users/:id', removeUserHandler);
}
