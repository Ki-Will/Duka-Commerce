import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { system, register, login, request, makeUser, makeMerchant, addProduct, cartWith, purchase, orderState, type TestSystem } from './helpers.js';

// Administration & support — UAT ADM-001..ADM-005, SUP-001..SUP-003
describe('ADM — Platform administration', () => {
  let sys: TestSystem;
  let admin: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    await makeUser(sys, { role: 'admin', name: 'Platform Admin', email: 'admin@test.com' });
    const session = await login(sys, 'admin@test.com', 'password123');
    admin = { cookie: session.cookie, id: session.user.id };
  });
  afterEach(() => sys.close());

  async function applyAs(email: string) {
    const { cookie } = await register(sys, { name: 'Owner', email, password: 'password123' });
    const res = await request(sys.app).post('/api/v1/merchants/apply').set('Cookie', cookie)
      .send({ businessName: 'Biz Ltd', contactEmail: email });
    return { cookie, merchantId: res.body.merchant.id as string };
  }

  it('ADM-001: admin approves a merchant', async () => {
    const { merchantId, cookie } = await applyAs('owner@test.com');
    const res = await request(sys.app).post(`/api/v1/admin/merchants/${merchantId}/approve`)
      .set('Cookie', admin.cookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.merchant.status).toBe('approved');
    // Approved merchant can now create a store
    const store = await request(sys.app).post('/api/v1/merchant/store').set('Cookie', cookie).send({ name: 'New Store' });
    expect(store.status).toBe(201);
  });

  it('ADM-002: suspending a merchant suspends the store and blocks purchases (Critical)', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const suspend = await request(sys.app).post(`/api/v1/admin/merchants/${m.merchantId}/suspend`)
      .set('Cookie', admin.cookie).send({ reason: 'Fraud investigation' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.merchant.status).toBe('suspended');
    // Store auto-suspended
    const storeRow = await sys.ctx.db.prepare('SELECT status FROM stores WHERE id = ?').get(m.storeId) as { status: string };
    expect(storeRow.status).toBe('suspended');
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'cod' });
    expect(order.status).toBe(409);
    expect(order.body.code).toBe('STORE_NOT_ACCEPTING_ORDERS');
    // Suspended store hidden from marketplace discovery
    const stores = await request(sys.app).get('/api/v1/stores');
    expect(stores.body.stores.find((s: { id: string }) => s.id === m.storeId)).toBeUndefined();
  });

  it('ADM-003: admin adds and edits categories', async () => {
    const create = await request(sys.app).post('/api/v1/admin/categories').set('Cookie', admin.cookie)
      .send({ name: 'Building Materials' });
    expect(create.status).toBe(201);
    expect(create.body.category.slug).toBe('building-materials');
    const dup = await request(sys.app).post('/api/v1/admin/categories').set('Cookie', admin.cookie)
      .send({ name: 'Building Materials' });
    expect(dup.status).toBe(409);
    const edit = await request(sys.app).patch(`/api/v1/admin/categories/${create.body.category.id}`)
      .set('Cookie', admin.cookie).send({ name: 'Building & Hardware' });
    expect(edit.status).toBe(200);
    expect(edit.body.category.name).toBe('Building & Hardware');
    // Public listing updated
    const pub = await request(sys.app).get('/api/v1/categories');
    expect(pub.body.categories).toHaveLength(1);
  });

  it('ADM-004: admin suspends a product making it unavailable for purchase', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const susp = await request(sys.app).post(`/api/v1/admin/products/${p}/status`)
      .set('Cookie', admin.cookie).send({ status: 'suspended', reason: 'Counterfeit concern' });
    expect(susp.status).toBe(200);
    expect(susp.body.product.status).toBe('suspended');
    const detail = await request(sys.app).get(`/api/v1/products/${p}`);
    expect(detail.status).toBe(404);
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1).catch(() => null);
    if (cartId) {
      const add = await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
        .send({ productId: p, quantity: 1 });
      expect(add.status).toBe(400);
    }
    // Admin can restore it
    const restore = await request(sys.app).post(`/api/v1/admin/products/${p}/status`)
      .set('Cookie', admin.cookie).send({ status: 'published', reason: 'Cleared' });
    expect(restore.status).toBe(200);
    const detail2 = await request(sys.app).get(`/api/v1/products/${p}`);
    expect(detail2.status).toBe(200);
  });

  it('ADM-005: admin actions are captured in the audit trail with actor/action/time', async () => {
    const { merchantId } = await applyAs('owner@test.com');
    await request(sys.app).post(`/api/v1/admin/merchants/${merchantId}/approve`).set('Cookie', admin.cookie).send({});
    const audit = await request(sys.app).get('/api/v1/admin/audit').set('Cookie', admin.cookie)
      .query({ entity: 'merchant' });
    expect(audit.status).toBe(200);
    const entry = (audit.body.audit as { action: string; actor_id: string; created_at: string }[])
      .find((a) => a.action === 'merchant.approve');
    expect(entry).toBeTruthy();
    expect(entry!.actor_id).toBe(admin.id);
    expect(new Date(entry!.created_at).getTime()).toBeGreaterThan(0);
    // Non-admins cannot read the audit log
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Store' });
    const denied = await request(sys.app).get('/api/v1/admin/audit').set('Cookie', m.ownerCookie);
    expect(denied.status).toBe(403);
  });

  it('admin operational views list merchants, orders and users', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const merchants = await request(sys.app).get('/api/v1/admin/merchants').set('Cookie', admin.cookie);
    expect(merchants.body.merchants).toHaveLength(1);
    const orders = await request(sys.app).get('/api/v1/admin/orders').set('Cookie', admin.cookie);
    expect(orders.body.orders).toHaveLength(1);
    expect(orders.body.orders[0].store_name).toBe('Kigali Home');
    const users = await request(sys.app).get('/api/v1/admin/users').set('Cookie', admin.cookie).query({ search: 'amina' });
    expect(users.body.users).toHaveLength(1);
    const stores = await request(sys.app).get('/api/v1/admin/stores').set('Cookie', admin.cookie);
    expect(stores.body.stores).toHaveLength(1);
    const products = await request(sys.app).get('/api/v1/admin/products').set('Cookie', admin.cookie);
    expect(products.body.products).toHaveLength(1);
    const orderDetail = await request(sys.app).get(`/api/v1/admin/orders/${orders.body.orders[0].id}`).set('Cookie', admin.cookie);
    expect(orderDetail.status).toBe(200);
    expect(orderDetail.body.order.items).toHaveLength(1);
  });
});

describe('SUP — Support investigation', () => {
  let sys: TestSystem;
  let support: { cookie: string };
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  let orderNumber: string;
  let orderId: string;
  beforeEach(async () => {
    sys = system();
    await makeUser(sys, { role: 'support', name: 'Support Agent', email: 'support@test.com' });
    const session = await login(sys, 'support@test.com', 'password123');
    support = { cookie: session.cookie };
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const created = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'momo' });
    orderNumber = created.orderNumber;
    orderId = created.orderId;
  });
  afterEach(() => sys.close());

  it('SUP-001: support can find a permitted order with limited details', async () => {
    const res = await request(sys.app).get(`/api/v1/support/orders/${orderNumber}`).set('Cookie', support.cookie);
    expect(res.status).toBe(200);
    expect(res.body.order.order_number).toBe(orderNumber);
    expect(res.body.order.state).toBe('Confirmed');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.payment).toBeTruthy();
    expect(res.body.payment.state).toBe('Paid');
    expect(res.body.payment.provider_ref).toMatch(/^MOMO-STUB-/);
    // Limited details: no customer email/phone/password exposure
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('amina@test.com');
    expect(raw).not.toMatch(/password|scrypt/i);
    expect(raw).not.toContain('0788');
  });

  it('SUP-002: support cannot modify unauthorized financial/order state (Critical)', async () => {
    // Cannot reach merchant console endpoints
    const merchantOrders = await request(sys.app).get('/api/v1/merchant/orders').set('Cookie', support.cookie);
    expect(merchantOrders.status).toBe(403);
    // Cannot reach admin endpoints
    const adminMerchants = await request(sys.app).get('/api/v1/admin/merchants').set('Cookie', support.cookie);
    expect(adminMerchants.status).toBe(403);
    const refund = await request(sys.app).post(`/api/v1/admin/orders/${orderId}/refund`)
      .set('Cookie', support.cookie).send({ reason: 'tamper' });
    expect(refund.status).toBe(403);
    // Cannot cancel another user's order
    const cancel = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', support.cookie).send({ reason: 'tamper' });
    expect([403, 404]).toContain(cancel.status);
    // Cannot mutate payments
    const payments = await request(sys.app).get('/api/v1/admin/payments').set('Cookie', support.cookie);
    expect(payments.status).toBe(403);
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    const refundCount = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM refunds').get() as { c: number };
    expect(refundCount.c).toBe(0);
  });

  it('SUP-003: support lookups are audited', async () => {
    await request(sys.app).get(`/api/v1/support/orders/${orderNumber}`).set('Cookie', support.cookie);
    const entries = await sys.ctx.db
      .prepare(`SELECT * FROM audit_events WHERE action = 'support.order_lookup'`)
      .all() as { actor_id: string; entity_id: string; created_at: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].entity_id).toBe(orderId);
    expect(new Date(entries[0].created_at).getTime()).toBeGreaterThan(0);
    // Customer search also audited
    await request(sys.app).get('/api/v1/support/customers').set('Cookie', support.cookie).query({ search: 'amina' });
    const searchAudit = await sys.ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE action = 'support.customer_lookup'`)
      .get() as { c: number };
    expect(searchAudit.c).toBe(1);
  });

  it('unauthenticated users cannot use support endpoints', async () => {
    const res = await request(sys.app).get(`/api/v1/support/orders/${orderNumber}`);
    expect(res.status).toBe(401);
  });
});
