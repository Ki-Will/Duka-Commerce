import express, { type Request, type Response } from 'express';
import type { AppCtx } from './context.js';
import { attachSession, errorHandler, notFoundHandler, requestContext } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { publicRoutes } from './routes/public.js';
import { customerRoutes } from './routes/customer.js';
import { merchantRoutes } from './routes/merchant.js';
import { adminRoutes, supportRoutes } from './routes/admin.js';
import { processCallback } from './services/payments/processor.js';
import { AppError } from './domain/errors.js';

export function createApp(ctx: AppCtx) {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(ctx));
  app.use(attachSession(ctx));

  // Payment webhook: raw body for HMAC verification (SEC-11) — mounted before JSON parsing.
  app.post(
    '/api/v1/payments/webhooks/:provider',
    express.raw({ type: '*/*', limit: '256kb' }),
    (req: Request, res: Response) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      const signature = req.headers['x-signature'] as string | undefined;
      try {
        const outcome = processCallback(ctx, req.params.provider, raw, signature, req.traceId);
        res.json({ received: true, ...outcome });
      } catch (err) {
        if (err instanceof AppError) {
          res.status(err.status).json({ code: err.code, message: err.message, traceId: req.traceId });
          return;
        }
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Webhook processing failed.', traceId: req.traceId });
      }
    }
  );

  app.use(express.json({ limit: '256kb' }));

  // Health without secret leakage (NFR-REL-01, NF-006).
  app.get('/health', (_req: Request, res: Response) => {
    let dbOk = false;
    try {
      ctx.db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      service: ctx.config.serviceName,
      environment: ctx.config.env,
      database: dbOk ? 'up' : 'down',
      timestamp: new Date().toISOString()
    });
  });

  const api = express.Router();
  api.use(authRoutes(ctx));
  api.use(publicRoutes(ctx));
  api.use(customerRoutes(ctx));
  api.use(merchantRoutes(ctx));
  api.use(adminRoutes(ctx));
  api.use(supportRoutes(ctx));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler(ctx));
  return app;
}
