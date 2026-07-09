import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthPrincipal {
  sub: number;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthPrincipal | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// JWT authentication + RBAC. `app.authenticate` verifies the Bearer access token
// and populates `req.authUser`; `app.requireRole(...)` gates by role. Both are
// used as route preHandlers. Requires `app.config` to be decorated first.
export default fp(async function authPlugin(app) {
  app.decorateRequest('authUser', null);

  app.decorate('authenticate', async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing or malformed Authorization header');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      req.authUser = await verifyAccessToken(token, app.config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    }
  });

  app.decorate('requireRole', function requireRole(...roles: string[]) {
    return async function roleGuard(req: FastifyRequest): Promise<void> {
      if (req.authUser === null) throw unauthorized();
      if (!roles.includes(req.authUser.role)) throw forbidden('Insufficient role');
    };
  });
});
