import { openDb, openPostgres, type Db, type DbDriver } from './db/index.js';

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
  close(): void | Promise<void>;
}

/**
 * Pick the backend: explicit call-site option wins, then `DUKA_DB_DRIVER`,
 * then auto — Neon Postgres when `DATABASE_URL` is present (dev/production),
 * SQLite otherwise (hermetic tests, offline fallback).
 */
function openDatabase(options: { file?: string; driver?: DbDriver }): Db {
  if (options.driver === 'postgres') return openNeon();
  if (options.driver === 'sqlite') return openDb(options.file ?? process.env.DUKA_DB_FILE ?? 'duka.sqlite');
  if (options.file) return openDb(options.file);
  if (process.env.DUKA_DB_DRIVER === 'postgres') return openNeon();
  if (process.env.DUKA_DB_DRIVER === 'sqlite') return openDb(process.env.DUKA_DB_FILE ?? 'duka.sqlite');
  if (process.env.DATABASE_URL && !process.env.DUKA_DB_FILE) return openNeon();
  return openDb(process.env.DUKA_DB_FILE ?? 'duka.sqlite');
}

function openNeon(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Postgres driver requested but DATABASE_URL is not set.');
  // Schema DDL goes over the direct (unpooled) endpoint when available.
  return openPostgres({ url, migrateUrl: process.env.DATABASE_URL_UNPOOLED });
}

export function createContext(options: {
  file?: string;
  driver?: DbDriver;
  /** Reuse an already-open database (tests share one pool per worker). */
  db?: Db;
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
  const db = options.db ?? openDatabase(options);
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
      return db.close();
    }
  };
}
