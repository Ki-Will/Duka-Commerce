/**
 * Vercel serverless entry — wraps the Express app.
 *
 * Vercel's Node.js runtime supports `node:sqlite`, so the whole Express app
 * (routes, webhooks, state machines) runs unchanged. The SQLite file lives in
 * /tmp (the only writable path on serverless); demo data is seeded on cold
 * start if the database is empty. Note: /tmp is per-instance, so data resets
 * when a cold instance spins up — fine for a demo/UAT environment.
 */
import { createContext } from './context.js';
import { createApp } from './app.js';
import { seedIfEmpty } from './seedData.js';

const ctx = createContext({ file: process.env.DUKA_DB_FILE ?? '/tmp/duka.sqlite' });
seedIfEmpty(ctx);

// Express app is itself a (req, res) request handler — valid Vercel function.
export default createApp(ctx);
