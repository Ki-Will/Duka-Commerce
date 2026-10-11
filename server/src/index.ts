import { createContext } from './context.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);
const ctx = createContext({ file: process.env.DUKA_DB_FILE ?? 'duka.sqlite' });
const app = createApp(ctx);

app.listen(port, '0.0.0.0', () => {
  ctx.log({ level: 'info', event: 'server.started', result: 'listening', port });
  console.log(`DukaCommerce API listening on http://0.0.0.0:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    ctx.close();
    process.exit(0);
  });
}
