import { openDb, type Db } from './db/index.js';

export interface Config {
  env: 'test' | 'development' | 'production';
  sessionTtlMs: number;
  loginMaxAttempts: number;
  loginLockMs: number;
  deliveryFee: number;
  cookieName: string;
  cookieSecure: boolean;
  webhookSecret: string;
  serviceName: string;
}

export interface LogRecord {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  service: string;
  environment: string;
  event: string;
  result?: string;
  requestId?: string;
  actorId?: string;
  [key: string]: unknown;
}

export interface AppCtx {
  db: Db;
  config: Config;
  logs: LogRecord[];
  log(rec: Omit<LogRecord, 'timestamp' | 'service' | 'environment'>): void;
  close(): void;
}

export function createContext(options: {
  file?: string;
  env?: Config['env'];
  logs?: LogRecord[];
} = {}): AppCtx {
  const env = options.env ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  const logs = options.logs ?? [];
  const config: Config = {
    env,
    sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 24 * 60 * 60 * 1000),
    loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5),
    loginLockMs: Number(process.env.LOGIN_LOCK_MS ?? 15 * 60 * 1000),
    deliveryFee: Number(process.env.DELIVERY_FEE ?? 2000),
    cookieName: 'duka_sid',
    cookieSecure: env === 'production',
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? 'duka-sandbox-webhook-secret',
    serviceName: 'duka-api'
  };
  const db = openDb(options.file ?? process.env.DUKA_DB_FILE ?? 'duka.sqlite');
  return {
    db,
    config,
    logs,
    log(rec) {
      const record = {
        timestamp: new Date().toISOString(),
        service: config.serviceName,
        environment: env,
        ...rec
      } as LogRecord;
      logs.push(record);
      if (env !== 'test') {
        // Structured JSON logs with trace IDs (SRS §15.1, NF-009).
        console.log(JSON.stringify(record));
      }
    },
    close() {
      db.close();
    }
  };
}
