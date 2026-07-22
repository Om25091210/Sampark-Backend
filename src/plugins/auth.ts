import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { resolveCadreScope, type CadreScope } from '../lib/scope.js';

export interface AuthPrincipal {
  sub: number;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthPrincipal | null;
    /** ADR-044. Row-level scope, resolved from the DB per request — never from the token. */
    scope: CadreScope | null;
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
  app.decorateRequest('scope', null);

  app.decorate('authenticate', async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing or malformed Authorization header');
    }
    const token = header.slice('Bearer '.length).trim();
    let principal: AuthPrincipal;
    try {
      principal = await verifyAccessToken(token, app.config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    }

    // ADR-044. Scope is read from the DB on every request, NOT carried in the JWT.
    //
    // Two reasons, both about revocation. (1) If scope lived in the token, moving an
    // officer to another thana would not take effect until their 15-minute access token
    // expired - they would keep reading their old station's cadres after the transfer.
    // (2) Deactivating an account (DELETE /users/:id) revokes refresh tokens, but an
    // already-issued ACCESS token would otherwise keep working until it expired. Loading
    // the row here makes both changes effective on the very next request.
    //
    // Cost is one indexed primary-key lookup per authenticated request, against a ~17 RPS
    // peak budget. Correct revocation is worth more than that query.
    const user = await app.prisma.user.findFirst({
      where: { id: principal.sub, deletedAt: null },
      select: { id: true, role: true, thana: true, subDivision: true },
    });
    if (user === null) {
      // Deleted, deactivated, or a token for a user that no longer exists.
      throw unauthorized('Account is no longer active', 'ACCOUNT_INACTIVE');
    }

    req.authUser = { sub: user.id, role: user.role };
    req.scope = resolveCadreScope(user, (reason) =>
      // Loud on purpose: a mis-scoped account sees an empty list, which is
      // indistinguishable from "this station has no cadres" unless it is logged.
      req.log.error({ userId: user.id, role: user.role, reason }, 'account is mis-scoped - it can see nothing'),
    );
  });

  app.decorate('requireRole', function requireRole(...roles: string[]) {
    return async function roleGuard(req: FastifyRequest): Promise<void> {
      if (req.authUser === null) throw unauthorized();
      if (!roles.includes(req.authUser.role)) throw forbidden('Insufficient role');
    };
  });
});
