import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { system, register, login, request, makeUser, makeMerchant, addProduct, purchase, type TestSystem } from './helpers.js';

// Reporting — UAT RPT-001..RPT-008
describe('RPT — Reporting', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  async function seedOrders() {
    const cement = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const hammer = addProduct(sys, { storeId: m.storeId, sku: 'KHS-002', name: 'Hammer', price: 8500, stock: 40 });
    const o1 = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: cement, quantity: 2, paymentMethod: 'cod' });
    const o2 = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: hammer, quantity: 1, paymentMethod: 'cod' });
    const o3 = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: cement, quantity: 1, paymentMethod: 'cod' });
    return { cement, hammer, o1, o2, o3 };
  }

  it('RPT-001: merchant sales report returns the correct total for a period', async () => {
    await seedOrders();
    const res = await request(sys.app).get('/api/v1/merchant/reports/summary').set('Cookie', m.ownerCookie);
    expect(res.status).toBe(200);
    // 30000 + 8500 + 15000
    expect(res.body.totals.sales_total).toBe(53500);
    expect(res.body.totals.order_count).toBe(3);
    expect(res.body.range.from).toBeTruthy();
    expect(res.body.range.to).toBeTruthy();
  });

  it('RPT-002: order status report counts reconcile with actual orders', async () => {
    const { o1, o2 } = await seedOrders();
    // Cancel one order (the Hammer order: 8500)
    const cancelRes = await request(sys.app).post(`/api/v1/orders/${o2.orderId}/cancel`).set('Cookie', customer.cookie).send({ reason: 'report test' });
    expect(cancelRes.status).toBe(200);
    const res = await request(sys.app).get('/api/v1/merchant/reports/summary').set('Cookie', m.ownerCookie);
    const byState = Object.fromEntries(res.body.byState.map((r: { state: string; count: number }) => [r.state, r.count]));
    const dbCounts = sys.ctx.db.prepare('SELECT state, COUNT(*) AS c FROM orders WHERE store_id = ? GROUP BY state').all(m.storeId) as {
      state: string; c: number;
    }[];
    for (const row of dbCounts) {
      expect(byState[row.state]).toBe(row.c);
    }
    const totalFromReport = res.body.byState.reduce((a: number, r: { count: number }) => a + r.count, 0);
    expect(totalFromReport).toBe(3);
    expect(byState['Cancelled']).toBe(1);
    expect(res.body.totals.cancelled_count).toBe(1);
    expect(res.body.totals.sales_total).toBe(45000); // 53500 - 8500 cancelled
    expect(o1).toBeTruthy();
  });

  it('RPT-003: inventory report values match inventory records', async () => {
    const { cement, hammer } = await seedOrders();
    const res = await request(sys.app).get('/api/v1/merchant/reports/inventory').set('Cookie', m.ownerCookie);
    expect(res.status).toBe(200);
    const cementRow = res.body.inventory.find((i: { product_id: string }) => i.product_id === cement);
    const hammerRow = res.body.inventory.find((i: { product_id: string }) => i.product_id === hammer);
    const dbCement = sys.ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(cement) as { quantity: number };
    const dbHammer = sys.ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(hammer) as { quantity: number };
    expect(cementRow.quantity).toBe(dbCement.quantity); // 100 - 2 - 1 = 97
    expect(cementRow.quantity).toBe(97);
    expect(hammerRow.quantity).toBe(dbHammer.quantity); // 40 - 1 = 39
  });

  it('RPT-004: top products ranking uses units sold', async () => {
    await seedOrders();
    const res = await request(sys.app).get('/api/v1/merchant/reports/top-products').set('Cookie', m.ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.topProducts[0].product_name).toBe('Cement');
    expect(res.body.topProducts[0].units_sold).toBe(3);
    expect(res.body.topProducts[0].revenue).toBe(45000);
    expect(res.body.topProducts[1].product_name).toBe('Hammer');
    expect(res.body.topProducts[1].units_sold).toBe(1);
  });

  it('RPT-005: cancellation/refund report shows correct totals and statuses', async () => {
    const { o2 } = await seedOrders();
    const cancelRes = await request(sys.app).post(`/api/v1/orders/${o2.orderId}/cancel`).set('Cookie', customer.cookie).send({ reason: 'changed mind' });
    expect(cancelRes.status).toBe(200);
    // Paid order + refund
    const paid = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: addProduct(sys, { storeId: m.storeId, sku: 'KHS-003', name: 'Trowel', price: 2000, stock: 30 }) });
    const refund = await request(sys.app).post(`/api/v1/merchant/orders/${paid.orderId}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'damaged' });
    expect(refund.status).toBe(201);
    const res = await request(sys.app).get('/api/v1/merchant/reports/summary').set('Cookie', m.ownerCookie);
    expect(res.body.totals.cancelled_count).toBe(1);
    expect(res.body.refunds.refund_count).toBe(1);
    expect(res.body.refunds.refund_total).toBe(2000); // Trowel order total
    const paymentsByState = Object.fromEntries(res.body.payments.map((p: { state: string; count: number }) => [p.state, p.count]));
    expect(paymentsByState['RefundPending']).toBe(1);
    expect(paymentsByState['Paid'] ?? 0).toBe(0); // seed orders are COD; only the Trowel payment exists
  });

  it('RPT-006: admin platform report shows platform-wide metrics', async () => {
    await seedOrders();
    makeUser(sys, { role: 'admin', name: 'Admin', email: 'admin@test.com' });
    const { cookie: adminCookie } = await login(sys, 'admin@test.com', 'password123');
    const res = await request(sys.app).get('/api/v1/admin/reports/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.grossRevenue).toBe(53500);
    const merchantApproved = res.body.merchants.find((r: { status: string }) => r.status === 'approved');
    expect(merchantApproved.count).toBe(1);
    const confirmed = res.body.orders.find((r: { state: string }) => r.state === 'Confirmed');
    expect(confirmed.count).toBe(3);
    expect(res.body.stores.length).toBeGreaterThan(0);
    expect(res.body.lowStockCount).toBe(0);
  });

  it('RPT-007: merchant reports are isolated per store (Critical)', async () => {
    await seedOrders(); // Kigali Home: 3 orders, 53500
    const other = await makeMerchant(sys, { ownerEmail: 'tech@test.com', storeName: 'Tech Corner' });
    const otherProduct = addProduct(sys, { storeId: other.storeId, sku: 'TC-001', name: 'Cable', price: 7500, stock: 60 });
    const buyer2 = await register(sys, { name: 'Eric', email: 'eric@test.com', password: 'password123' });
    await purchase(sys, { cookie: buyer2.cookie, storeId: other.storeId, productId: otherProduct, quantity: 2, paymentMethod: 'cod' });
    // Kigali Home sees only its own data
    const resA = await request(sys.app).get('/api/v1/merchant/reports/summary').set('Cookie', m.ownerCookie);
    expect(resA.body.totals.order_count).toBe(3);
    expect(resA.body.totals.sales_total).toBe(53500);
    // Tech Corner sees only its own data
    const resB = await request(sys.app).get('/api/v1/merchant/reports/summary').set('Cookie', other.ownerCookie);
    expect(resB.body.totals.order_count).toBe(1);
    expect(resB.body.totals.sales_total).toBe(15000);
    const topB = await request(sys.app).get('/api/v1/merchant/reports/top-products').set('Cookie', other.ownerCookie);
    expect(topB.body.topProducts).toHaveLength(1);
    expect(topB.body.topProducts[0].product_name).toBe('Cable');
  });

  it('RPT-008: date range boundaries are respected', async () => {
    const { o1 } = await seedOrders();
    // Move one order into the past
    sys.ctx.db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run('2020-01-01T12:00:00.000Z', o1.orderId);
    const all = await request(sys.app).get('/api/v1/merchant/reports/summary').set('Cookie', m.ownerCookie);
    expect(all.body.totals.order_count).toBe(3);
    const since2021 = await request(sys.app).get('/api/v1/merchant/reports/summary')
      .set('Cookie', m.ownerCookie).query({ from: '2021-01-01' });
    expect(since2021.body.totals.order_count).toBe(2);
    const until2020 = await request(sys.app).get('/api/v1/merchant/reports/summary')
      .set('Cookie', m.ownerCookie).query({ to: '2020-12-31T23:59:59.999Z' });
    expect(until2020.body.totals.order_count).toBe(1);
    expect(until2020.body.totals.sales_total).toBe(30000); // o1: 2 × cement
  });

  it('reports require authentication and merchant role', async () => {
    const anon = await request(sys.app).get('/api/v1/merchant/reports/summary');
    expect(anon.status).toBe(401);
    const asCustomer = await request(sys.app).get('/api/v1/merchant/reports/summary').set('Cookie', customer.cookie);
    expect(asCustomer.status).toBe(403);
  });
});
