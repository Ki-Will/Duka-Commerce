import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppCtx } from '../context.js';
import { uuid, now } from '../db/index.js';
import { errors } from '../domain/errors.js';
import {
  clearFailedLogins,
  createSession,
  destroySession,
  hashPassword,
  loginBlocked,
  recordFailedLogin,
  verifyPassword
} from '../services/auth.js';
import { audit } from '../services/audit.js';
import { requireAuth } from '../middleware.js';
import { notify } from '../services/notifications.js';
import { wrap } from '../middleware.js';


const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function authRoutes(ctx: AppCtx): Router {
  const r = Router();

  /** UC-DC-01 — registration. Registration never grants elevated roles (SEC-004). */
  r.post('/auth/register', wrap(async (req: Request, res: Response, next: NextFunction) => {
    const { name, email, phone, password } = (req.body ?? {}) as Record<string, string>;
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      throw errors.validation('Name is required.');
    }
    if (!email || !EMAIL_RE.test(email)) {
      throw errors.validation('A valid email is required.');
    }
    if (!password || password.length < 8) {
      throw errors.validation('Password must be at least 8 characters.');
    }
    const existing = await ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) {
      // AU-002: generic conflict, no account enumeration beyond existence of email.
      throw errors.conflict('ACCOUNT_EXISTS', 'An account with this email already exists.');
    }
    if (phone) {
      const dupPhone = await ctx.db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (dupPhone) throw errors.conflict('ACCOUNT_EXISTS', 'An account with this phone already exists.');
    }
    const id = uuid();
    await ctx.db
      .prepare(
        `INSERT INTO users (id, role, name, email, phone, password_hash, status, created_at)
         VALUES (?, 'customer', ?, ?, ?, ?, 'active', ?)`
      )
      .run(id, name.trim(), email.toLowerCase(), phone ?? null, hashPassword(password), now());
    const session = await createSession(ctx, id);
    await audit(ctx, { actorId: id, actorRole: 'customer', action: 'auth.register', entity: 'user', entityId: id, traceId: req.traceId });
    setSessionCookie(ctx, res, session.token);
    res.status(201).json({ user: await publicUser(ctx, id), expiresAt: session.expiresAt });
  }));

  /** UC-DC-01 — login with rate limiting and generic errors (FR-AUTH-04/05). */
  r.post('/auth/login', wrap(async (req: Request, res: Response) => {
    const { email, password } = (req.body ?? {}) as Record<string, string>;
    if (!email || !password) throw errors.validation('Email and password are required.');
    const key = `login:${email.toLowerCase()}`;
    if (await loginBlocked(ctx, key)) {
      await audit(ctx, { action: 'auth.login_blocked', entity: 'user', detail: { email: email.toLowerCase() }, traceId: req.traceId });
      throw errors.rateLimited('Too many failed attempts. Temporary lockout is active.');
    }
    const user = await ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as
      | { id: string; role: string; password_hash: string; status: string }
      | undefined;
    const ok = user && user.status === 'active' && verifyPassword(password, user.password_hash);
    if (!ok) {
      await recordFailedLogin(ctx, key);
      await audit(ctx, { actorId: user?.id ?? null, action: 'auth.login_failed', entity: 'user', entityId: user?.id ?? null, traceId: req.traceId });
      // AU-003: generic error, no account-existence leak.
      throw errors.unauthorized('Invalid email or password.');
    }
    await clearFailedLogins(ctx, key);
    const session = await createSession(ctx, user!.id);
    await audit(ctx, { actorId: user!.id, actorRole: user!.role, action: 'auth.login', entity: 'user', entityId: user!.id, traceId: req.traceId });
    setSessionCookie(ctx, res, session.token);
    res.json({ user: await publicUser(ctx, user!.id), expiresAt: session.expiresAt });
  }));

  /** AU-006 — logout invalidates the active session. */
  r.post('/auth/logout', wrap(async (req: Request, res: Response) => {
    if (req.token) await destroySession(ctx, req.token);
    res.clearCookie(ctx.config.cookieName);
    res.json({ ok: true });
  }));

  r.get('/auth/me', requireAuth, wrap(async (req: Request, res: Response) => {
    const user = req.user!;
    const merchant = await ctx.db
      .prepare('SELECT id, business_name, status FROM merchants WHERE owner_user_id = ?')
      .get(user.id);
    const staff = await ctx.db.prepare('SELECT store_id, role FROM store_staff WHERE user_id = ?').all(user.id);
    const staffStore = staff.length
      ? (await ctx.db.prepare('SELECT id, name, slug, status FROM stores WHERE id = ?').get((staff[0] as { store_id: string }).store_id) ?? null)
      : null;
    res.json({ user: { ...user, merchant, staff, staffStore } });
  }));

  return r;
}

function setSessionCookie(ctx: AppCtx, res: Response, token: string): void {
  res.cookie(ctx.config.cookieName, token, {
    httpOnly: true, // SEC-03
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    maxAge: ctx.config.sessionTtlMs,
    path: '/'
  });
}

async function publicUser(ctx: AppCtx, id: string) {
  const u = await ctx.db.prepare('SELECT id, role, name, email, phone, created_at FROM users WHERE id = ?').get(id);
  return u;
}

export { setSessionCookie, publicUser };
