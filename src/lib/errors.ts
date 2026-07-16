// Domain error carrying an HTTP status + stable machine code. The centralized
// error handler maps these to { error: { code, message } }.
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message = 'Bad request', code = 'BAD_REQUEST'): AppError =>
  new AppError(400, code, message);
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED'): AppError =>
  new AppError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN'): AppError =>
  new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND'): AppError =>
  new AppError(404, code, message);
// The request is well-formed but collides with existing state — e.g. proposing a
// change to a cadre field that already has one in flight (ADR-027). Distinct from
// 400: the client did nothing wrong, it just lost a race.
export const conflict = (message = 'Conflict', code = 'CONFLICT'): AppError =>
  new AppError(409, code, message);
