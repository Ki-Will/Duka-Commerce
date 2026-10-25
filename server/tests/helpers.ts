import request from 'supertest';
import { Client } from 'pg';
import { createContext, type AppCtx, type LogRecord } from '../src/context.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/services/auth.js';
import { uuid, now, j, type Db } from '../src/db/index.js';

export interface TestSystem {
  ctx: AppCtx;
  app: ReturnType<typeof createApp>;
  logs: LogRecord[];
  close(): void | Promise<void>;
}

/**
 * Neon test runs (`DUKA_TEST_DRIVER=postgres`): give each vitest worker its
 * own database so test files can run in parallel without truncating each
 * other — and so the app's seeded `neondb` is never touched. Runs at module
 * load (top-level await) before any `system()` can open a connection.
 */
if (process.env.DUKA_TEST_DRIVER === 'postgres' && process.env.DATABASE_URL) {
  const testDb = `duka_test_${process.env.VITEST_WORKER_ID ?? '1'}`;
  const retarget = (value: string | undefined): string | undefined => {
    if (!value) return value;
    const u = new URL(value);
    const hadDb = u.pathname && u.pathname !== '/';
    u.pathname = `/${testDb}`;
    return hadDb ? u.toString() : value;
  };
  // Create the worker database if it does not exist yet (idempotent).
  const base = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  const client = new Client({ connectionString: base, connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${testDb}`);
  } catch (err) {
    if (!/already exists/i.test(String(err))) throw err;
  } finally {
    await client.end();
  }
  process.env.DATABASE_URL = retarget(process.env.DATABASE_URL);
  process.env.DATABASE_URL_UNPOOLED = retarget(process.env.DATABASE_URL_UNPOOLED);
}

/**
 * Fresh app + database per test.
 * Default: hermetic in-memory SQLite (fast, offline).
 * `DUKA_TEST_DRIVER=postgres` runs the same suite against Neon Postgres —
 * each vitest worker gets its own database (created above) and shares one
 * connection pool for the whole worker, because a pool + schema probe per
 * test would dominate Neon latency and flood the pooler when files run in
 * parallel. Every test still gets its own context/app/logs, and a
 * guaranteed-empty database via the chained truncate.
 */
let sharedDb: Db | null = null;
const TRUNCATE_ALL = `
  DO $$ DECLARE t text;
  BEGIN
    SELECT string_agg(format('%I', tablename), ',') INTO t
      FROM pg_tables WHERE schemaname = 'public';
    IF t IS NOT NULL THEN
      EXECUTE format('TRUNCATE TABLE %s RESTART IDENTITY CASCADE', t);
    END IF;
  END $$;
`;

export function system(): TestSystem {
  const logs: LogRecord[] = [];
  if (process.env.DUKA_TEST_DRIVER === 'postgres') {
    sharedDb ??= createContext({ driver: 'postgres', env: 'test' }).db;
    const ctx = createContext({ db: sharedDb, env: 'test', logs });
    // Runs before this test's first query; later tests chain behind it.
    ctx.db.init(async () => {
      await ctx.db.exec(TRUNCATE_ALL);
    });
    const app = createApp(ctx);
    // The shared pool outlives the test (closed when the worker exits).
    return { ctx, app, logs, close: () => undefined };
  }
  const ctx = createContext({ file: ':memory:', env: 'test', logs });
  const app = createApp(ctx);
  return { ctx, app, logs, close: () => ctx.close() };
}

export function cookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

export async function register(
  sys: TestSystem,
  user: { name: string; email: string; password: string; phone?: string }
): Promise<{ cookie: string; id: string; role: string }> {
  const res = await request(sys.app).post('/api/v1/auth/register').send(user);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    cookie: cookieHeader(res),
    id: res.body.user.id,
    role: res.body.user.role
  };
}

export async function login(sys: TestSystem, email: string, password: string) {
  const res = await request(sys.app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    cookie: cookieHeader(res),
    user: res.body.user
  };
}

/** Create a user directly with a chosen role (admin/support/staff fixtures). */
export async function makeUser(sys: TestSystem, opts: {
  role: 'customer' | 'staff' | 'manager' | 'owner' | 'support' | 'admin';
  name: string;
  email: string;
  password?: string;
  phone?: string | null;
}): Promise<string> {
  const id = uuid();
  await sys.ctx.db
    .prepare(
      `INSERT INTO users (id, role, name, email, phone, password_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(id, opts.role, opts.name, opts.email, opts.phone ?? null, hashPassword(opts.password ?? 'password123'), now());
  return id;
}

export async function makeCategory(sys: TestSystem, name: string): Promise<string> {
  const id = uuid();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await sys.ctx.db.prepare('INSERT INTO categories (id, name, slug, parent_id, created_at) VALUES (?, ?, ?, NULL, ?)').run(id, name, slug, now());
  return id;
}

export interface MerchantFixture {
  merchantId: string;
  storeId: string;
  ownerUserId: string;
  ownerCookie: string;
}

/** Approved merchant + open store + owner session. */
export async function makeMerchant(sys: TestSystem, opts: { ownerEmail: string; storeName: string; name?: string }): Promise<MerchantFixture> {
  const ownerUserId = await makeUser(sys, {
    role: 'customer',
    name: opts.name ?? 'Merchant Owner',
    email: opts.ownerEmail
  });
  const merchantId = uuid();
  const ts = now();
  await sys.ctx.db
    .prepare(
      `INSERT INTO merchants (id, owner_user_id, business_name, contact_email, contact_phone, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'approved', ?, ?)`
    )
    .run(merchantId, ownerUserId, opts.storeName + ' Ltd', opts.ownerEmail, ts, ts);
  // Approval promotes the applicant to owner (mirrors admin approve flow).
  await sys.ctx.db.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(ownerUserId);
  const storeId = uuid();
  const slug = opts.storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await sys.ctx.db
    .prepare(
      `INSERT INTO stores (id, merchant_id, name, slug, description, contact, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', 'open', ?, ?)`
    )
    .run(storeId, merchantId, opts.storeName, slug, ts, ts);
  const session = await login(sys, opts.ownerEmail, 'password123');
  return { merchantId, storeId, ownerUserId, ownerCookie: session.cookie };
}

export async function addProduct(sys: TestSystem, opts: {
  storeId: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  status?: 'draft' | 'published' | 'unpublished' | 'suspended' | 'archived';
  categoryId?: string | null;
  threshold?: number;
}): Promise<string> {
  const id = uuid();
  const ts = now();
  await sys.ctx.db
    .prepare(
      `INSERT INTO products (id, store_id, category_id, sku, name, description, price, image_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, '', ?, ?, ?)`
    )
    .run(id, opts.storeId, opts.categoryId ?? null, opts.sku, opts.name, opts.price, opts.status ?? 'published', ts, ts);
  await sys.ctx.db.prepare('INSERT INTO inventory_items (product_id, quantity, low_stock_threshold) VALUES (?, ?, ?)').run(id, opts.stock, opts.threshold ?? 5);
  if (opts.stock > 0) {
    await sys.ctx.db
      .prepare(`INSERT INTO inventory_movements (id, product_id, delta, reason, actor_id, order_id, created_at) VALUES (?, ?, ?, 'initial_stock', NULL, NULL, ?)`)
      .run(uuid(), id, opts.stock, ts);
  }
  return id;
}

export async function addAddress(sys: TestSystem, userId: string): Promise<string> {
  const id = uuid();
  await sys.ctx.db
    .prepare(
      `INSERT INTO addresses (id, user_id, label, name, line1, line2, city, phone, is_default, created_at)
       VALUES (?, ?, 'Home', 'Test User', '123 KG St', '', 'Kigali', '', 1, ?)`
    )
    .run(id, userId, now());
  return id;
}

export async function cartWith(sys: TestSystem, cookie: string, storeId: string, productId: string, quantity = 1): Promise<string> {
  const cartRes = await request(sys.app)
    .post('/api/v1/carts')
    .set('Cookie', cookie)
    .send({ storeId });
  const cartId = cartRes.body.cart.id;
  const addRes = await request(sys.app)
    .post(`/api/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .send({ productId, quantity });
  if (addRes.status !== 201) throw new Error(`add to cart failed: ${addRes.status} ${JSON.stringify(addRes.body)}`);
  return cartId;
}

/** Full happy-path purchase up to a Confirmed order (MoMo success). */
export async function purchase(sys: TestSystem, opts: {
  cookie: string;
  storeId: string;
  productId: string;
  quantity?: number;
  paymentMethod?: 'momo' | 'card' | 'cod';
  deliveryMethod?: 'delivery' | 'pickup';
  addressId?: string | null;
  idempotencyKey?: string;
}): Promise<{ orderId: string; orderNumber: string; paymentId: string | null; cartId: string }> {
  const cartId = await cartWith(sys, opts.cookie, opts.storeId, opts.productId, opts.quantity ?? 1);
  const orderRes = await request(sys.app)
    .post('/api/v1/orders')
    .set('Cookie', opts.cookie)
    .send({
      cartId,
      addressId: opts.addressId ?? null,
      deliveryMethod: opts.deliveryMethod ?? 'pickup',
      paymentMethod: opts.paymentMethod ?? 'momo',
      idempotencyKey: opts.idempotencyKey
    });
  if (orderRes.status !== 201) throw new Error(`checkout failed: ${orderRes.status} ${JSON.stringify(orderRes.body)}`);
  const orderId = orderRes.body.order.id;
  let paymentId: string | null = orderRes.body.payment?.id ?? null;
  if (paymentId) {
    const sim = await request(sys.app)
      .post(`/api/v1/payments/${paymentId}/simulate`)
      .set('Cookie', opts.cookie)
      .send({ result: 'success' });
    if (sim.status !== 200) throw new Error(`payment simulate failed: ${sim.status} ${JSON.stringify(sim.body)}`);
  }
  return { orderId, orderNumber: orderRes.body.order.order_number, paymentId, cartId };
}

export async function orderState(sys: TestSystem, orderId: string): Promise<string> {
  const row = await sys.ctx.db.prepare('SELECT state FROM orders WHERE id = ?').get(orderId) as { state: string } | undefined;
  return row?.state ?? 'missing';
}

export async function paymentState(sys: TestSystem, paymentId: string): Promise<string> {
  const row = await sys.ctx.db.prepare('SELECT state FROM payments WHERE id = ?').get(paymentId) as { state: string } | undefined;
  return row?.state ?? 'missing';
}

export async function stockOf(sys: TestSystem, productId: string): Promise<number> {
  const row = await sys.ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(productId) as
    | { quantity: number }
    | undefined;
  return row?.quantity ?? -1;
}

export { request, uuid, now, j };
