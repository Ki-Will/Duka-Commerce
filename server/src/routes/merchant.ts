import { Router, type Request, type Response } from 'express';
import type { AppCtx } from '../context.js';
import { uuid, now, j, tx, type SqlParam } from '../db/index.js';
import { errors } from '../domain/errors.js';
import { requireAuth } from '../middleware.js';
import { canAccessMerchantConsole, DEFAULT_STAFF_PERMS, MANAGER_PERMS, type StorePerm } from '../domain/permissions.js';
import { requirePerm, requireStoreAccess, type StoreAccess } from '../services/access.js';
import { hashPassword } from '../services/auth.js';
import { audit } from '../services/audit.js';
import { applyTransition, orderSummary } from '../services/orders.js';
import { changeStock, inventoryView } from '../services/inventory.js';
import { canProductTransition, type ProductStatus } from '../domain/productState.js';
import { getOrderRow } from '../services/checkout.js';
import { requestRefund, completeRefund } from '../services/payments/processor.js';

/** CAT-008: image input validation (supported format, bounded size). */
function validImageUrl(url: string): boolean {
  if (url === '') return true;
  return /^https?:\/\/[^\s]+$/.test(url) && url.length <= 300;
}

const VALID_PERMS: StorePerm[] = ['store:write', 'staff:write', 'catalogue:write', 'inventory:write', 'orders:write', 'reports:read'];

/** Resolve the caller's single operational store (Phase 1: one store per merchant). */
function resolveStore(ctx: AppCtx, req: Request): StoreAccess {
  const user = req.user!;
  if (user.role === 'owner') {
    const merchant = ctx.db.prepare('SELECT id FROM merchants WHERE owner_user_id = ?').get(user.id) as
      | { id: string }
      | undefined;
    if (!merchant) throw errors.forbidden('No merchant account found.');
    const store = ctx.db.prepare('SELECT id FROM stores WHERE merchant_id = ?').get(merchant.id) as { id: string } | undefined;
    if (!store) throw errors.notFound('No store exists yet. Create your store first.');
    return requireStoreAccess(ctx, user, store.id);
  }
  if (user.role === 'manager' || user.role === 'staff') {
    const row = ctx.db.prepare('SELECT store_id FROM store_staff WHERE user_id = ? LIMIT 1').get(user.id) as
      | { store_id: string }
      | undefined;
    if (!row) throw errors.forbidden('You are not assigned to a store.');
    return requireStoreAccess(ctx, user, row.store_id);
  }
  throw errors.forbidden('Merchant console access requires a merchant role.');
}

function productInStore(ctx: AppCtx, productId: string, storeId: string) {
  const product = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
    | { id: string; store_id: string; status: string }
    | undefined;
  if (!product || product.store_id !== storeId) {
    // SEC-010 / CAT-014 / ORD-014: cross-tenant access is denied, not leaked.
    throw errors.notFound('Product not found.');
  }
  return product;
}

export function merchantRoutes(ctx: AppCtx): Router {
  const r = Router();

  // ---------- merchant onboarding (UC-DC-08, FR-MER-01) ----------
  r.post('/merchants/apply', requireAuth, (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (!b.businessName || !b.contactEmail) throw errors.validation('businessName and contactEmail are required.');
    const existing = ctx.db.prepare('SELECT * FROM merchants WHERE owner_user_id = ?').get(req.user!.id);
    if (existing) throw errors.conflict('APPLICATION_EXISTS', 'You already have a merchant application.');
    const id = uuid();
    ctx.db
      .prepare(
        `INSERT INTO merchants (id, owner_user_id, business_name, contact_email, contact_phone, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(id, req.user!.id, b.businessName, b.contactEmail, b.contactPhone ?? null, now(), now());
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'merchant.applied', entity: 'merchant', entityId: id, traceId: req.traceId });
    res.status(201).json({ merchant: ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) });
  });

  r.get('/merchants/mine', requireAuth, (req: Request, res: Response) => {
    const merchant = ctx.db.prepare('SELECT * FROM merchants WHERE owner_user_id = ?').get(req.user!.id);
    const store = merchant
      ? (ctx.db.prepare('SELECT * FROM stores WHERE merchant_id = ?').get((merchant as { id: string }).id) ?? null)
      : null;
    res.json({ merchant: merchant ?? null, store });
  });

  // Everything below: merchant console only (CUS-005 / SEC-004).
  r.use('/merchant', requireAuth);

  r.get('/merchant/store', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    const store = ctx.db.prepare('SELECT * FROM stores WHERE id = ?').get(access.storeId);
    const merchant = ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(access.merchantId);
    res.json({ store, merchant, access: { role: access.role, perms: access.perms } });
  });

  /** MER-004: approved merchant creates their store. */
  r.post('/merchant/store', (req: Request, res: Response) => {
    const user = req.user!;
    if (!canAccessMerchantConsole(user.role) && user.role !== 'customer') throw errors.forbidden();
    const merchant = ctx.db.prepare('SELECT * FROM merchants WHERE owner_user_id = ?').get(user.id) as
      | { id: string; status: string }
      | undefined;
    if (!merchant) throw errors.forbidden('Apply for a merchant account first.');
    if (merchant.status !== 'approved') throw errors.forbidden('Your merchant application is not approved yet.');
    const existing = ctx.db.prepare('SELECT id FROM stores WHERE merchant_id = ?').get(merchant.id);
    if (existing) throw errors.conflict('STORE_EXISTS', 'You already have a store.');
    const b = (req.body ?? {}) as Record<string, string>;
    if (!b.name || b.name.trim().length < 2) throw errors.validation('Store name is required.');
    const id = uuid();
    const slug =
      (b.name || 'store')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') + `-${id.slice(0, 6)}`;
    const ts = now();
    ctx.db
      .prepare(
        `INSERT INTO stores (id, merchant_id, name, slug, description, contact, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(id, merchant.id, b.name.trim(), slug, b.description ?? '', b.contact ?? '', ts, ts);
    audit(ctx, { actorId: user.id, actorRole: user.role, action: 'store.created', entity: 'store', entityId: id, traceId: req.traceId });
    res.status(201).json({ store: ctx.db.prepare('SELECT * FROM stores WHERE id = ?').get(id) });
  });

  r.patch('/merchant/store', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'store:write');
    const b = (req.body ?? {}) as Record<string, string>;
    const fields = ['name', 'description', 'contact', 'logo_url', 'banner_url'];
    const updated: Record<string, string> = {};
    for (const f of fields) {
      if (b[f] !== undefined) {
        ctx.db.prepare(`UPDATE stores SET ${f} = ?, updated_at = ? WHERE id = ?`).run(b[f], now(), access.storeId);
        updated[f] = b[f];
      }
    }
    // MER-007 / FR-MER-07: store profile changes audited.
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'store.updated', entity: 'store', entityId: access.storeId, detail: updated, traceId: req.traceId });
    res.json({ store: ctx.db.prepare('SELECT * FROM stores WHERE id = ?').get(access.storeId) });
  });

  /** MER-006: store operating status. Suspended stores cannot accept orders (BR-07). */
  r.patch('/merchant/store/status', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'store:write');
    const { status } = (req.body ?? {}) as { status?: string };
    if (!['open', 'closed'].includes(status ?? '')) throw errors.validation('status must be open or closed.');
    ctx.db.prepare('UPDATE stores SET status = ?, updated_at = ? WHERE id = ?').run(status!, now(), access.storeId);
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'store.status_changed', entity: 'store', entityId: access.storeId, detail: { status }, traceId: req.traceId });
    res.json({ store: ctx.db.prepare('SELECT * FROM stores WHERE id = ?').get(access.storeId) });
  });

  // ---------- catalogue (UC-DC-10, FR-CAT-*) ----------
  r.get('/merchant/products', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    const products = ctx.db
      .prepare(
        `SELECT p.*, COALESCE(i.quantity, 0) AS quantity, i.low_stock_threshold, c.name AS category_name
         FROM products p
         LEFT JOIN inventory_items i ON i.product_id = p.id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.store_id = ? ORDER BY p.updated_at DESC`
      )
      .all(access.storeId);
    res.json({ products });
  });

  /** CAT-001: valid product saved as draft. */
  r.post('/merchant/products', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'catalogue:write');
    const b = (req.body ?? {}) as Record<string, unknown> & { price?: number; quantity?: number };
    if (!b.name || typeof b.name !== 'string' || b.name.trim().length < 2) throw errors.validation('Product name is required.');
    if (!b.sku || typeof b.sku !== 'string' || !b.sku.trim()) throw errors.validation('SKU is required.');
    // CAT-003: price validation.
    if (!Number.isInteger(b.price) || (b.price as number) < 0) throw errors.validation('Price must be a non-negative integer amount.');
    const quantity = b.quantity === undefined ? 0 : Number(b.quantity);
    if (!Number.isInteger(quantity) || quantity < 0) throw errors.validation('quantity must be a non-negative integer.');
    if (b.imageUrl !== undefined && !validImageUrl(String(b.imageUrl))) {
      throw errors.validation('Image must be a valid http(s) URL of at most 300 characters.');
    }
    const dup = ctx.db.prepare('SELECT id FROM products WHERE store_id = ? AND sku = ?').get(access.storeId, String(b.sku));
    if (dup) throw errors.conflict('SKU_EXISTS', 'A product with this SKU already exists in your store.');
    const id = uuid();
    const ts = now();
    tx(ctx.db, () => {
      ctx.db
        .prepare(
          `INSERT INTO products (id, store_id, category_id, sku, name, description, price, image_url, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
        )
        .run(
          id,
          access.storeId,
          (b.categoryId as string) || null,
          String(b.sku).trim(),
          String(b.name).trim(),
          String(b.description ?? ''),
          b.price as number,
          String(b.imageUrl ?? ''),
          ts,
          ts
        );
      ctx.db.prepare('INSERT INTO inventory_items (product_id, quantity, low_stock_threshold) VALUES (?, ?, ?)').run(
        id,
        quantity,
        Number(b.lowStockThreshold ?? 5)
      );
      if (quantity > 0) {
        ctx.db
          .prepare(`INSERT INTO inventory_movements (id, product_id, delta, reason, actor_id, order_id, created_at) VALUES (?, ?, ?, 'initial_stock', ?, NULL, ?)`)
          .run(uuid(), id, quantity, req.user!.id, ts);
      }
    });
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'product.created', entity: 'product', entityId: id, traceId: req.traceId });
    res.status(201).json({ product: ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
  });

  r.patch('/merchant/products/:productId', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'catalogue:write');
    const product = productInStore(ctx, req.params.productId, access.storeId);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.price !== undefined && (!Number.isInteger(b.price) || (b.price as number) < 0)) {
      throw errors.validation('Price must be a non-negative integer amount.');
    }
    if (b.imageUrl !== undefined && !validImageUrl(String(b.imageUrl))) {
      throw errors.validation('Image must be a valid http(s) URL of at most 300 characters.');
    }
    const map: Record<string, string> = { name: 'name', description: 'description', sku: 'sku', imageUrl: 'image_url', categoryId: 'category_id' };
    const updated: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) {
        ctx.db.prepare(`UPDATE products SET ${col} = ?, updated_at = ? WHERE id = ?`).run(b[key] as string, now(), product.id);
        updated[key] = b[key];
      }
    }
    if (b.price !== undefined) {
      ctx.db.prepare('UPDATE products SET price = ?, updated_at = ? WHERE id = ?').run(b.price as number, now(), product.id);
      updated.price = b.price;
    }
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'product.updated', entity: 'product', entityId: product.id, detail: updated, traceId: req.traceId });
    res.json({ product: ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(product.id) });
  });

  // CAT-004/005 — publication state machine (SRS §11.3).
  r.post('/merchant/products/:productId/:action(publish|unpublish|archive)', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'catalogue:write');
    const product = productInStore(ctx, req.params.productId, access.storeId);
    const target: ProductStatus =
      req.params.action === 'publish' ? 'published' : req.params.action === 'unpublish' ? 'unpublished' : 'archived';
    if (!canProductTransition(product.status as ProductStatus, target)) {
      throw errors.badRequest('ILLEGAL_PRODUCT_TRANSITION', `Cannot move product from ${product.status} to ${target}.`);
    }
    ctx.db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(target, now(), product.id);
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: `product.${req.params.action}`, entity: 'product', entityId: product.id, detail: { from: product.status, to: target }, traceId: req.traceId });
    res.json({ product: ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(product.id) });
  });

  // ---------- inventory (UC-DC-11, FR-INV-*) ----------
  r.get('/merchant/inventory', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    res.json({ inventory: inventoryView(ctx, access.storeId) });
  });

  r.post('/merchant/inventory/adjustments', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    // INV-003: staff without the inventory permission is denied.
    requirePerm(access, 'inventory:write');
    const { productId, delta, reason } = (req.body ?? {}) as { productId?: string; delta?: number; reason?: string };
    if (!productId || !Number.isInteger(delta) || delta === 0) {
      throw errors.validation('productId and a non-zero integer delta are required.');
    }
    productInStore(ctx, productId, access.storeId);
    const quantity = changeStock(ctx, {
      productId,
      delta: delta as number,
      reason: reason ?? 'manual_adjustment',
      actorId: req.user!.id
    });
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'inventory.adjusted', entity: 'product', entityId: productId, detail: { delta, reason: reason ?? 'manual_adjustment' }, traceId: req.traceId });
    res.json({ productId, quantity });
  });

  r.patch('/merchant/inventory/:productId', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'inventory:write');
    const { lowStockThreshold } = (req.body ?? {}) as { lowStockThreshold?: number };
    productInStore(ctx, req.params.productId, access.storeId);
    if (!Number.isInteger(lowStockThreshold) || (lowStockThreshold as number) < 0) {
      throw errors.validation('lowStockThreshold must be a non-negative integer.');
    }
    ctx.db.prepare('UPDATE inventory_items SET low_stock_threshold = ? WHERE product_id = ?').run(lowStockThreshold!, req.params.productId);
    res.json({ productId: req.params.productId, lowStockThreshold });
  });

  // ---------- order processing (UC-DC-12/13, FR-ORD-08) ----------
  r.get('/merchant/orders', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    const state = String(req.query.state ?? '');
    const params: SqlParam[] = [access.storeId];
    let where = 'o.store_id = ?';
    if (state) {
      where += ' AND o.state = ?';
      params.push(state);
    }
    const orders = ctx.db
      .prepare(
        `SELECT o.*, u.name AS customer_name FROM orders o JOIN users u ON u.id = o.customer_id
         WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`
      )
      .all(...params);
    res.json({ orders });
  });

  r.get('/merchant/orders/:orderId', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order || order.store_id !== access.storeId) throw errors.notFound('Order not found.');
    res.json({ order: orderSummary(ctx, order) });
  });

  r.post('/merchant/orders/:orderId/accept', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'orders:write');
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order || order.store_id !== access.storeId) throw errors.notFound('Order not found.');
    const updated = applyTransition(ctx, { orderId: order.id, to: 'Accepted', actor: 'merchant', actorId: req.user!.id, actorRole: req.user!.role, traceId: req.traceId });
    res.json({ order: orderSummary(ctx, updated) });
  });

  r.post('/merchant/orders/:orderId/reject', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'orders:write');
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason) throw errors.validation('A rejection reason is required.');
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order || order.store_id !== access.storeId) throw errors.notFound('Order not found.');
    const updated = applyTransition(ctx, { orderId: order.id, to: 'Rejected', actor: 'merchant', actorId: req.user!.id, actorRole: req.user!.role, reason, traceId: req.traceId });
    res.json({ order: orderSummary(ctx, updated) });
  });

  // FUL-001..006 — fulfillment progression through the state machine.
  r.post('/merchant/orders/:orderId/status', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'orders:write');
    const { to, reason } = (req.body ?? {}) as { to?: string; reason?: string };
    const allowed = ['Preparing', 'ReadyForDispatch', 'Dispatched', 'Delivered', 'Completed'];
    if (!allowed.includes(to ?? '')) throw errors.validation(`status must be one of: ${allowed.join(', ')}.`);
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order || order.store_id !== access.storeId) throw errors.notFound('Order not found.');
    const updated = applyTransition(ctx, { orderId: order.id, to: to as never, actor: 'merchant', actorId: req.user!.id, actorRole: req.user!.role, reason: reason ?? null, traceId: req.traceId });
    res.json({ order: orderSummary(ctx, updated) });
  });

  // REF-003: merchant cancellation records actor + reason.
  r.post('/merchant/orders/:orderId/cancel', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'orders:write');
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason) throw errors.validation('A cancellation reason is required.');
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order || order.store_id !== access.storeId) throw errors.notFound('Order not found.');
    const updated = applyTransition(ctx, { orderId: order.id, to: 'Cancelled', actor: 'merchant', actorId: req.user!.id, actorRole: req.user!.role, reason, traceId: req.traceId });
    res.json({ order: orderSummary(ctx, updated) });
  });

  r.post('/merchant/orders/:orderId/refund', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'orders:write');
    const { reason, idempotencyKey } = (req.body ?? {}) as { reason?: string; idempotencyKey?: string };
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order || order.store_id !== access.storeId) throw errors.notFound('Order not found.');
    const result = requestRefund(ctx, {
      orderId: order.id,
      actorId: req.user!.id,
      actorRole: req.user!.role,
      reason,
      idempotencyKey: idempotencyKey ?? null,
      traceId: req.traceId
    });
    res.status(result.reused ? 200 : 201).json(result);
  });

  // Sandbox-only: provider confirms a refund (school-project simulator).
  r.post('/merchant/orders/:orderId/refunds/:refundId/complete', (req: Request, res: Response) => {
    if (ctx.config.env === 'production') throw errors.notFound('Not found.');
    const access = resolveStore(ctx, req);
    requirePerm(access, 'orders:write');
    const { success } = (req.body ?? {}) as { success?: boolean };
    if (typeof success !== 'boolean') throw errors.validation('success must be a boolean.');
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order || order.store_id !== access.storeId) throw errors.notFound('Order not found.');
    const refund = ctx.db.prepare('SELECT id FROM refunds WHERE id = ? AND order_id = ?').get(req.params.refundId, order.id);
    if (!refund) throw errors.notFound('Refund not found.');
    const updated = completeRefund(ctx, req.params.refundId, success);
    res.json({ refund: updated });
  });

  // ---------- staff management (FR-MER-06, MER-008) ----------
  r.get('/merchant/staff', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    const staff = ctx.db
      .prepare(
        `SELECT u.id, u.name, u.email, ss.role, ss.perms, ss.created_at
         FROM store_staff ss JOIN users u ON u.id = ss.user_id WHERE ss.store_id = ?`
      )
      .all(access.storeId);
    res.json({ staff });
  });

  r.post('/merchant/staff', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'staff:write');
    const b = (req.body ?? {}) as { name?: string; email?: string; password?: string; role?: string; perms?: string[] };
    if (!b.name || !b.email || !b.password || b.password.length < 8) {
      throw errors.validation('name, email and a password of at least 8 characters are required.');
    }
    if (!['staff', 'manager'].includes(b.role ?? 'staff')) throw errors.validation('role must be staff or manager.');
    const existing = ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(b.email.toLowerCase());
    let userId: string;
    if (existing) {
      userId = (existing as { id: string }).id;
    } else {
      userId = uuid();
      ctx.db
        .prepare(
          `INSERT INTO users (id, role, name, email, phone, password_hash, status, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, 'active', ?)`
        )
        .run(userId, b.role === 'manager' ? 'manager' : 'staff', b.name, b.email.toLowerCase(), hashPassword(b.password), now());
    }
    const assigned = ctx.db.prepare('SELECT 1 FROM store_staff WHERE store_id = ? AND user_id = ?').get(access.storeId, userId);
    if (assigned) throw errors.conflict('STAFF_EXISTS', 'This user is already assigned to your store.');
    let perms = (b.perms ?? (b.role === 'manager' ? MANAGER_PERMS : DEFAULT_STAFF_PERMS)).filter((p) =>
      VALID_PERMS.includes(p as StorePerm)
    ) as StorePerm[];
    if (b.role === 'manager') perms = MANAGER_PERMS;
    ctx.db
      .prepare('INSERT INTO store_staff (store_id, user_id, role, perms, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(access.storeId, userId, b.role ?? 'staff', j(perms), now());
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'staff.assigned', entity: 'store', entityId: access.storeId, detail: { userId, role: b.role, perms }, traceId: req.traceId });
    res.status(201).json({ userId, perms });
  });

  r.delete('/merchant/staff/:userId', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    requirePerm(access, 'staff:write');
    const res2 = ctx.db.prepare('DELETE FROM store_staff WHERE store_id = ? AND user_id = ?').run(access.storeId, req.params.userId);
    if (Number(res2.changes ?? 0) === 0) throw errors.notFound('Staff assignment not found.');
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'staff.removed', entity: 'store', entityId: access.storeId, detail: { userId: req.params.userId }, traceId: req.traceId });
    res.json({ ok: true });
  });

  // ---------- reports (FR-RPT-01..03, RPT-007 store isolation) ----------
  r.get('/merchant/reports/summary', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    const { from, to } = rangeParams(req);
    const params = [access.storeId, from, to];
    const totals = ctx.db
      .prepare(
        `SELECT COUNT(*) AS order_count,
                COALESCE(SUM(CASE WHEN state NOT IN ('Cancelled','Rejected','PaymentFailed') THEN total END), 0) AS sales_total,
                COALESCE(SUM(CASE WHEN state = 'Cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count,
                COALESCE(SUM(CASE WHEN state = 'PaymentFailed' THEN 1 ELSE 0 END), 0) AS failed_count
         FROM orders WHERE store_id = ? AND created_at >= ? AND created_at <= ?`
      )
      .get(...params) as Record<string, number>;
    const byState = ctx.db
      .prepare('SELECT state, COUNT(*) AS count FROM orders WHERE store_id = ? AND created_at >= ? AND created_at <= ? GROUP BY state')
      .all(...params);
    const refunds = ctx.db
      .prepare(
        `SELECT COUNT(*) AS refund_count, COALESCE(SUM(r.amount), 0) AS refund_total
         FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE o.store_id = ? AND r.created_at >= ? AND r.created_at <= ?`
      )
      .get(...params) as Record<string, number>;
    const payments = ctx.db
      .prepare(
        `SELECT p.state, COUNT(*) AS count FROM payments p JOIN orders o ON o.id = p.order_id
         WHERE o.store_id = ? AND p.created_at >= ? AND p.created_at <= ? GROUP BY p.state`
      )
      .all(...params);
    res.json({ range: { from, to }, totals, byState, refunds, payments });
  });

  r.get('/merchant/reports/top-products', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    const { from, to } = rangeParams(req);
    const rows = ctx.db
      .prepare(
        `SELECT oi.product_name, SUM(oi.quantity) AS units_sold, SUM(oi.line_total) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.store_id = ? AND o.created_at >= ? AND o.created_at <= ?
           AND o.state NOT IN ('Cancelled','Rejected','PaymentFailed')
         GROUP BY oi.product_name ORDER BY units_sold DESC LIMIT 10`
      )
      .all(access.storeId, from, to);
    res.json({ topProducts: rows });
  });

  r.get('/merchant/reports/inventory', (req: Request, res: Response) => {
    const access = resolveStore(ctx, req);
    res.json({ inventory: inventoryView(ctx, access.storeId) });
  });

  return r;
}

function rangeParams(req: Request): { from: string; to: string } {
  const from = String(req.query.from ?? '1970-01-01');
  const to = String(req.query.to ?? '9999-12-31T23:59:59.999Z');
  return { from, to };
}
