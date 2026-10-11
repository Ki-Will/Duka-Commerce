/**
 * Consistent API error structure (SRS §16.2): { code, message, traceId }.
 * Never exposes stack traces or SQL to clients (SRS §16.1).
 */
export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public status: number = 400,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  validation: (message: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', message, 400, details),
  unauthorized: (message = 'Authentication required.') =>
    new AppError('UNAUTHENTICATED', message, 401),
  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError('FORBIDDEN', message, 403),
  notFound: (message = 'Resource not found.') =>
    new AppError('NOT_FOUND', message, 404),
  conflict: (code: string, message: string) => new AppError(code, message, 409),
  badRequest: (code: string, message: string) => new AppError(code, message, 400),
  rateLimited: (message = 'Too many attempts. Please try again later.') =>
    new AppError('RATE_LIMITED', message, 429),
  internal: (message = 'An unexpected error occurred.') =>
    new AppError('INTERNAL_ERROR', message, 500)
};
