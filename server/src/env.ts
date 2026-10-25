/**
 * Environment loading for local entry points (dev server, seed CLI, serverless bundle).
 *
 * Uses Node's built-in `process.loadEnvFile` (no dotenv dependency). Values
 * already present in `process.env` win, so shell/Vercel-provided config is
 * never overridden. Looks for `.env.local` then `.env` in the working
 * directory and its parents (the server may run from the repo root or from
 * `server/` depending on how it was started).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CANDIDATES = [
  '.env.local',
  '.env',
  '../.env.local',
  '../.env',
  '../../.env.local',
  '../../.env'
];

export function loadEnv(): void {
  const seen = new Set<string>();
  for (const rel of CANDIDATES) {
    const abs = resolve(process.cwd(), rel);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!existsSync(abs)) continue;
    try {
      process.loadEnvFile(abs);
    } catch {
      // Ignore unreadable/malformed env files — explicit process env still works.
    }
  }
}
