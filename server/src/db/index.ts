import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SCHEMA } from './schema.js';

export type Db = DatabaseSync;
export type SqlParam = string | number | bigint | Uint8Array | null;

export interface AppDb {
  db: Db;
  close(): void;
}

export function openDb(file: string = ':memory:'): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

/**
 * Run fn inside an IMMEDIATE transaction; rollback on any throw (SRS §11.4).
 * Re-entrant: nested calls join the outer transaction via SAVEPOINTs so that
 * services can compose (e.g. payment callback -> order transition).
 */
const txDepth = new WeakMap<Db, number>();

export function tx<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    const savepoint = `duka_sp_${depth}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    txDepth.set(db, depth + 1);
    try {
      const result = fn();
      db.exec(`RELEASE ${savepoint}`);
      txDepth.set(db, depth);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch {
        /* outer transaction will roll back */
      }
      txDepth.set(db, depth);
      throw err;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    txDepth.set(db, 0);
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    txDepth.set(db, 0);
    throw err;
  }
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
