import { loadEnv } from './env.js';
import { createContext } from './context.js';
import { createApp } from './app.js';

loadEnv();

const port = Number(process.env.PORT ?? 4000);
const ctx = createContext();
const app = createApp(ctx);

app.listen(port, '0.0.0.0', () => {
  ctx.log({ level: 'info', event: 'server.started', result: 'listening', port, driver: ctx.db.driver });
  console.log(`DukaCommerce API listening on http://0.0.0.0:${port} (db: ${ctx.db.driver})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void Promise.resolve(ctx.close()).finally(() => process.exit(0));
  });
}
