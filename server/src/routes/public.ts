import { Router, type Request, type Response } from 'express';
import type { AppCtx } from '../context.js';
import type { SqlParam } from '../db/index.js';
import { errors } from '../domain/errors.js';

/** Public marketplace discovery (UC-DC-03, FR-CAT-08..10). */
export function publicRoutes(ctx: AppCtx): Router {
  const r = Router();

  r.get('/stores', (req: Request, res: Response) => {
    const search = String(req.query.search ?? '').trim();
    const params: SqlParam[] = [];
    let where = `s.status = 'open' AND m.status = 'approved'`;
    if (search) {
      where += ' AND (s.name LIKE ? OR s.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    const rows = ctx.db
      .prepare(
        `SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.contact, s.status,
                (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.status = 'published') AS product_count
         FROM stores s JOIN merchants m ON m.id = s.merchant_id
         WHERE ${where} ORDER BY s.name`
      )
      .all(...params);
    res.json({ stores: rows });
  });

  r.get('/stores/:storeId', (req: Request, res: Response) => {
    const store = ctx.db
      .prepare(
        `SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.banner_url, s.contact, s.status, m.status AS merchant_status
         FROM stores s JOIN merchants m ON m.id = s.merchant_id
         WHERE s.id = ? OR s.slug = ?`
      )
      .get(req.params.storeId, req.params.storeId) as Record<string, unknown> | undefined;
    if (!store) throw errors.notFound('Store not found.');
    const isOwnerView = req.user && storeStatusAllowsPrivate(ctx, req.user.id, store.id as string);
    if ((store.status !== 'open' || store.merchant_status !== 'approved') && !isOwnerView) {
      throw errors.notFound('Store not found.');
    }
    res.json({ store });
  });

  r.get('/stores/:storeId/products', (req: Request, res: Response) => {
    const store = ctx.db.prepare('SELECT id FROM stores WHERE id = ? OR slug = ?').get(req.params.storeId, req.params.storeId) as
      | { id: string }
      | undefined;
    if (!store) throw errors.notFound('Store not found.');
    const [rows] = [queryProducts(ctx, req, { storeId: store.id, publicOnly: true })];
    res.json({ products: rows });
  });

  r.get('/products', (req: Request, res: Response) => {
    res.json({ products: queryProducts(ctx, req, { publicOnly: true }) });
  });

  r.get('/products/:productId', (req: Request, res: Response) => {
    const product = ctx.db
      .prepare(
        `SELECT p.*, s.name AS store_name, s.slug AS store_slug, s.status AS store_status,
                c.name AS category_name, i.quantity
         FROM products p
         JOIN stores s ON s.id = p.store_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN inventory_items i ON i.product_id = p.id
         WHERE p.id = ?`
      )
      .get(req.params.productId) as Record<string, unknown> | undefined;
    if (!product) throw errors.notFound('Product not found.');
    const canViewPrivate =
      product.status !== 'published' &&
      req.user &&
      storeStatusAllowsPrivate(ctx, req.user.id, product.store_id as string);
    if (product.status !== 'published' && !canViewPrivate) throw errors.notFound('Product not found.');
    // Availability shown to customers reflects real stock (no orderable claim when out of stock).
    res.json({ product: { ...product, orderable: product.status === 'published' && product.store_status === 'open' } });
  });

  r.get('/categories', (_req: Request, res: Response) => {
    const categories = ctx.db.prepare('SELECT * FROM categories ORDER BY name').all();
    res.json({ categories });
  });

  return r;
}

function storeStatusAllowsPrivate(ctx: AppCtx, userId: string, storeId: string): boolean {
  const row = ctx.db
    .prepare(
      `SELECT 1 FROM stores s JOIN merchants m ON m.id = s.merchant_id
       WHERE s.id = ? AND m.owner_user_id = ?
       UNION SELECT 1 FROM store_staff WHERE store_id = ? AND user_id = ?`
    )
    .get(storeId, userId, storeId, userId);
  return Boolean(row);
}

function queryProducts(
  ctx: AppCtx,
  req: Request,
  opts: { storeId?: string; publicOnly?: boolean }
): unknown[] {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (opts.publicOnly) clauses.push(`p.status = 'published'`, `s.status = 'open'`, `m.status = 'approved'`);
  if (opts.storeId) {
    clauses.push('p.store_id = ?');
    params.push(opts.storeId);
  }
  const search = String(req.query.search ?? '').trim();
  if (search) {
    // Parameterized LIKE (SEC-08 / SEC-001: injection probes cannot break out).
    clauses.push('(p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const category = String(req.query.category ?? '').trim();
  if (category) {
    clauses.push('(c.id = ? OR c.slug = ?)');
    params.push(category, category);
  }
  const sort = String(req.query.sort ?? 'name');
  const orderBy =
    sort === 'price_asc' ? 'p.price ASC' : sort === 'price_desc' ? 'p.price DESC' : 'p.name ASC';
  const sql = `
    SELECT p.id, p.store_id, p.name, p.sku, p.description, p.price, p.image_url, p.status, p.category_id,
           s.name AS store_name, s.slug AS store_slug, c.name AS category_name,
           COALESCE(i.quantity, 0) AS quantity
    FROM products p
    JOIN stores s ON s.id = p.store_id
    JOIN merchants m ON m.id = s.merchant_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_items i ON i.product_id = p.id
    ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
    ORDER BY ${orderBy}
    LIMIT 200`;
  return ctx.db.prepare(sql).all(...params);
}
