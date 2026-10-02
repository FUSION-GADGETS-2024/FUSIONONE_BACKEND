/**
 * User management endpoints — OWNER ONLY (see user-management.ts for the
 * service invariants). Handlers stay thin: authorize first (JWT → verified →
 * ACTIVE account → owner), then run the trusted service with the
 * server-only admin client.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireOwner } from './authorize.js';
import {
  listManagedUsers,
  inviteUser,
  resendInvitation,
  changeUserRole,
  blockUser,
  unblockUser,
  sendPasswordReset,
  removeUser,
} from './user-management.js';

function targetIdFrom(req: FastifyRequest): unknown {
  const params = (req.params ?? {}) as { id?: unknown };
  return params.id;
}

async function listUsersHandler(req: FastifyRequest, reply: FastifyReply) {
  const owner = await requireOwner(req);
  const users = await listManagedUsers(owner.id);
  reply.code(200).send({ users });
}

async function inviteUserHandler(req: FastifyRequest, reply: FastifyReply) {
  await requireOwner(req);
  const body = (req.body ?? {}) as { email?: unknown };
  const { email } = await inviteUser(body.email);
  reply.code(200).send({ invited: true, email });
}

async function changeRoleHandler(req: FastifyRequest, reply: FastifyReply) {
  const owner = await requireOwner(req);
  const body = (req.body ?? {}) as { role?: unknown };
  const { role } = await changeUserRole(owner.id, String(targetIdFrom(req) ?? ''), body.role);
  reply.code(200).send({ changed: true, role });
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
  app.post('/api/users/:id/role', changeRoleHandler);
  app.post('/api/users/:id/resend-invite', resendInviteHandler);
  app.post('/api/users/:id/block', blockUserHandler);
  app.post('/api/users/:id/unblock', unblockUserHandler);
  app.post('/api/users/:id/reset-password', resetPasswordHandler);
  app.delete('/api/users/:id', removeUserHandler);
}
