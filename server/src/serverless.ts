/**
 * Vercel serverless entry — wraps the Express app.
 *
 * Database: Neon Postgres via `DATABASE_URL` (pooled endpoint) with the
 * schema applied on cold start over `DATABASE_URL_UNPOOLED` (direct), per
 * Neon's connection guidance. Demo data is seeded through `db.init(...)`,
 * which gates every query until seeding finishes, so the first request never
 * races the seed. If `DATABASE_URL` is absent the app falls back to SQLite
 * in /tmp (per-instance — data would reset on cold start).
 */
import { loadEnv } from './env.js';
import { createContext } from './context.js';
import { createApp } from './app.js';
import { seedIfEmpty } from './seedData.js';

loadEnv();

const ctx = createContext();

// Idempotent seed, chained before the first query. Two cold starts may both
// attempt it; unique constraints make the loser a harmless no-op.
ctx.db.init(async () => {
  try {
    const seeded = await seedIfEmpty(ctx);
    if (seeded) ctx.log({ level: 'info', event: 'db.seeded', result: 'ok' });
  } catch (err) {
    ctx.log({ level: 'warn', event: 'db.seed.skipped', error: err instanceof Error ? err.message : String(err) });
  }
});

// Express app is itself a (req, res) request handler — valid Vercel function.
export default createApp(ctx);
