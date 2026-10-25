/**
 * Vercel function entrypoint. Keep this file present in source so Vercel
 * discovers the function before buildCommand runs. The backend package is
 * ESM, so load it dynamically instead of transpiling an ESM import into
 * CommonJS require(), which crashes every API invocation with ERR_REQUIRE_ESM.
 */
let appPromise: Promise<{ default: (req: any, res: any) => unknown }> | undefined;

export default async function handler(req: any, res: any): Promise<unknown> {
  appPromise ??= import('../server/src/serverless.js');
  const { default: app } = await appPromise;
  return app(req, res);
}
