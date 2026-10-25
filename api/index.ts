/**
 * Vercel must detect the function entrypoint from the repository before the
 * build starts. Generating api/index.js only inside buildCommand is too late
 * for route/function discovery, which caused API URLs to fall through to the
 * frontend SPA.
 */
export { default } from '../server/src/serverless.js';
