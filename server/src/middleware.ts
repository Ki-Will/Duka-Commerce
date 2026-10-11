import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AppCtx } from './context.js';
import { AppError, errors } from './domain/errors.js';
import { getSessionUser, type SessionUser } from './services/auth.js';
import type { Role } from './domain/permissions.js';

declare global {
  namespace Express {
    interface Request {
      traceId: string;
      ctx: AppCtx;
      user?: SessionUser;
      token?: string;
      rawBody?: string;
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Request context + structured access log with trace id (SRS §15.1, NF-009). */
export function requestContext(ctx: AppCtx) {
  return (req: Request, res: Response, next: NextFunction) => {
    req.ctx = ctx;
    req.traceId = (req.headers['x-request-id'] as string | undefined) || randomUUID();
    res.setHeader('x-request-id', req.traceId);
    const started = Date.now();
    res.on('finish', () => {
      ctx.log({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        event: 'http.request',
        result: String(res.statusCode),
        requestId: req.traceId,
        actorId: req.user?.id,
        method: req.method,
        path: req.path,
        durationMs: Date.now() - started
      });
    });
    next();
  };
}

export function attachSession(ctx: AppCtx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[ctx.config.cookieName];
    req.token = token;
    const user = getSessionUser(ctx, token);
    if (user) req.user = user;
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(errors.unauthorized());
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(errors.unauthorized());
    if (!roles.includes(req.user.role)) return next(errors.forbidden());
    next();
  };
}

/** Central error handler: consistent structure, no stack traces to clients (§16). */
export function errorHandler(ctx: AppCtx) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.status >= 500) {
        ctx.log({ level: 'error', event: 'request.error', result: err.code, requestId: req.traceId });
      }
      res.status(err.status).json({
        code: err.code,
        message: err.message,
        traceId: req.traceId,
        ...(err.details ? { details: err.details } : {})
      });
      return;
    }
    ctx.log({
      level: 'error',
      event: 'request.error',
      result: 'INTERNAL_ERROR',
      requestId: req.traceId,
      error: err instanceof Error ? err.message : String(err)
    });
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      traceId: req.traceId
    });
  };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found.`, traceId: req.traceId });
}
