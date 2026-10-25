import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';
import { Pool, Client, types, type PoolClient, type QueryResult } from 'pg';
import { SCHEMA } from './schema.js';

/**
 * Async database layer.
 *
 * The interface (`prepare(...).get/all/run`) mirrors the old synchronous
 * node:sqlite surface so routes/services read the same, but every call is a
 * Promise because the production backend is Postgres (Neon):
 *
 *   - `postgres` — pooled `pg` connections against `DATABASE_URL` (the Neon
 *     pooled endpoint). Schema is applied idempotently on first use over
 *     `DATABASE_URL_UNPOOLED` (direct), per Neon's guidance that DDL must not
 *     go through PgBouncer.
 *   - `sqlite`  — node:sqlite, used by the unit-test suite and as an offline
 *     fallback (`DUKA_DB_DRIVER=sqlite`). Queries are executed through a
 *     serial queue so concurrent request handlers cannot interleave inside an
 *     open transaction — preserving the semantics the app had when every
 *     query was synchronous.
 *
 * Transactions: `tx(db, fn)` pins the whole callback to one connection
 * (Postgres: a checked-out client; SQLite: the serial queue) and supports
 * nesting via SAVEPOINTs, matching SRS §11.4.
 */

export type SqlParam = string | number | bigint | Uint8Array | boolean | null | undefined;

export interface RunResult {
  changes: number;
}

export interface Statement<T = any> {
  get(...params: SqlParam[]): Promise<T | undefined>;
  all(...params: SqlParam[]): Promise<T[]>;
  run(...params: SqlParam[]): Promise<RunResult>;
}

export type DbDriver = 'sqlite' | 'postgres';

export interface Db {
  readonly driver: DbDriver;
  prepare<T = any>(sql: string): Statement<T>;
  exec(sql: string): Promise<void>;
  /**
   * Chain work (seeding, test resets) that must finish before any query runs.
   * Queries issued from inside the callback run immediately (they already
   * waited their turn in the chain); queries from anywhere else wait.
   */
  init(fn: () => Promise<void>): void;
  close(): void | Promise<void>;
}

export function uuid(): string {
  return randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

/** Serialize a JS value for a TEXT column. */
export function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Parse a TEXT column back to a value. */
export function jp<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------------- */
/* Execution scope: binds in-flight transactions/init callbacks to a Db       */
/* ------------------------------------------------------------------------- */

interface Scope {
  db: object;
  /** 0 = init callback, >= 1 = transaction depth (for SAVEPOINT naming). */
  depth: number;
  /** Postgres client pinned for the current transaction, if any. */
  client: PoolClient | null;
}

const scopeStore = new AsyncLocalStorage<Scope>();

function ownScope(db: object): Scope | undefined {
  const s = scopeStore.getStore();
  return s && s.db === db ? s : undefined;
}

/* ------------------------------------------------------------------------- */
/* Postgres driver (Neon)                                                     */
/* ------------------------------------------------------------------------- */

/** COUNT/SUM come back as int8/numeric (strings by default) — match SQLite. */
types.setTypeParser(20, (v: string) => Number(v));
types.setTypeParser(1700, (v: string) => Number(v));

// Deterministic address selection: Node's dual-stack "Happy Eyeballs" racing
// (autoSelectFamily) stalls until ETIMEDOUT on networks that route IPv4 only,
// which times out Neon connections. Prefer IPv4 when both families resolve
// (reordering never drops the only available family) and attempt addresses
// one by one instead of racing them. Runs whenever the db layer loads, so
// every entry point (server, serverless, tests) inherits it.
setDefaultAutoSelectFamily(false);
setDefaultResultOrder('ipv4first');

/**
 * Translate SQLite-style `?` placeholders to Postgres `$1..$n`, skipping
 * string literals and comments, and map SQLite's case-insensitive `LIKE`
 * onto Postgres `ILIKE` so search behaviour is identical on both backends.
 */
export function rewritePlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let param = 0;
  let quote: string | null = null; // current string-literal quote char
  let lineComment = false;
  let blockComment = false;
  let dollarTag = '';

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      out += c;
      if (c === '\n') lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      if (c === '*' && next === '/') {
        out += '*/';
        blockComment = false;
        i += 2;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        out += dollarTag;
        i += dollarTag.length;
        dollarTag = '';
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === quote) {
        if (next === quote) {
          // Escaped quote ('' / "") stays inside the literal.
          out += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (c === '-' && next === '-') {
      lineComment = true;
      out += '--';
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      blockComment = true;
      out += '/*';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        out += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (c === '?') {
      param += 1;
      out += `$${param}`;
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let end = i;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end += 1;
      const word = sql.slice(i, end);
      out += word === 'LIKE' || word === 'like' ? 'ILIKE' : word;
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Normalise parameters so both drivers accept them identically. */
function bindable(params: SqlParam[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Uint8Array && !Buffer.isBuffer(p)) return Buffer.from(p);
    return p;
  });
}

class PgDb implements Db {
  readonly driver = 'postgres' as const;
  private gate: Promise<void>;
  private cache = new Map<string, string>();

  constructor(private pool: Pool, private migrateUrl?: string) {
    this.gate = this.applySchema();
  }

  private async applySchema(): Promise<void> {
    // Fast path: if the schema is already there, skip the direct-connection
    // DDL round entirely (saves a full TLS handshake per cold start / test).
    try {
      const probe = await this.pool.query('SELECT to_regclass($1) AS t', ['public.users']);
      if (probe.rows[0]?.t) return;
    } catch {
      // Probe failed — fall through to the authoritative apply below.
    }
    // DDL over the direct (unpooled) connection when we have one — PgBouncer's
    // transaction pooling is not meant for migrations (Neon gotcha).
    if (this.migrateUrl) {
      const client = new Client({ connectionString: this.migrateUrl, connectionTimeoutMillis: 15000 });
      await client.connect();
      try {
        await client.query(SCHEMA);
      } finally {
        await client.end();
      }
      return;
    }
    await this.pool.query(SCHEMA);
  }

  private text(sql: string): string {
    let t = this.cache.get(sql);
    if (t === undefined) {
      t = rewritePlaceholders(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, t);
    }
    return t;
  }

  prepare<T = any>(sql: string): Statement<T> {
    const text = this.text(sql);
    const exec = async (params: SqlParam[]): Promise<QueryResult> => {
      const scope = ownScope(this);
      if (!scope) await this.gate;
      const target: { query(t: string, v?: unknown[]): Promise<QueryResult> } = scope?.client ?? this.pool;
      return target.query(text, bindable(params));
    };
    return {
      get: async (...params) => (await exec(params)).rows[0],
      all: async (...params) => (await exec(params)).rows,
      run: async (...params) => {
        const res = await exec(params);
        return { changes: res.rowCount ?? 0 };
      }
    };
  }

  async exec(sql: string): Promise<void> {
    const scope = ownScope(this);
    if (!scope) await this.gate;
    const target: { query(t: string): Promise<QueryResult> } = scope?.client ?? this.pool;
    await target.query(sql);
  }

  init(fn: () => Promise<void>): void {
    this.gate = this.gate.then(() => scopeStore.run({ db: this, depth: 0, client: null }, fn));
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const scope = ownScope(this);
    if (scope && scope.client) {
      // Nested transaction → SAVEPOINT on the pinned client.
      const depth = (scope.depth += 1);
      const sp = `duka_sp_${depth}`;
      await scope.client.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn();
        await scope.client.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          await scope.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await scope.client.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          /* outer transaction will roll back */
        }
        throw err;
      } finally {
        scope.depth -= 1;
      }
    }
    if (!scope) await this.gate;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await scopeStore.run({ db: this, depth: 1, client }, async () => {
          const out = await fn();
          await client.query('COMMIT');
          return out;
        });
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

/* ------------------------------------------------------------------------- */
/* SQLite driver (tests / offline fallback)                                   */
/* ------------------------------------------------------------------------- */

class SqliteDb implements Db {
  readonly driver = 'sqlite' as const;
  private gate: Promise<void> = Promise.resolve();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private raw: DatabaseSync) {}

  /** Run fn with exclusive use of the connection (serial queue). */
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    if (ownScope(this)) return Promise.resolve(fn());
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  prepare<T = any>(sql: string): Statement<T> {
    const stmt = this.raw.prepare(sql);
    const gate = async (): Promise<void> => {
      if (!ownScope(this)) await this.gate;
    };
    return {
      get: async (...params) => {
        await gate();
        return (await this.enqueue(() => stmt.get(...(params as never[])))) as any;
      },
      all: async (...params) => {
        await gate();
        return (await this.enqueue(() => stmt.all(...(params as never[])))) as any;
      },
      run: async (...params) => {
        await gate();
        const res = await this.enqueue(() => stmt.run(...(params as never[])));
        return { changes: Number(res.changes) };
      }
    };
  }

  async exec(sql: string): Promise<void> {
    if (!ownScope(this)) await this.gate;
    await this.enqueue(() => {
      this.raw.exec(sql);
    });
  }

  init(fn: () => Promise<void>): void {
    this.gate = this.gate.then(() => scopeStore.run({ db: this, depth: 0, client: null }, fn));
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const scope = ownScope(this);
    if (scope && scope.depth > 0) {
      const depth = (scope.depth += 1);
      const sp = `duka_sp_${depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      try {
        const result = await fn();
        this.raw.exec(`RELEASE ${sp}`);
        return result;
      } catch (err) {
        try {
          this.raw.exec(`ROLLBACK TO ${sp}`);
          this.raw.exec(`RELEASE ${sp}`);
        } catch {
          /* outer transaction will roll back */
        }
        throw err;
      } finally {
        scope.depth -= 1;
      }
    }
    if (!scope) await this.gate;
    return this.enqueue(() =>
      scopeStore.run({ db: this, depth: 1, client: null }, async () => {
        this.raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn();
          this.raw.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            this.raw.exec('ROLLBACK');
          } catch {
            /* already rolled back */
          }
          throw err;
        }
      })
    );
  }

  close(): void {
    this.raw.close();
  }
}

/* ------------------------------------------------------------------------- */
/* Openers                                                                    */
/* ------------------------------------------------------------------------- */

/** Open a SQLite database (unit tests, offline fallback, `DUKA_DB_FILE`). */
export function openDb(file: string = ':memory:'): Db {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(SCHEMA);
  return new SqliteDb(raw);
}

/** Open Neon Postgres: pooled app traffic, direct connection for schema DDL. */
export function openPostgres(options: { url: string; migrateUrl?: string }): Db {
  const pool = new Pool({
    connectionString: options.url,
    // Serverless default is conservative; test/load runs can raise it.
    max: Number(process.env.DUKA_DB_POOL_MAX ?? 10),
    connectionTimeoutMillis: 15000,
    // Neon suspends idle computes (scale-to-zero): fail loudly instead of hanging.
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false
  });
  pool.on('error', (err) => {
    // A broken idle client must not take the process down (pg default would).
    console.error(JSON.stringify({ level: 'error', service: 'duka-api', event: 'db.pool.error', error: err.message }));
  });
  return new PgDb(pool, options.migrateUrl);
}

/**
 * Run fn inside a transaction; rollback on any throw (SRS §11.4).
 * Re-entrant: nested calls join the outer transaction via SAVEPOINTs so that
 * services can compose (e.g. payment callback -> order transition).
 */
export async function tx<T>(db: Db, fn: () => T | Promise<T>): Promise<T> {
  if (db instanceof PgDb) return db.transaction(fn);
  if (db instanceof SqliteDb) return db.transaction(fn);
  throw new Error('tx(): unsupported database driver');
}
