import { Router, type Request, type Response } from 'express';
import type { AppCtx } from '../context.js';
import { uuid, now, jp, type SqlParam } from '../db/index.js';
import { errors } from '../domain/errors.js';
import { requireAuth, requireRole } from '../middleware.js';
import { audit, listAudit } from '../services/audit.js';
import { canProductTransition, type ProductStatus } from '../domain/productState.js';
import { orderSummary } from '../services/orders.js';
import { getOrderRow } from '../services/checkout.js';
import { requestRefund } from '../services/payments/processor.js';
import { wrap } from '../middleware.js';


/** Platform administration (UC-DC-16, FR-ADM-*). */
export function adminRoutes(ctx: AppCtx): Router {
  const r = Router();
  // Path-scoped so later routers (support) are not affected by this guard.
  r.use('/admin', requireAuth, requireRole('admin'));

  // ---------- merchant governance (ADM-001/002, MER-002/003) ----------
  r.get('/admin/merchants', wrap(async (req: Request, res: Response) => {
    const status = String(req.query.status ?? '');
    const params: SqlParam[] = [];
    let where = '';
    if (status) {
      where = 'WHERE m.status = ?';
      params.push(status);
    }
    const merchants = await ctx.db
      .prepare(
        `SELECT m.*, u.name AS owner_name, u.email AS owner_email, s.id AS store_id, s.name AS store_name, s.status AS store_status
         FROM merchants m JOIN users u ON u.id = m.owner_user_id
         LEFT JOIN stores s ON s.merchant_id = m.id ${where} ORDER BY m.created_at DESC`
      )
      .all(...params);
    res.json({ merchants });
  }));

  r.post('/admin/merchants/:merchantId/:action(approve|reject|suspend)', wrap(async (req: Request, res: Response) => {
    const merchant = await ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.merchantId) as
      | { id: string; owner_user_id: string; status: string }
      | undefined;
    if (!merchant) throw errors.notFound('Merchant not found.');
    const action = req.params.action;
    const target = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'suspended';
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (action !== 'approve' && !reason) throw errors.validation('A reason is required.');
    await ctx.db.prepare('UPDATE merchants SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(target, reason ?? null, now(), merchant.id);
    if (target === 'approved') {
      // Approval promotes the applicant into the merchant-owner role.
      await ctx.db.prepare(`UPDATE users SET role = 'owner' WHERE id = ? AND role = 'customer'`).run(merchant.owner_user_id);
    }
    if (target === 'suspended') {
      const store = await ctx.db.prepare('SELECT id FROM stores WHERE merchant_id = ?').get(merchant.id) as { id: string } | undefined;
      if (store) await ctx.db.prepare(`UPDATE stores SET status = 'suspended', updated_at = ? WHERE id = ?`).run(now(), store.id);
    }
    await audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: `merchant.${action}`, entity: 'merchant', entityId: merchant.id, detail: { reason: reason ?? null }, traceId: req.traceId });
    res.json({ merchant: await ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchant.id) });
  }));

  // ---------- stores & product moderation (ADM-002/004) ----------
  r.get('/admin/stores', wrap(async (_req: Request, res: Response) => {
    const stores = await ctx.db
      .prepare(
        `SELECT s.*, m.business_name, m.status AS merchant_status
         FROM stores s JOIN merchants m ON m.id = s.merchant_id ORDER BY s.created_at DESC`
      )
      .all();
    res.json({ stores });
  }));

  r.post('/admin/stores/:storeId/status', wrap(async (req: Request, res: Response) => {
    const { status, reason } = (req.body ?? {}) as { status?: string; reason?: string };
    if (!['open', 'closed', 'suspended'].includes(status ?? '')) throw errors.validation('Invalid status.');
    const store = await ctx.db.prepare('SELECT id FROM stores WHERE id = ?').get(req.params.storeId);
    if (!store) throw errors.notFound('Store not found.');
    await ctx.db.prepare('UPDATE stores SET status = ?, updated_at = ? WHERE id = ?').run(status!, now(), req.params.storeId);
    await audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'store.status_changed', entity: 'store', entityId: req.params.storeId, detail: { status, reason: reason ?? null }, traceId: req.traceId });
    res.json({ store: await ctx.db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.storeId) });
  }));

  r.get('/admin/products', wrap(async (req: Request, res: Response) => {
    const search = String(req.query.search ?? '').trim();
    const params: SqlParam[] = [];
    let where = '';
    if (search) {
      where = 'WHERE p.name LIKE ? OR p.sku LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }
    const products = await ctx.db
      .prepare(
        `SELECT p.*, s.name AS store_name FROM products p JOIN stores s ON s.id = p.store_id ${where}
         ORDER BY p.updated_at DESC LIMIT 200`
      )
      .all(...params);
    res.json({ products });
  }));

  r.post('/admin/products/:productId/status', wrap(async (req: Request, res: Response) => {
    const { status, reason } = (req.body ?? {}) as { status?: string; reason?: string };
    const target = status as ProductStatus;
    if (!['published', 'unpublished', 'suspended'].includes(target)) throw errors.validation('Invalid status.');
    const product = await ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.productId) as
      | { id: string; status: string }
      | undefined;
    if (!product) throw errors.notFound('Product not found.');
    if (!canProductTransition(product.status as ProductStatus, target)) {
      throw errors.badRequest('ILLEGAL_PRODUCT_TRANSITION', `Cannot move product from ${product.status} to ${target}.`);
    }
    await ctx.db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(target, now(), product.id);
    await audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'product.status_changed', entity: 'product', entityId: product.id, detail: { from: product.status, to: target, reason: reason ?? null }, traceId: req.traceId });
    res.json({ product: await ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(product.id) });
  }));

  // ---------- categories (ADM-003, FR-CAT-07) ----------
  r.get('/admin/categories', wrap(async (_req: Request, res: Response) => {
    res.json({ categories: await ctx.db.prepare('SELECT * FROM categories ORDER BY name').all() });
  }));

  r.post('/admin/categories', wrap(async (req: Request, res: Response) => {
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string };
    if (!name || name.trim().length < 2) throw errors.validation('Category name is required.');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const dup = await ctx.db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
    if (dup) throw errors.conflict('CATEGORY_EXISTS', 'A category with this name already exists.');
    const id = uuid();
    await ctx.db.prepare('INSERT INTO categories (id, name, slug, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), slug, parentId ?? null, now());
    await audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'category.created', entity: 'category', entityId: id, detail: { name }, traceId: req.traceId });
    res.status(201).json({ category: await ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
  }));

  r.patch('/admin/categories/:categoryId', wrap(async (req: Request, res: Response) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name || name.trim().length < 2) throw errors.validation('Category name is required.');
    const cat = await ctx.db.prepare('SELECT id FROM categories WHERE id = ?').get(req.params.categoryId);
    if (!cat) throw errors.notFound('Category not found.');
    await ctx.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), req.params.categoryId);
    await audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'category.updated', entity: 'category', entityId: req.params.categoryId, detail: { name }, traceId: req.traceId });
    res.json({ category: await ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.categoryId) });
  }));

  // ---------- operational visibility ----------
  r.get('/admin/orders', wrap(async (req: Request, res: Response) => {
    const state = String(req.query.state ?? '');
    const params: SqlParam[] = [];
    let where = '';
    if (state) {
      where = 'WHERE o.state = ?';
      params.push(state);
    }
    const orders = await ctx.db
      .prepare(
        `SELECT o.*, s.name AS store_name, u.name AS customer_name FROM orders o
         JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.customer_id
         ${where} ORDER BY o.created_at DESC LIMIT 200`
      )
      .all(...params);
    res.json({ orders });
  }));

  r.get('/admin/orders/:orderId', wrap(async (req: Request, res: Response) => {
    const order = await getOrderRow(ctx, req.params.orderId);
    if (!order) throw errors.notFound('Order not found.');
    res.json({ order: await orderSummary(ctx, order) });
  }));

  /** PAY-010: reconciliation view — payment status + provider references. */
  r.get('/admin/payments', wrap(async (_req: Request, res: Response) => {
    const payments = await ctx.db
      .prepare(
        `SELECT p.id, p.order_id, o.order_number, o.state AS order_state, p.provider, p.state, p.amount,
                p.provider_ref, p.created_at, p.updated_at
         FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.created_at DESC LIMIT 200`
      )
      .all();
    res.json({ payments });
  }));

  r.post('/admin/orders/:orderId/refund', wrap(async (req: Request, res: Response) => {
    const { reason, idempotencyKey } = (req.body ?? {}) as { reason?: string; idempotencyKey?: string };
    const order = await getOrderRow(ctx, req.params.orderId);
    if (!order) throw errors.notFound('Order not found.');
    const result = await requestRefund(ctx, {
      orderId: order.id,
      actorId: req.user!.id,
      actorRole: 'admin',
      reason,
      idempotencyKey: idempotencyKey ?? null,
      traceId: req.traceId
    });
    res.status(result.reused ? 200 : 201).json(result);
  }));

  // ---------- audit & platform reporting (ADM-005, RPT-006) ----------
  r.get('/admin/audit', wrap(async (req: Request, res: Response) => {
    const rows = await listAudit(ctx, {
      entity: req.query.entity ? String(req.query.entity) : undefined,
      entityId: req.query.entityId ? String(req.query.entityId) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : 100
    });
    res.json({ audit: rows });
  }));

  r.get('/admin/reports/overview', wrap(async (_req: Request, res: Response) => {
    const merchants = await ctx.db.prepare('SELECT status, COUNT(*) AS count FROM merchants GROUP BY status').all();
    const stores = await ctx.db.prepare('SELECT status, COUNT(*) AS count FROM stores GROUP BY status').all();
    const orders = await ctx.db.prepare('SELECT state, COUNT(*) AS count FROM orders GROUP BY state').all();
    const payments = await ctx.db.prepare('SELECT state, COUNT(*) AS count FROM payments GROUP BY state').all();
    const revenue = await ctx.db
      .prepare(`SELECT COALESCE(SUM(total), 0) AS gross FROM orders WHERE state IN ('Confirmed','Accepted','Preparing','ReadyForDispatch','Dispatched','Delivered','Completed')`)
      .get() as { gross: number };
    const products = await ctx.db.prepare('SELECT status, COUNT(*) AS count FROM products GROUP BY status').all();
    const lowStock = await ctx.db
      .prepare('SELECT COUNT(*) AS count FROM inventory_items WHERE quantity < low_stock_threshold')
      .get() as { count: number };
    res.json({ merchants, stores, orders, payments, products, grossRevenue: revenue.gross, lowStockCount: lowStock.count });
  }));

  r.get('/admin/users', wrap(async (req: Request, res: Response) => {
    const search = String(req.query.search ?? '').trim();
    const params: SqlParam[] = [];
    let where = '';
    if (search) {
      where = 'WHERE name LIKE ? OR email LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }
    const users = await ctx.db
      .prepare(`SELECT id, role, name, email, phone, status, created_at FROM users ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...params);
    res.json({ users });
  }));

  return r;
}

/** Support investigation (UC-DC-17, SUP-001..003): read-only, audited, scoped. */
export function supportRoutes(ctx: AppCtx): Router {
  const r = Router();
  r.use('/support', requireAuth, requireRole('support', 'admin'));

  r.get('/support/orders/:orderNumber', wrap(async (req: Request, res: Response) => {
    const order = await ctx.db
      .prepare(
        `SELECT o.id, o.order_number, o.state, o.total, o.payment_method, o.delivery_method, o.created_at, o.updated_at,
                s.name AS store_name, u.name AS customer_name
         FROM orders o JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.customer_id
         WHERE o.order_number = ?`
      )
      .get(req.params.orderNumber) as Record<string, unknown> | undefined;
    if (!order) throw errors.notFound('Order not found.');
    const items = await ctx.db
      .prepare('SELECT product_name, quantity, unit_price, line_total FROM order_items WHERE order_id = ?')
      .all(order.id as string);
    const payment = await ctx.db
      .prepare('SELECT id, state, amount, provider_ref, updated_at FROM payments WHERE order_id = ?')
      .get(order.id as string);
    // SUP-003: support lookups are audited.
    await audit(ctx, {
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'support.order_lookup',
      entity: 'order',
      entityId: order.id as string,
      detail: { orderNumber: req.params.orderNumber },
      traceId: req.traceId
    });
    res.json({ order, items, payment });
  }));

  r.get('/support/customers', wrap(async (req: Request, res: Response) => {
    const search = String(req.query.search ?? '').trim();
    if (!search) throw errors.validation('search is required.');
    const users = await ctx.db
      .prepare(
        `SELECT id, name, email, phone, created_at FROM users
         WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 20`
      )
      .all(`%${search}%`, `%${search}%`, `%${search}%`);
    await audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'support.customer_lookup', entity: 'user', detail: { search }, traceId: req.traceId });
    res.json({ users });
  }));

  return r;
}
