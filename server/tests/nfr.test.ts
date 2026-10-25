import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { system, register, login, request, makeMerchant, addProduct, cartWith, purchase, orderState, stockOf, type TestSystem } from './helpers.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { flushNotifications } from '../src/services/notifications.js';

// Non-functional — UAT NF-001..NF-014 (automatable subset; manual/ops cases noted in RTM)
describe('NF — Non-functional requirements', () => {
  let sys: TestSystem;
  beforeEach(async () => {
    sys = system();
  });
  afterEach(() => sys.close());

  // p95 budgets describe the local pilot deployment. Against Neon the DB is
  // one WAN round trip away (~270ms/query from this runner), so these two
  // measure the network, not the app — the default (sqlite) suite still runs
  // them at full strength. NF-003 is a correctness test, so it still runs on
  // Neon, just with room for the latency.
  const onPostgres = process.env.DUKA_TEST_DRIVER === 'postgres';

  it.skipIf(onPostgres)('NF-001: catalogue requests meet p95 <= 500ms under pilot-style load', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    for (let i = 0; i < 20; i++) {
      await addProduct(sys, { storeId: m.storeId, sku: `SKU-${i}`, name: `Product ${i}`, price: 1000 + i, stock: 50 });
    }
    const durations: number[] = [];
    for (let i = 0; i < 60; i++) {
      const start = Date.now();
      const res = await request(sys.app).get('/api/v1/stores').query({ search: i % 2 ? 'Kigali' : '' });
      durations.push(Date.now() - start);
      expect(res.status).toBe(200);
    }
    const products = await request(sys.app).get('/api/v1/products').query({ search: 'Product' });
    expect(products.body.products.length).toBeGreaterThan(0);
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)];
    console.log(`NF-001 catalogue p95 = ${p95}ms`);
    expect(p95).toBeLessThanOrEqual(500);
  });

  it.skipIf(onPostgres)('NF-002: login meets p95 <= 500ms', async () => {
    await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const durations: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = Date.now();
      const res = await request(sys.app).post('/api/v1/auth/login')
        .send({ email: 'amina@test.com', password: 'password123' });
      durations.push(Date.now() - start);
      expect(res.status).toBe(200);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)];
    console.log(`NF-002 login p95 = ${p95}ms`);
    expect(p95).toBeLessThanOrEqual(500);
  });

  it('NF-003: concurrent checkout load causes no oversell and a sane error rate', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 7 });
    const buyers: { cookie: string }[] = [];
    for (let i = 0; i < 25; i++) {
      buyers.push(await register(sys, { name: `B${i}`, email: `b${i}@test.com`, password: 'password123' }));
    }
    const results = await Promise.all(
      buyers.map(async (b) => {
        const cartId = await cartWith(sys, b.cookie, m.storeId, p, 1);
        return request(sys.app).post('/api/v1/orders').set('Cookie', b.cookie).send({
          cartId, deliveryMethod: 'pickup', paymentMethod: 'cod', idempotencyKey: `nf3-${Math.random()}`
        });
      })
    );
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 400).length;
    const serverErrors = results.filter((r) => r.status >= 500).length;
    expect(created).toBe(7);
    expect(rejected).toBe(18);
    expect(serverErrors).toBe(0); // controlled failure states (NFR-REL-02)
    expect(await stockOf(sys, p)).toBe(0);
    expect(await stockOf(sys, p)).toBeGreaterThanOrEqual(0);
    for (const r of results.filter((x) => x.status === 400)) {
      expect(r.body.code).toBe('ORDER_STOCK_UNAVAILABLE');
      expect(r.body.traceId).toBeTruthy();
    }
  }, onPostgres ? 300_000 : 20_000);

  it('NF-004: payment timeout resilience — no false Paid state', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'momo' });
    const paymentId = order.body.payment.id;
    await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`)
      .set('Cookie', customer.cookie).send({ result: 'timeout' });
    const payment = await sys.ctx.db.prepare('SELECT state FROM payments WHERE id = ?').get(paymentId) as { state: string };
    expect(payment.state).toBe('Expired');
    expect(payment.state).not.toBe('Paid');
    expect(await orderState(sys, order.body.order.id)).not.toBe('Confirmed');
    // No order can confirm without authoritative payment (BR-04/BR-05)
    const confirmed = await sys.ctx.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE state = 'Confirmed'`).get() as { c: number };
    expect(confirmed.c).toBe(0);
  });

  it('NF-005: notification outage keeps commercial state correct', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const { orderId, paymentId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p });
    const outcome = await flushNotifications(sys.ctx, { providerDown: true });
    expect(outcome.failed).toBeGreaterThan(0);
    expect(outcome.sent).toBe(0);
    // Order and payment states remain authoritative and unchanged
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    const payment = await sys.ctx.db.prepare('SELECT state FROM payments WHERE id = ?').get(paymentId!) as { state: string };
    expect(payment.state).toBe('Paid');
  });

  it('NF-006: health endpoint reports service health without leaking secrets', async () => {
    const res = await request(sys.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/secret|password|token|webhook/i);
    expect(raw).not.toContain('duka-sandbox-webhook-secret');
  });

  it('NF-007: invalid API requests produce safe structured errors', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    // Missing required fields
    const bad = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send({});
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect(bad.body.traceId).toBeTruthy();
    expect(bad.body.message).toBeTruthy();
    // Unknown route
    const missing = await request(sys.app).get('/api/v1/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
    // Malformed JSON body
    const malformed = await request(sys.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect([400, 500]).toContain(malformed.status);
    expect(JSON.stringify(malformed.body)).not.toMatch(/stack|at .+\\.ts:|SELECT |sqlite/i);
    // Unknown order id → structured 404
    const noOrder = await request(sys.app).get('/api/v1/orders/does-not-exist').set('Cookie', customer.cookie);
    expect(noOrder.status).toBe(404);
    expect(noOrder.body.traceId).toBeTruthy();
    expect(m).toBeTruthy();
  });

  it('NF-009: API logs are structured JSON with trace IDs', async () => {
    await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const traceId = 'test-trace-1234';
    await request(sys.app).get('/api/v1/stores').set('x-request-id', traceId);
    expect(sys.logs.length).toBeGreaterThan(0);
    const httpLogs = sys.logs.filter((l) => l.event === 'http.request');
    expect(httpLogs.length).toBeGreaterThan(0);
    for (const log of httpLogs) {
      // SRS §15.1 required fields
      expect(log.timestamp).toBeTruthy();
      expect(log.level).toBeTruthy();
      expect(log.service).toBe('duka-api');
      expect(log.environment).toBe('test');
      expect(log.requestId).toBeTruthy();
      expect(typeof log.result).toBe('string');
    }
    const correlated = sys.logs.find((l) => l.requestId === traceId);
    expect(correlated).toBeTruthy();
    expect(correlated!.method).toBe('GET');
    // No secrets in logs
    expect(JSON.stringify(sys.logs)).not.toMatch(/password|scrypt|duka-sandbox-webhook-secret/i);
  });

  it('NF-014: database backup can be restored per the documented procedure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duka-backup-'));
    try {
      const dbPath = join(dir, 'duka.sqlite');
      const db = openDb(dbPath);
      await db.prepare(`INSERT INTO users (id, role, name, email, phone, password_hash, status, created_at)
                  VALUES ('u1', 'customer', 'Backup User', 'backup@test.com', NULL, 'scrypt$x$y', 'active', ?)`)
        .run(new Date().toISOString());
      await db.exec('PRAGMA wal_checkpoint(FULL)');
      db.close();
      // Documented restore procedure: copy the SQLite file back into place
      const backupPath = join(dir, 'duka.sqlite.backup');
      copyFileSync(dbPath, backupPath);
      expect(existsSync(backupPath)).toBe(true);
      // Restore: put the backup where the app expects it
      copyFileSync(backupPath, dbPath);
      const restored = openDb(dbPath);
      const row = await restored.prepare('SELECT email FROM users WHERE id = ?').get('u1') as { email: string } | undefined;
      expect(row?.email).toBe('backup@test.com');
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /health works before UAT environment use (entry criterion)', async () => {
    const res = await request(sys.app).get('/health');
    expect(res.status).toBe(200);
    expect(new Date(res.body.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('error responses never expose stack traces or SQL', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    // 500-style trigger: malformed webhook
    const raw = 'definitely not json';
    const res = await request(sys.app).post('/api/v1/payments/webhooks/momo').set('x-signature', 'bad').send(raw);
    expect(res.status).toBe(403);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/node_modules|\.ts:\d+|SELECT |INSERT |sqlite/i);
    expect(m).toBeTruthy();
    expect(customer).toBeTruthy();
  });
});
