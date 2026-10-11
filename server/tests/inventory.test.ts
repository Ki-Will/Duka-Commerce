import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  system, register, request, makeMerchant, addProduct, cartWith, purchase, orderState, stockOf, type TestSystem
} from './helpers.js';

// Inventory — UAT INV-001..INV-009
describe('INV — Inventory integrity', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  it('INV-001: merchant views stock for store products', async () => {
    addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100, threshold: 10 });
    addProduct(sys, { storeId: m.storeId, sku: 'KHS-002', name: 'Hammer', price: 8500, stock: 40 });
    const res = await request(sys.app).get('/api/v1/merchant/inventory').set('Cookie', m.ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.inventory).toHaveLength(2);
    const cement = res.body.inventory.find((i: { sku: string }) => i.sku === 'KHS-001');
    expect(cement.quantity).toBe(100);
    expect(cement.low_stock).toBe(0);
    expect(cement.low_stock_threshold).toBe(10);
  });

  it('INV-002: authorized stock adjustment changes quantity and records a movement', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const res = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: -30, reason: 'damaged_stock' });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(70);
    expect(stockOf(sys, p)).toBe(70);
    const movement = sys.ctx.db
      .prepare(`SELECT * FROM inventory_movements WHERE product_id = ? AND reason = 'damaged_stock'`)
      .get(p) as { delta: number; actor_id: string; order_id: string | null } | undefined;
    expect(movement).toBeTruthy();
    expect(movement!.delta).toBe(-30);
    expect(movement!.actor_id).toBe(m.ownerUserId);
    expect(movement!.order_id).toBeNull();
    const up = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: 15, reason: 'restock' });
    expect(up.body.quantity).toBe(85);
  });

  it('INV-003: staff without inventory permission cannot adjust stock', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const created = await request(sys.app).post('/api/v1/merchant/staff').set('Cookie', m.ownerCookie)
      .send({ name: 'Staff One', email: 'staff1@test.com', password: 'password123', role: 'staff' });
    expect(created.status).toBe(201);
    const { cookie: staffCookie } = await (await import('./helpers.js')).login(sys, 'staff1@test.com', 'password123');
    const denied = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', staffCookie).send({ productId: p, delta: -10 });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect(stockOf(sys, p)).toBe(100);
    // Unauthenticated denied too
    const anon = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .send({ productId: p, delta: -10 });
    expect(anon.status).toBe(401);
  });

  it('INV-004: a sale changes available quantity correctly (Critical)', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    expect(stockOf(sys, p)).toBe(100);
    await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, quantity: 3, paymentMethod: 'cod' });
    expect(stockOf(sys, p)).toBe(97);
    const movement = sys.ctx.db
      .prepare(`SELECT * FROM inventory_movements WHERE product_id = ? AND reason = 'order_reserve'`)
      .all(p) as { delta: number; order_id: string }[];
    expect(movement).toHaveLength(1);
    expect(movement[0].delta).toBe(-3);
    expect(movement[0].order_id).toBeTruthy();
  });

  it('INV-005: cancellation releases reserved stock (Critical)', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, quantity: 5, paymentMethod: 'cod' });
    expect(stockOf(sys, p)).toBe(95);
    const cancel = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({ reason: 'Changed mind' });
    expect(cancel.status).toBe(200);
    expect(stockOf(sys, p)).toBe(100);
    const release = sys.ctx.db
      .prepare(`SELECT * FROM inventory_movements WHERE product_id = ? AND reason = 'order_release'`)
      .all(p) as { delta: number }[];
    expect(release).toHaveLength(1);
    expect(release[0].delta).toBe(5);
    expect(orderState(sys, orderId)).toBe('Cancelled');
  });

  it('INV-006: no oversell under concurrent checkouts (Critical)', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 5 });
    // 10 customers each try to buy 1 unit at the same time
    const buyers: { cookie: string }[] = [];
    for (let i = 0; i < 10; i++) {
      buyers.push(await register(sys, { name: `Buyer ${i}`, email: `buyer${i}@test.com`, password: 'password123' }));
    }
    const results = await Promise.all(
      buyers.map(async (b) => {
        const cartId = await cartWith(sys, b.cookie, m.storeId, p, 1);
        return request(sys.app).post('/api/v1/orders').set('Cookie', b.cookie).send({
          cartId, deliveryMethod: 'pickup', paymentMethod: 'cod', idempotencyKey: `race-${Math.random()}`
        });
      })
    );
    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 400);
    expect(ok).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) expect(r.body.code).toBe('ORDER_STOCK_UNAVAILABLE');
    expect(stockOf(sys, p)).toBe(0);
    const orderCount = sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number };
    expect(orderCount.c).toBe(5);
    // Stock never goes negative
    expect(stockOf(sys, p)).toBeGreaterThanOrEqual(0);
  });

  it('INV-007: low-stock threshold crossing generates an event', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 20, threshold: 10 });
    const below = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: -13, reason: 'counts' });
    expect(below.status).toBe(200);
    expect(below.body.quantity).toBe(7);
    const notif = sys.ctx.db
      .prepare(`SELECT * FROM notifications WHERE type = 'low_stock' AND recipient = ?`)
      .all(m.ownerUserId) as { subject: string; status: string }[];
    expect(notif).toHaveLength(1);
    expect(notif[0].subject).toContain('Cement');
    expect(notif[0].status).toBe('pending');
    // Crossing back above threshold does not re-notify for this adjustment
    await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: 10, reason: 'restock' });
    const notif2 = sys.ctx.db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE type = 'low_stock'`).get() as { c: number };
    expect(notif2.c).toBe(1);
  });

  it('INV-008: negative stock is prevented', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 5 });
    const res = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: -6, reason: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVENTORY_NEGATIVE');
    expect(stockOf(sys, p)).toBe(5);
    const zero = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: -5, reason: 'clear' });
    expect(zero.status).toBe(200);
    expect(stockOf(sys, p)).toBe(0);
    const stillNegative = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: -1, reason: 'oops' });
    expect(stillNegative.status).toBe(400);
    expect(stockOf(sys, p)).toBe(0);
  });

  it('INV-009: inventory changes carry actor and reason in audit history', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: -5, reason: 'cycle_count' });
    const movements = sys.ctx.db.prepare('SELECT * FROM inventory_movements WHERE product_id = ?').all(p) as {
      delta: number; reason: string; actor_id: string; created_at: string;
    }[];
    expect(movements.length).toBeGreaterThanOrEqual(2); // initial stock + adjustment
    const adj = movements.find((mv) => mv.reason === 'cycle_count');
    expect(adj).toBeTruthy();
    expect(adj!.actor_id).toBe(m.ownerUserId);
    expect(new Date(adj!.created_at).getTime()).toBeGreaterThan(0);
    const auditRow = sys.ctx.db
      .prepare(`SELECT * FROM audit_events WHERE action = 'inventory.adjusted' AND entity_id = ?`)
      .get(p) as { actor_id: string; detail: string } | undefined;
    expect(auditRow).toBeTruthy();
    expect(auditRow!.actor_id).toBe(m.ownerUserId);
    expect(auditRow!.detail).toContain('cycle_count');
  });

  it('merchant cannot adjust another store\'s inventory', async () => {
    const other = await makeMerchant(sys, { ownerEmail: 'tech@test.com', storeName: 'Tech Corner' });
    const p = addProduct(sys, { storeId: other.storeId, sku: 'TC-001', name: 'Cable', price: 7500, stock: 60 });
    const res = await request(sys.app).post('/api/v1/merchant/inventory/adjustments')
      .set('Cookie', m.ownerCookie).send({ productId: p, delta: -10 });
    expect(res.status).toBe(404);
    expect(stockOf(sys, p)).toBe(60);
  });
});
