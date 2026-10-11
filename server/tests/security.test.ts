import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { system, register, login, request, makeUser, makeMerchant, addProduct, cartWith, purchase, type TestSystem } from './helpers.js';
import { createContext } from '../src/context.js';
/** Full Set-Cookie header text including attributes (unlike request-cookie extraction). */
function setCookieText(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return ((Array.isArray(raw) ? raw : raw ? [raw] : []) as string[]).join('; ');
}
import { createApp } from '../src/app.js';

// Security & privacy — UAT SEC-001..SEC-010
describe('SEC — Security & privacy controls', () => {
  let sys: TestSystem;
  beforeEach(() => { sys = system(); });
  afterEach(() => sys.close());

  it('SEC-001: SQL injection probes are handled safely (parameterized queries)', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const payloads = [
      "' OR '1'='1",
      "'; DROP TABLE products; --",
      "' UNION SELECT id, email, password_hash FROM users --",
      "1; DELETE FROM orders WHERE 1=1; --"
    ];
    for (const payload of payloads) {
      const search = await request(sys.app).get('/api/v1/products').query({ search: payload });
      expect(search.status).toBe(200);
      expect(search.headers['content-type']).toContain('application/json');
      // LIKE is literal — payload must not match everything
      expect(search.body.products).toHaveLength(0);
      const loginRes = await request(sys.app).post('/api/v1/auth/login')
        .send({ email: payload, password: 'whatever123' });
      expect([400, 401]).toContain(loginRes.status);
      const cat = await request(sys.app).get('/api/v1/products').query({ category: payload });
      expect(cat.status).toBe(200);
    }
    // Tables intact
    const tables = sys.ctx.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['products', 'orders', 'users']));
    const products = sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number };
    expect(products.c).toBe(1);
    const orderCount = sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number };
    expect(orderCount.c).toBe(0);
  });

  it('SEC-002: XSS payloads are never rendered as HTML by the API', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const xss = `<script>alert('xss')</script>`;
    const created = await request(sys.app).post('/api/v1/merchant/products')
      .set('Cookie', m.ownerCookie)
      .send({ name: xss, sku: 'XSS-1', price: 100, description: `<img src=x onerror=alert(1)>` });
    expect(created.status).toBe(201);
    await request(sys.app).post(`/api/v1/merchant/products/${created.body.product.id}/publish`).set('Cookie', m.ownerCookie);
    const view = await request(sys.app).get(`/api/v1/products/${created.body.product.id}`);
    // JSON content type — payload stays inert text, safely JSON-encoded
    expect(view.headers['content-type']).toContain('application/json');
    expect(view.headers['content-type']).not.toContain('text/html');
    expect(view.body.product.name).toBe(xss);
    // Search with script payload handled safely
    const search = await request(sys.app).get('/api/v1/products').query({ search: '<script>alert(1)</script>' });
    expect(search.status).toBe(200);
    // Registration/profile fields reject markup-free requirements but store safely as text
    const reg = await request(sys.app).post('/api/v1/auth/register')
      .send({ name: xss, email: 'xss@test.com', password: 'password123' });
    expect(reg.status).toBe(201);
    expect(reg.headers['content-type']).toContain('application/json');
    // The response is a JSON document (parseable), never an HTML document
    expect(() => JSON.parse(reg.text ?? '{}')).not.toThrow();
    expect(reg.text).toContain('xss@test.com');
  });

  it('SEC-003: IDOR probes across resources are denied', async () => {
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 50 });
    const amina = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const eric = await register(sys, { name: 'Eric', email: 'eric@test.com', password: 'password123' });
    const addr = await request(sys.app).post('/api/v1/addresses').set('Cookie', amina.cookie)
      .send({ name: 'Amina', line1: '12 KG St', city: 'Kigali' });
    const cartId = await cartWith(sys, amina.cookie, m.storeId, p, 1);
    const { orderId } = await purchase(sys, { cookie: amina.cookie, storeId: m.storeId, productId: p, paymentMethod: 'momo' });
    // Eric cannot touch Amina's address
    expect((await request(sys.app).patch(`/api/v1/addresses/${addr.body.address.id}`).set('Cookie', eric.cookie).send({ line1: 'x' })).status).toBe(404);
    expect((await request(sys.app).delete(`/api/v1/addresses/${addr.body.address.id}`).set('Cookie', eric.cookie)).status).toBe(404);
    // Eric cannot read/modify Amina's cart
    expect((await request(sys.app).get(`/api/v1/carts/${cartId}`).set('Cookie', eric.cookie)).status).toBe(404);
    expect((await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', eric.cookie).send({ productId: p, quantity: 1 })).status).toBe(404);
    // Eric cannot read or cancel Amina's order
    expect((await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', eric.cookie)).status).toBe(404);
    expect((await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`).set('Cookie', eric.cookie).send({})).status).toBe(404);
    // Eric cannot view Amina's payment
    const paymentId = (sys.ctx.db.prepare('SELECT id FROM payments WHERE order_id = ?').get(orderId) as { id: string }).id;
    expect((await request(sys.app).get(`/api/v1/payments/${paymentId}`).set('Cookie', eric.cookie)).status).toBe(404);
    expect((await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', eric.cookie).send({ result: 'success' })).status).toBe(404);
    // Amina's data unchanged
    expect((await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', amina.cookie)).status).toBe(200);
  });

  it('SEC-004: privilege escalation attempts are denied', async () => {
    // Registering with an elevated role in the payload is ignored
    const res = await request(sys.app).post('/api/v1/auth/register')
      .send({ name: 'Sneaky', email: 'sneaky@test.com', password: 'password123', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('customer');
    const row = sys.ctx.db.prepare('SELECT role FROM users WHERE email = ?').get('sneaky@test.com') as { role: string };
    expect(row.role).toBe('customer');
    // Customer cannot use admin or merchant surfaces
    expect((await request(sys.app).get('/api/v1/admin/merchants').set('Cookie', res.headers['set-cookie']![0].split(';')[0])).status).toBe(403);
    expect((await request(sys.app).post('/api/v1/admin/categories').set('Cookie', res.headers['set-cookie']![0].split(';')[0]).send({ name: 'X' })).status).toBe(403);
    expect((await request(sys.app).post('/api/v1/merchant/store').set('Cookie', res.headers['set-cookie']![0].split(';')[0]).send({ name: 'X' })).status).toBe(403);
    // Support role cannot escalate to admin
    makeUser(sys, { role: 'support', name: 'Support', email: 'support@test.com' });
    const sup = await login(sys, 'support@test.com', 'password123');
    expect((await request(sys.app).get('/api/v1/admin/merchants').set('Cookie', sup.cookie)).status).toBe(403);
    expect((await request(sys.app).post('/api/v1/admin/categories').set('Cookie', sup.cookie).send({ name: 'X' })).status).toBe(403);
  });

  it('SEC-005: session cookie security attributes are correct', async () => {
    // Development/test: HttpOnly + SameSite
    const dev = await request(sys.app).post('/api/v1/auth/login')
      .send({ email: 'nobody@test.com', password: 'password123' });
    // Even a failed login should not set insecure cookies; register to inspect a real one:
    const reg = await request(sys.app).post('/api/v1/auth/register')
      .send({ name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const setCookie = setCookieText(reg as unknown as { headers: Record<string, unknown> });
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('duka_sid=');
    // Production context: Secure flag is added
    const prodCtx = createContext({ file: ':memory:', env: 'production' });
    const prodApp = createApp(prodCtx);
    const prodReg = await request(prodApp).post('/api/v1/auth/register')
      .send({ name: 'Prod', email: 'prod@test.com', password: 'password123' });
    const prodCookie = setCookieText(prodReg as unknown as { headers: Record<string, unknown> });
    expect(prodCookie).toContain('Secure');
    expect(prodCookie).toContain('HttpOnly');
    prodCtx.close();
    expect(dev.status).toBe(401);
  });

  it('SEC-006: passwords never appear in logs', async () => {
    const reg = await request(sys.app).post('/api/v1/auth/register')
      .send({ name: 'Amina', email: 'amina@test.com', password: 'supersecret123' });
    expect(reg.status).toBe(201);
    await request(sys.app).post('/api/v1/auth/login')
      .send({ email: 'amina@test.com', password: 'supersecret123' });
    await request(sys.app).post('/api/v1/auth/login')
      .send({ email: 'amina@test.com', password: 'wrongpassword99' });
    const allLogs = JSON.stringify(sys.logs);
    expect(allLogs).not.toContain('supersecret123');
    expect(allLogs).not.toContain('wrongpassword99');
    expect(allLogs).not.toContain('scrypt');
    expect(allLogs).not.toMatch(/password_hash/);
    // Passwords are hashed at rest
    const row = sys.ctx.db.prepare('SELECT password_hash FROM users WHERE email = ?').get('amina@test.com') as { password_hash: string };
    expect(row.password_hash).not.toContain('supersecret123');
    expect(row.password_hash).toMatch(/^scrypt\$/);
  });

  it('SEC-007: no secrets are committed to the repository', () => {
    const repoRoot = resolve(__dirname, '../..');
    const secretPatterns = [
      /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
      /AKIA[0-9A-Z]{16}/,
      /ghp_[A-Za-z0-9]{36}/,
      /xox[baprs]-[A-Za-z0-9-]{10,}/
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && st.size < 512 * 1024 && !/\.(png|jpg|pdf|lock|sqlite)$/.test(entry)) {
          const content = readFileSync(full, 'utf8');
          for (const pattern of secretPatterns) {
            if (pattern.test(content)) offenders.push(`${full}: ${pattern}`);
          }
        }
      }
    };
    walk(repoRoot);
    expect(offenders).toEqual([]);
    // No committed .env with real values
    expect(existsSync(join(repoRoot, '.env'))).toBe(false);
    // The webhook secret comes from the environment with a sandbox placeholder default
    const contextSource = readFileSync(join(repoRoot, 'server/src/context.ts'), 'utf8');
    expect(contextSource).toContain('process.env.PAYMENT_WEBHOOK_SECRET');
  });

  it('SEC-008: authentication endpoint is rate limited', async () => {
    await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const res = await request(sys.app).post('/api/v1/auth/login')
        .send({ email: 'amina@test.com', password: 'badpassword1' });
      if (res.status === 429) {
        sawLimit = true;
        expect(res.body.code).toBe('RATE_LIMITED');
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(sawLimit).toBe(true);
    // Even the correct password is refused while locked
    const correct = await request(sys.app).post('/api/v1/auth/login')
      .send({ email: 'amina@test.com', password: 'password123' });
    expect(correct.status).toBe(429);
    // Registration is unaffected by the login lockout
    const other = await request(sys.app).post('/api/v1/auth/register')
      .send({ name: 'Other', email: 'other@test.com', password: 'password123' });
    expect(other.status).toBe(201);
  });

  it('SEC-009: admin routes are protected from non-admin callers', async () => {
    makeUser(sys, { role: 'admin', name: 'Admin', email: 'admin@test.com' });
    const adminSession = await login(sys, 'admin@test.com', 'password123');
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    makeUser(sys, { role: 'support', name: 'Support', email: 'support@test.com' });
    const support = await login(sys, 'support@test.com', 'password123');
    const m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    const adminRoutesList = [
      '/api/v1/admin/merchants',
      '/api/v1/admin/stores',
      '/api/v1/admin/products',
      '/api/v1/admin/categories',
      '/api/v1/admin/orders',
      '/api/v1/admin/payments',
      '/api/v1/admin/audit',
      '/api/v1/admin/reports/overview',
      '/api/v1/admin/users'
    ];
    for (const route of adminRoutesList) {
      const anon = await request(sys.app).get(route);
      expect(anon.status, `anon ${route}`).toBe(401);
      const asCustomer = await request(sys.app).get(route).set('Cookie', customer.cookie);
      expect(asCustomer.status, `customer ${route}`).toBe(403);
      const asSupport = await request(sys.app).get(route).set('Cookie', support.cookie);
      expect(asSupport.status, `support ${route}`).toBe(403);
      const asMerchant = await request(sys.app).get(route).set('Cookie', m.ownerCookie);
      expect(asMerchant.status, `merchant ${route}`).toBe(403);
      const asAdmin = await request(sys.app).get(route).set('Cookie', adminSession.cookie);
      expect(asAdmin.status, `admin ${route}`).toBe(200);
    }
  });

  it('SEC-010: merchant data isolation holds across all cross-access attempts (Critical)', async () => {
    const a = await makeMerchant(sys, { ownerEmail: 'a@test.com', storeName: 'Store A' });
    const b = await makeMerchant(sys, { ownerEmail: 'b@test.com', storeName: 'Store B' });
    const productB = addProduct(sys, { storeId: b.storeId, sku: 'B-001', name: 'Product B', price: 5000, stock: 20 });
    const productA = addProduct(sys, { storeId: a.storeId, sku: 'A-001', name: 'Product A', price: 9000, stock: 20 });
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const orderB = await purchase(sys, { cookie: customer.cookie, storeId: b.storeId, productId: productB, paymentMethod: 'cod' });
    // A's queue contains only A's orders
    const queueA = await request(sys.app).get('/api/v1/merchant/orders').set('Cookie', a.ownerCookie);
    expect(queueA.body.orders).toHaveLength(0);
    // Direct access to B's order denied
    expect((await request(sys.app).get(`/api/v1/merchant/orders/${orderB.orderId}`).set('Cookie', a.ownerCookie)).status).toBe(404);
    expect((await request(sys.app).post(`/api/v1/merchant/orders/${orderB.orderId}/accept`).set('Cookie', a.ownerCookie)).status).toBe(404);
    // Mutating B's product denied
    expect((await request(sys.app).patch(`/api/v1/merchant/products/${productB}`).set('Cookie', a.ownerCookie).send({ price: 1 })).status).toBe(404);
    expect((await request(sys.app).post(`/api/v1/merchant/products/${productB}/publish`).set('Cookie', a.ownerCookie)).status).toBe(404);
    expect((await request(sys.app).post('/api/v1/merchant/inventory/adjustments').set('Cookie', a.ownerCookie).send({ productId: productB, delta: -5 })).status).toBe(404);
    // B's data untouched
    const rowB = sys.ctx.db.prepare('SELECT price FROM products WHERE id = ?').get(productB) as { price: number };
    expect(rowB.price).toBe(5000);
    const stockB = sys.ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(productB) as { quantity: number };
    expect(stockB.quantity).toBe(19);
    // A sees its own store context only
    const storeA = await request(sys.app).get('/api/v1/merchant/store').set('Cookie', a.ownerCookie);
    expect(storeA.body.store.id).toBe(a.storeId);
    const inventoryA = await request(sys.app).get('/api/v1/merchant/inventory').set('Cookie', a.ownerCookie);
    expect(inventoryA.body.inventory.every((i: { product_id: string }) => i.product_id === productA)).toBe(true);
  });
});
