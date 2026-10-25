import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { uuid, now } from '../db/index.js';
import type { AppCtx } from '../context.js';
import type { Role } from '../domain/permissions.js';

const SCRYPT_KEYLEN = 64;

/** SEC-01: credentials hashed with scrypt (approved password hashing). Never plaintext. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export interface SessionUser {
  id: string;
  role: Role;
  name: string;
  email: string;
  phone: string | null;
  status: string;
}

export async function createSession(ctx: AppCtx, userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ctx.config.sessionTtlMs).toISOString();
  await ctx.db
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now(), expiresAt);
  return { token, expiresAt };
}

export async function getSessionUser(ctx: AppCtx, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await ctx.db
    .prepare(
      `SELECT u.id, u.role, u.name, u.email, u.phone, u.status, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as
    | { id: string; role: Role; name: string; email: string; phone: string | null; status: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now() || row.status !== 'active') {
    await destroySession(ctx, token);
    return null;
  }
  return { id: row.id, role: row.role, name: row.name, email: row.email, phone: row.phone, status: row.status };
}

export async function destroySession(ctx: AppCtx, token: string): Promise<void> {
  await ctx.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * FR-AUTH-05 / SEC-07: configurable rate limiting with temporary lockout.
 * Uses a separate table so restarts keep the lockout (not client state).
 */
export async function loginBlocked(ctx: AppCtx, key: string): Promise<boolean> {
  const row = await ctx.db.prepare('SELECT attempts, locked_until FROM login_attempts WHERE key = ?').get(key) as
    | { attempts: number; locked_until: string | null }
    | undefined;
  if (!row) return false;
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) return true;
  return false;
}

export async function recordFailedLogin(ctx: AppCtx, key: string): Promise<{ blocked: boolean }> {
  const row = await ctx.db.prepare('SELECT attempts, locked_until FROM login_attempts WHERE key = ?').get(key) as
    | { attempts: number; locked_until: string | null }
    | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const blocked = attempts >= ctx.config.loginMaxAttempts;
  const lockedUntil = blocked ? new Date(Date.now() + ctx.config.loginLockMs).toISOString() : null;
  await ctx.db
    .prepare(
      `INSERT INTO login_attempts (key, attempts, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until`
    )
    .run(key, attempts, lockedUntil);
  return { blocked };
}

export async function clearFailedLogins(ctx: AppCtx, key: string): Promise<void> {
  await ctx.db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

/** Stable hashing for audit/lookup helpers. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
