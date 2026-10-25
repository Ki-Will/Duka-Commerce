import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { system, register, login, request, makeUser, makeMerchant, addProduct, cartWith, purchase, type TestSystem } from './helpers.js';

// Authentication & customer accounts — UAT AU-001..AU-008, CUS-001..CUS-005
describe('AU/CUS — Authentication & customer accounts', () => {
  let sys: TestSystem;
  beforeEach(() => { sys = system(); });
  afterEach(() => sys.close());

  it('AU-001: customer registration succeeds with a safe confirmation', async () => {
    const res = await request(sys.app).post('/api/v1/auth/register').send({
      name: 'Amina Test', email: 'amina@test.com', phone: '0788000001', password: 'password123'
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('amina@test.com');
    expect(res.body.user.role).toBe('customer');
    expect(res.headers['set-cookie']?.[0]).toContain('duka_sid');
    expect(JSON.stringify(res.body)).not.toContain('password');
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
  });

  it('AU-002: duplicate email/phone is rejected without leaking unnecessary data', async () => {
    await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123', phone: '0788000001' });
    const dupEmail = await request(sys.app).post('/api/v1/auth/register').send({
      name: 'Imposter', email: 'amina@test.com', password: 'password123'
    });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.code).toBe('ACCOUNT_EXISTS');
    expect(JSON.stringify(dupEmail.body)).not.toContain('password123');
    const dupPhone = await request(sys.app).post('/api/v1/auth/register').send({
      name: 'Imposter 2', email: 'other@test.com', phone: '0788000001', password: 'password123'
    });
    expect(dupPhone.status).toBe(409);
  });

  it('AU-003: invalid login produces a generic error with no account-existence leak', async () => {
    await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const wrongPass = await request(sys.app).post('/api/v1/auth/login').send({ email: 'amina@test.com', password: 'wrongpass99' });
    const noAccount = await request(sys.app).post('/api/v1/auth/login').send({ email: 'ghost@test.com', password: 'whatever123' });
    expect(wrongPass.status).toBe(401);
    expect(noAccount.status).toBe(401);
    expect(wrongPass.body.message).toBe(noAccount.body.message);
    expect(wrongPass.body.message).toBe('Invalid email or password.');
  });

  it('AU-004: repeated authentication failures trigger rate limiting / lockout', async () => {
    await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    for (let i = 0; i < 5; i++) {
      const fail = await request(sys.app).post('/api/v1/auth/login').send({ email: 'amina@test.com', password: 'wrongpass99' });
      expect(fail.status).toBe(401);
    }
    const locked = await request(sys.app).post('/api/v1/auth/login').send({ email: 'amina@test.com', password: 'password123' });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('RATE_LIMITED');
  });

  it('AU-005: successful login creates a session usable on protected routes', async () => {
    await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const { cookie } = await login(sys, 'amina@test.com', 'password123');
    const me = await request(sys.app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('amina@test.com');
  });

  it('AU-006: logout invalidates the active session', async () => {
    const { cookie } = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const out = await request(sys.app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    const me = await request(sys.app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });

  it('AU-007: expired session is denied safely', async () => {
    const { cookie, id } = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    await sys.ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run('2000-01-01T00:00:00.000Z', id);
    const me = await request(sys.app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });

  it('AU-008: a customer cannot view another customer\'s order', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const product = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 100 });
    const amina = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const eric = await register(sys, { name: 'Eric', email: 'eric@test.com', password: 'password123' });
    const { orderId, orderNumber } = await purchase(sys, { cookie: amina.cookie, storeId: m.storeId, productId: product });
    const forbidden = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', eric.cookie);
    expect([403, 404]).toContain(forbidden.status);
    expect(JSON.stringify(forbidden.body)).not.toContain(orderNumber);
    const own = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', amina.cookie);
    expect(own.status).toBe(200);
  });

  it('CUS-001: customer updates own profile', async () => {
    const { cookie, id } = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const res = await request(sys.app).patch('/api/v1/profile').set('Cookie', cookie).send({ name: 'Amina Updated', phone: '0788111222' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Amina Updated');
    expect(res.body.user.phone).toBe('0788111222');
    const row = await sys.ctx.db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string };
    expect(row.name).toBe('Amina Updated');
  });

  it('CUS-002/003: customer creates and edits delivery addresses (own only)', async () => {
    const { cookie, id } = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const create = await request(sys.app).post('/api/v1/addresses').set('Cookie', cookie).send({
      name: 'Amina', line1: '12 KG St', city: 'Kigali', phone: '0788'
    });
    expect(create.status).toBe(201);
    const addrId = create.body.address.id;
    const edit = await request(sys.app).patch(`/api/v1/addresses/${addrId}`).set('Cookie', cookie).send({ line1: '45 KN Ave' });
    expect(edit.status).toBe(200);
    expect(edit.body.address.line1).toBe('45 KN Ave');
    const row = await sys.ctx.db.prepare('SELECT line1 FROM addresses WHERE id = ?').get(addrId) as { line1: string };
    expect(row.line1).toBe('45 KN Ave');
    const other = await register(sys, { name: 'Eric', email: 'eric@test.com', password: 'password123' });
    const denied = await request(sys.app).patch(`/api/v1/addresses/${addrId}`).set('Cookie', other.cookie).send({ line1: 'Hacked' });
    expect(denied.status).toBe(404);
    expect(row.line1).toBe('45 KN Ave');
  });

  it('CUS-004: customer sees only their own orders', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const product = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 50 });
    const amina = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const eric = await register(sys, { name: 'Eric', email: 'eric@test.com', password: 'password123' });
    await purchase(sys, { cookie: amina.cookie, storeId: m.storeId, productId: product });
    const ericOrders = await request(sys.app).get('/api/v1/orders').set('Cookie', eric.cookie);
    expect(ericOrders.status).toBe(200);
    expect(ericOrders.body.orders).toHaveLength(0);
    const aminaOrders = await request(sys.app).get('/api/v1/orders').set('Cookie', amina.cookie);
    expect(aminaOrders.body.orders).toHaveLength(1);
    expect(aminaOrders.body.orders[0].customer_id).toBe(amina.id);
  });

  it('CUS-005: customer cannot access the merchant console', async () => {
    const { cookie } = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const res = await request(sys.app).get('/api/v1/merchant/store').set('Cookie', cookie);
    expect(res.status).toBe(403);
    const products = await request(sys.app).get('/api/v1/merchant/products').set('Cookie', cookie);
    expect(products.status).toBe(403);
  });

  it('unauthenticated requests to protected routes are rejected', async () => {
    const res = await request(sys.app).get('/api/v1/orders');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });
});
