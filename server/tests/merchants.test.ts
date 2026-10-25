import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  system, register, login, request, makeUser, makeMerchant, addProduct, cartWith, purchase,
  orderState, stockOf, type TestSystem
} from './helpers.js';

// Merchant onboarding & stores — UAT MER-001..MER-010
describe('MER — Merchant onboarding & stores', () => {
  let sys: TestSystem;
  beforeEach(() => { sys = system(); });
  afterEach(() => sys.close());

  async function applyForMerchant(cookie: string) {
    return request(sys.app)
      .post('/api/v1/merchants/apply')
      .set('Cookie', cookie)
      .send({ businessName: 'Kigali Home Supplies Ltd', contactEmail: 'owner@test.com', contactPhone: '0788123456' });
  }

  it('MER-001: merchant application is submitted', async () => {
    const { cookie } = await register(sys, { name: 'Owner', email: 'owner@test.com', password: 'password123' });
    const res = await applyForMerchant(cookie);
    expect(res.status).toBe(201);
    expect(res.body.merchant.status).toBe('pending');
    // Duplicate application prevented
    const again = await applyForMerchant(cookie);
    expect(again.status).toBe(409);
  });

  it('MER-002: admin approves merchant and the applicant becomes an owner', async () => {
    const { cookie, id } = await register(sys, { name: 'Owner', email: 'owner@test.com', password: 'password123' });
    const applied = await applyForMerchant(cookie);
    const adminId = await makeUser(sys, { role: 'admin', name: 'Admin', email: 'admin@test.com' });
    const { cookie: adminCookie } = await login(sys, 'admin@test.com', 'password123');
    const approve = await request(sys.app)
      .post(`/api/v1/admin/merchants/${applied.body.merchant.id}/approve`)
      .set('Cookie', adminCookie)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.merchant.status).toBe('approved');
    const user = await sys.ctx.db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string };
    expect(user.role).toBe('owner');
    // Store creation now allowed
    const store = await request(sys.app).post('/api/v1/merchant/store').set('Cookie', cookie).send({ name: 'Kigali Home' });
    expect(store.status).toBe(201);
    expect(adminId).toBeTruthy();
  });

  it('MER-003: admin rejects merchant with reason; applicant stays inactive', async () => {
    const { cookie, id } = await register(sys, { name: 'Owner', email: 'owner@test.com', password: 'password123' });
    const applied = await applyForMerchant(cookie);
    await makeUser(sys, { role: 'admin', name: 'Admin', email: 'admin@test.com' });
    const { cookie: admin2 } = await login(sys, 'admin@test.com', 'password123');
    const reject = await request(sys.app)
      .post(`/api/v1/admin/merchants/${applied.body.merchant.id}/reject`)
      .set('Cookie', admin2)
      .send({ reason: 'Incomplete documents' });
    expect(reject.status).toBe(200);
    expect(reject.body.merchant.status).toBe('rejected');
    expect(reject.body.merchant.reason).toBe('Incomplete documents');
    const user = await sys.ctx.db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string };
    expect(user.role).toBe('customer');
    // Rejected merchant cannot create a store
    const store = await request(sys.app).post('/api/v1/merchant/store').set('Cookie', cookie).send({ name: 'Nope Store' });
    expect(store.status).toBe(403);
  });

  it('MER-004: approved merchant creates a store', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const res = await request(sys.app).get('/api/v1/merchant/store').set('Cookie', m.ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.store.name).toBe('Kigali Home');
    expect(res.body.store.status).toBe('open');
    // Only one store per merchant (Phase 1)
    const second = await request(sys.app).post('/api/v1/merchant/store').set('Cookie', m.ownerCookie).send({ name: 'Second' });
    expect(second.status).toBe(409);
  });

  it('MER-005: merchant updates store profile and changes persist', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const res = await request(sys.app)
      .patch('/api/v1/merchant/store')
      .set('Cookie', m.ownerCookie)
      .send({ description: 'Building materials in Kigali', contact: '+250 788 000 111' });
    expect(res.status).toBe(200);
    const row = await sys.ctx.db.prepare('SELECT description FROM stores WHERE id = ?').get(m.storeId) as { description: string };
    expect(row.description).toBe('Building materials in Kigali');
  });

  it('MER-006: store can be closed and closed store blocks new orders', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const product = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const close = await request(sys.app)
      .patch('/api/v1/merchant/store/status')
      .set('Cookie', m.ownerCookie)
      .send({ status: 'closed' });
    expect(close.status).toBe(200);
    expect(close.body.store.status).toBe('closed');
    const cartId = await cartWith(sys, customer.cookie, m.storeId, product, 1);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send({
      cartId, deliveryMethod: 'pickup', paymentMethod: 'cod'
    });
    expect(order.status).toBe(409);
    expect(order.body.code).toBe('STORE_NOT_ACCEPTING_ORDERS');
    // Reopen
    await request(sys.app).patch('/api/v1/merchant/store/status').set('Cookie', m.ownerCookie).send({ status: 'open' });
    const retry = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send({
      cartId, deliveryMethod: 'pickup', paymentMethod: 'cod'
    });
    expect(retry.status).toBe(201);
  });

  it('MER-007: suspended store cannot accept new customer orders (BR-07)', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const product = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    await makeUser(sys, { role: 'admin', name: 'Admin', email: 'admin@test.com' });
    const { cookie: admin } = await login(sys, 'admin@test.com', 'password123');
    const suspend = await request(sys.app)
      .post(`/api/v1/admin/stores/${m.storeId}/status`)
      .set('Cookie', admin)
      .send({ status: 'suspended', reason: 'Policy violation' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.store.status).toBe('suspended');
    const cartId = await cartWith(sys, customer.cookie, m.storeId, product, 1);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send({
      cartId, deliveryMethod: 'pickup', paymentMethod: 'cod'
    });
    expect(order.status).toBe(409);
    expect(order.body.code).toBe('STORE_NOT_ACCEPTING_ORDERS');
  });

  it('MER-008: staff is assigned to a store and can access permitted functions only', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const create = await request(sys.app)
      .post('/api/v1/merchant/staff')
      .set('Cookie', m.ownerCookie)
      .send({ name: 'Staff One', email: 'staff1@test.com', password: 'password123', role: 'staff' });
    expect(create.status).toBe(201);
    const { cookie: staffCookie } = await login(sys, 'staff1@test.com', 'password123');
    // Permitted: view orders
    const orders = await request(sys.app).get('/api/v1/merchant/orders').set('Cookie', staffCookie);
    expect(orders.status).toBe(200);
    // Not permitted by default: store settings
    const settings = await request(sys.app)
      .patch('/api/v1/merchant/store')
      .set('Cookie', staffCookie)
      .send({ description: 'hijack' });
    expect(settings.status).toBe(403);
    // Not permitted: staff management
    const staffList = await request(sys.app).post('/api/v1/merchant/staff').set('Cookie', staffCookie)
      .send({ name: 'X', email: 'x@test.com', password: 'password123' });
    expect(staffList.status).toBe(403);
    const list = await request(sys.app).get('/api/v1/merchant/staff').set('Cookie', staffCookie);
    expect(list.status).toBe(200);
    expect(list.body.staff).toHaveLength(1);
  });

  it('MER-009: staff of Store A cannot access Store B data', async () => {
    const a = await makeMerchant(sys, { ownerEmail: 'a@test.com', storeName: 'Store A' });
    const b = await makeMerchant(sys, { ownerEmail: 'b@test.com', storeName: 'Store B' });
    const productB = await addProduct(sys, { storeId: b.storeId, sku: 'B-001', name: 'Product B', price: 1000, stock: 5 });
    await request(sys.app).post('/api/v1/merchant/staff').set('Cookie', a.ownerCookie)
      .send({ name: 'Staff A', email: 'staffa@test.com', password: 'password123', role: 'staff',
              perms: ['catalogue:write', 'orders:write', 'reports:read'] });
    const { cookie: staffCookie } = await login(sys, 'staffa@test.com', 'password123');
    // Attempt to mutate Store B's product is denied (not found → no existence leak)
    const editB = await request(sys.app)
      .patch(`/api/v1/merchant/products/${productB}`)
      .set('Cookie', staffCookie)
      .send({ name: 'Hijacked' });
    expect(editB.status).toBe(404);
    const rowB = await sys.ctx.db.prepare('SELECT name FROM products WHERE id = ?').get(productB) as { name: string };
    expect(rowB.name).toBe('Product B');
    // Staff store context remains Store A
    const store = await request(sys.app).get('/api/v1/merchant/store').set('Cookie', staffCookie);
    expect(store.body.store.id).toBe(a.storeId);
  });

  it('MER-010: merchant store-setting changes create an audit event with actor/action/time', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    await request(sys.app).patch('/api/v1/merchant/store').set('Cookie', m.ownerCookie).send({ description: 'Audited change' });
    const audit = await sys.ctx.db
      .prepare(`SELECT * FROM audit_events WHERE action = 'store.updated' AND entity_id = ?`)
      .get(m.storeId) as { actor_id: string; action: string; created_at: string } | undefined;
    expect(audit).toBeTruthy();
    expect(audit!.actor_id).toBe(m.ownerUserId);
    expect(audit!.action).toBe('store.updated');
    expect(new Date(audit!.created_at).getTime()).toBeGreaterThan(0);
  });
});
