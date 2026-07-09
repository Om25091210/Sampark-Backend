import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// Every error leaves the API in one shape: { error: { code, message } }.
// Stack traces and internals are never sent to clients.
export default fp(async function errorHandlerPlugin(app) {
  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      request.log.warn({ issues: error.issues }, 'request validation failed');
      reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } });
      return;
    }

    if (error.validation) {
      request.log.warn({ validation: error.validation }, 'schema validation failed');
      reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } });
      return;
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    } else {
      request.log.warn({ err: { message: error.message, code: error.code } }, 'request error');
    }

    reply.status(statusCode).send({
      error: {
        code: error.code ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
        message: statusCode >= 500 ? 'Internal Server Error' : error.message,
      },
    });
  });
});
