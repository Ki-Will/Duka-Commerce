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

/** Platform administration (UC-DC-16, FR-ADM-*). */
export function adminRoutes(ctx: AppCtx): Router {
  const r = Router();
  // Path-scoped so later routers (support) are not affected by this guard.
  r.use('/admin', requireAuth, requireRole('admin'));

  // ---------- merchant governance (ADM-001/002, MER-002/003) ----------
  r.get('/admin/merchants', (req: Request, res: Response) => {
    const status = String(req.query.status ?? '');
    const params: SqlParam[] = [];
    let where = '';
    if (status) {
      where = 'WHERE m.status = ?';
      params.push(status);
    }
    const merchants = ctx.db
      .prepare(
        `SELECT m.*, u.name AS owner_name, u.email AS owner_email, s.id AS store_id, s.name AS store_name, s.status AS store_status
         FROM merchants m JOIN users u ON u.id = m.owner_user_id
         LEFT JOIN stores s ON s.merchant_id = m.id ${where} ORDER BY m.created_at DESC`
      )
      .all(...params);
    res.json({ merchants });
  });

  r.post('/admin/merchants/:merchantId/:action(approve|reject|suspend)', (req: Request, res: Response) => {
    const merchant = ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.params.merchantId) as
      | { id: string; owner_user_id: string; status: string }
      | undefined;
    if (!merchant) throw errors.notFound('Merchant not found.');
    const action = req.params.action;
    const target = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'suspended';
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (action !== 'approve' && !reason) throw errors.validation('A reason is required.');
    ctx.db.prepare('UPDATE merchants SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(target, reason ?? null, now(), merchant.id);
    if (target === 'approved') {
      // Approval promotes the applicant into the merchant-owner role.
      ctx.db.prepare(`UPDATE users SET role = 'owner' WHERE id = ? AND role = 'customer'`).run(merchant.owner_user_id);
    }
    if (target === 'suspended') {
      const store = ctx.db.prepare('SELECT id FROM stores WHERE merchant_id = ?').get(merchant.id) as { id: string } | undefined;
      if (store) ctx.db.prepare(`UPDATE stores SET status = 'suspended', updated_at = ? WHERE id = ?`).run(now(), store.id);
    }
    audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: `merchant.${action}`, entity: 'merchant', entityId: merchant.id, detail: { reason: reason ?? null }, traceId: req.traceId });
    res.json({ merchant: ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchant.id) });
  });

  // ---------- stores & product moderation (ADM-002/004) ----------
  r.get('/admin/stores', (_req: Request, res: Response) => {
    const stores = ctx.db
      .prepare(
        `SELECT s.*, m.business_name, m.status AS merchant_status
         FROM stores s JOIN merchants m ON m.id = s.merchant_id ORDER BY s.created_at DESC`
      )
      .all();
    res.json({ stores });
  });

  r.post('/admin/stores/:storeId/status', (req: Request, res: Response) => {
    const { status, reason } = (req.body ?? {}) as { status?: string; reason?: string };
    if (!['open', 'closed', 'suspended'].includes(status ?? '')) throw errors.validation('Invalid status.');
    const store = ctx.db.prepare('SELECT id FROM stores WHERE id = ?').get(req.params.storeId);
    if (!store) throw errors.notFound('Store not found.');
    ctx.db.prepare('UPDATE stores SET status = ?, updated_at = ? WHERE id = ?').run(status!, now(), req.params.storeId);
    audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'store.status_changed', entity: 'store', entityId: req.params.storeId, detail: { status, reason: reason ?? null }, traceId: req.traceId });
    res.json({ store: ctx.db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.storeId) });
  });

  r.get('/admin/products', (req: Request, res: Response) => {
    const search = String(req.query.search ?? '').trim();
    const params: SqlParam[] = [];
    let where = '';
    if (search) {
      where = 'WHERE p.name LIKE ? OR p.sku LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }
    const products = ctx.db
      .prepare(
        `SELECT p.*, s.name AS store_name FROM products p JOIN stores s ON s.id = p.store_id ${where}
         ORDER BY p.updated_at DESC LIMIT 200`
      )
      .all(...params);
    res.json({ products });
  });

  r.post('/admin/products/:productId/status', (req: Request, res: Response) => {
    const { status, reason } = (req.body ?? {}) as { status?: string; reason?: string };
    const target = status as ProductStatus;
    if (!['published', 'unpublished', 'suspended'].includes(target)) throw errors.validation('Invalid status.');
    const product = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.productId) as
      | { id: string; status: string }
      | undefined;
    if (!product) throw errors.notFound('Product not found.');
    if (!canProductTransition(product.status as ProductStatus, target)) {
      throw errors.badRequest('ILLEGAL_PRODUCT_TRANSITION', `Cannot move product from ${product.status} to ${target}.`);
    }
    ctx.db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(target, now(), product.id);
    audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'product.status_changed', entity: 'product', entityId: product.id, detail: { from: product.status, to: target, reason: reason ?? null }, traceId: req.traceId });
    res.json({ product: ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(product.id) });
  });

  // ---------- categories (ADM-003, FR-CAT-07) ----------
  r.get('/admin/categories', (_req: Request, res: Response) => {
    res.json({ categories: ctx.db.prepare('SELECT * FROM categories ORDER BY name').all() });
  });

  r.post('/admin/categories', (req: Request, res: Response) => {
    const { name, parentId } = (req.body ?? {}) as { name?: string; parentId?: string };
    if (!name || name.trim().length < 2) throw errors.validation('Category name is required.');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const dup = ctx.db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
    if (dup) throw errors.conflict('CATEGORY_EXISTS', 'A category with this name already exists.');
    const id = uuid();
    ctx.db.prepare('INSERT INTO categories (id, name, slug, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), slug, parentId ?? null, now());
    audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'category.created', entity: 'category', entityId: id, detail: { name }, traceId: req.traceId });
    res.status(201).json({ category: ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
  });

  r.patch('/admin/categories/:categoryId', (req: Request, res: Response) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name || name.trim().length < 2) throw errors.validation('Category name is required.');
    const cat = ctx.db.prepare('SELECT id FROM categories WHERE id = ?').get(req.params.categoryId);
    if (!cat) throw errors.notFound('Category not found.');
    ctx.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), req.params.categoryId);
    audit(ctx, { actorId: req.user!.id, actorRole: 'admin', action: 'category.updated', entity: 'category', entityId: req.params.categoryId, detail: { name }, traceId: req.traceId });
    res.json({ category: ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.categoryId) });
  });

  // ---------- operational visibility ----------
  r.get('/admin/orders', (req: Request, res: Response) => {
    const state = String(req.query.state ?? '');
    const params: SqlParam[] = [];
    let where = '';
    if (state) {
      where = 'WHERE o.state = ?';
      params.push(state);
    }
    const orders = ctx.db
      .prepare(
        `SELECT o.*, s.name AS store_name, u.name AS customer_name FROM orders o
         JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.customer_id
         ${where} ORDER BY o.created_at DESC LIMIT 200`
      )
      .all(...params);
    res.json({ orders });
  });

  r.get('/admin/orders/:orderId', (req: Request, res: Response) => {
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order) throw errors.notFound('Order not found.');
    res.json({ order: orderSummary(ctx, order) });
  });

  /** PAY-010: reconciliation view — payment status + provider references. */
  r.get('/admin/payments', (_req: Request, res: Response) => {
    const payments = ctx.db
      .prepare(
        `SELECT p.id, p.order_id, o.order_number, o.state AS order_state, p.provider, p.state, p.amount,
                p.provider_ref, p.created_at, p.updated_at
         FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.created_at DESC LIMIT 200`
      )
      .all();
    res.json({ payments });
  });

  r.post('/admin/orders/:orderId/refund', (req: Request, res: Response) => {
    const { reason, idempotencyKey } = (req.body ?? {}) as { reason?: string; idempotencyKey?: string };
    const order = getOrderRow(ctx, req.params.orderId);
    if (!order) throw errors.notFound('Order not found.');
    const result = requestRefund(ctx, {
      orderId: order.id,
      actorId: req.user!.id,
      actorRole: 'admin',
      reason,
      idempotencyKey: idempotencyKey ?? null,
      traceId: req.traceId
    });
    res.status(result.reused ? 200 : 201).json(result);
  });

  // ---------- audit & platform reporting (ADM-005, RPT-006) ----------
  r.get('/admin/audit', (req: Request, res: Response) => {
    const rows = listAudit(ctx, {
      entity: req.query.entity ? String(req.query.entity) : undefined,
      entityId: req.query.entityId ? String(req.query.entityId) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : 100
    });
    res.json({ audit: rows });
  });

  r.get('/admin/reports/overview', (_req: Request, res: Response) => {
    const merchants = ctx.db.prepare('SELECT status, COUNT(*) AS count FROM merchants GROUP BY status').all();
    const stores = ctx.db.prepare('SELECT status, COUNT(*) AS count FROM stores GROUP BY status').all();
    const orders = ctx.db.prepare('SELECT state, COUNT(*) AS count FROM orders GROUP BY state').all();
    const payments = ctx.db.prepare('SELECT state, COUNT(*) AS count FROM payments GROUP BY state').all();
    const revenue = ctx.db
      .prepare(`SELECT COALESCE(SUM(total), 0) AS gross FROM orders WHERE state IN ('Confirmed','Accepted','Preparing','ReadyForDispatch','Dispatched','Delivered','Completed')`)
      .get() as { gross: number };
    const products = ctx.db.prepare('SELECT status, COUNT(*) AS count FROM products GROUP BY status').all();
    const lowStock = ctx.db
      .prepare('SELECT COUNT(*) AS count FROM inventory_items WHERE quantity < low_stock_threshold')
      .get() as { count: number };
    res.json({ merchants, stores, orders, payments, products, grossRevenue: revenue.gross, lowStockCount: lowStock.count });
  });

  r.get('/admin/users', (req: Request, res: Response) => {
    const search = String(req.query.search ?? '').trim();
    const params: SqlParam[] = [];
    let where = '';
    if (search) {
      where = 'WHERE name LIKE ? OR email LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }
    const users = ctx.db
      .prepare(`SELECT id, role, name, email, phone, status, created_at FROM users ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...params);
    res.json({ users });
  });

  return r;
}

/** Support investigation (UC-DC-17, SUP-001..003): read-only, audited, scoped. */
export function supportRoutes(ctx: AppCtx): Router {
  const r = Router();
  r.use('/support', requireAuth, requireRole('support', 'admin'));

  r.get('/support/orders/:orderNumber', (req: Request, res: Response) => {
    const order = ctx.db
      .prepare(
        `SELECT o.id, o.order_number, o.state, o.total, o.payment_method, o.delivery_method, o.created_at, o.updated_at,
                s.name AS store_name, u.name AS customer_name
         FROM orders o JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.customer_id
         WHERE o.order_number = ?`
      )
      .get(req.params.orderNumber) as Record<string, unknown> | undefined;
    if (!order) throw errors.notFound('Order not found.');
    const items = ctx.db
      .prepare('SELECT product_name, quantity, unit_price, line_total FROM order_items WHERE order_id = ?')
      .all(order.id as string);
    const payment = ctx.db
      .prepare('SELECT id, state, amount, provider_ref, updated_at FROM payments WHERE order_id = ?')
      .get(order.id as string);
    // SUP-003: support lookups are audited.
    audit(ctx, {
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'support.order_lookup',
      entity: 'order',
      entityId: order.id as string,
      detail: { orderNumber: req.params.orderNumber },
      traceId: req.traceId
    });
    res.json({ order, items, payment });
  });

  r.get('/support/customers', (req: Request, res: Response) => {
    const search = String(req.query.search ?? '').trim();
    if (!search) throw errors.validation('search is required.');
    const users = ctx.db
      .prepare(
        `SELECT id, name, email, phone, created_at FROM users
         WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? LIMIT 20`
      )
      .all(`%${search}%`, `%${search}%`, `%${search}%`);
    audit(ctx, { actorId: req.user!.id, actorRole: req.user!.role, action: 'support.customer_lookup', entity: 'user', detail: { search }, traceId: req.traceId });
    res.json({ users });
  });

  return r;
}
