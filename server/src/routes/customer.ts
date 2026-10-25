import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppCtx } from '../context.js';
import { uuid, now, tx } from '../db/index.js';
import { errors } from '../domain/errors.js';
import { requireAuth } from '../middleware.js';
import { checkout, getOrderRow, type OrderRow } from '../services/checkout.js';
import { assertOrderVisibleToCustomer, customerCancel, orderSummary } from '../services/orders.js';
import { initiatePayment, processCallback, getPaymentForOrder, type PaymentRow } from '../services/payments/processor.js';
import { getAdapter } from '../services/payments/stub.js';
import { audit } from '../services/audit.js';
import { notificationsFor } from '../services/notifications.js';
import { isOrderable } from '../domain/productState.js';
import { computeTotals } from '../domain/money.js';
import { wrap } from '../middleware.js';


/** Authenticated customer surface (UC-DC-02, 04, 05, 07). */
export function customerRoutes(ctx: AppCtx): Router {
  const r = Router();
  // Path-scoped guard: unknown /api/v1 routes must still reach the 404 handler.
  r.use(['/profile', '/addresses', '/carts', '/orders', '/payments', '/notifications'], requireAuth);

  // ---------- profile & addresses (FR-CUS-01/02) ----------
  r.get('/profile', wrap(async (req: Request, res: Response) => {
    const user = await ctx.db
      .prepare('SELECT id, role, name, email, phone, created_at FROM users WHERE id = ?')
      .get(req.user!.id);
    const addresses = await ctx.db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at').all(req.user!.id);
    res.json({ user, addresses });
  }));

  r.patch('/profile', wrap(async (req: Request, res: Response) => {
    const { name, phone } = (req.body ?? {}) as Record<string, string>;
    const user = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as { id: string };
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length < 2) throw errors.validation('Name is too short.');
      await ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), user.id);
    }
    if (phone !== undefined) {
      if (phone) {
        const dup = await ctx.db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, user.id);
        if (dup) throw errors.conflict('ACCOUNT_EXISTS', 'An account with this phone already exists.');
      }
      await ctx.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone || null, user.id);
    }
    await audit(ctx, { actorId: user.id, actorRole: req.user!.role, action: 'profile.updated', entity: 'user', entityId: user.id, traceId: req.traceId });
    res.json({ user: await ctx.db.prepare('SELECT id, role, name, email, phone, created_at FROM users WHERE id = ?').get(user.id) });
  }));

  r.post('/addresses', wrap(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (!b.name || !b.line1 || !b.city) throw errors.validation('Name, line1 and city are required.');
    const id = uuid();
    const makeDefault = await ctx.db.prepare('SELECT 1 FROM addresses WHERE user_id = ?').get(req.user!.id) ? 0 : 1;
    await ctx.db
      .prepare(
        `INSERT INTO addresses (id, user_id, label, name, line1, line2, city, phone, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, req.user!.id, b.label ?? '', b.name, b.line1, b.line2 ?? '', b.city, b.phone ?? '', b.is_default ? 1 : makeDefault, now());
    res.status(201).json({ address: await ctx.db.prepare('SELECT * FROM addresses WHERE id = ?').get(id) });
  }));

  r.patch('/addresses/:id', wrap(async (req: Request, res: Response) => {
    const addr = await ctx.db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.id);
    if (!addr) throw errors.notFound('Address not found.');
    const b = (req.body ?? {}) as Record<string, string>;
    const fields = ['label', 'name', 'line1', 'line2', 'city', 'phone'];
    for (const f of fields) {
      if (b[f] !== undefined) await ctx.db.prepare(`UPDATE addresses SET ${f} = ? WHERE id = ?`).run(b[f], req.params.id);
    }
    res.json({ address: await ctx.db.prepare('SELECT * FROM addresses WHERE id = ?').get(req.params.id) });
  }));

  r.delete('/addresses/:id', wrap(async (req: Request, res: Response) => {
    const res2 = await ctx.db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id);
    if (Number(res2.changes ?? 0) === 0) throw errors.notFound('Address not found.');
    res.json({ ok: true });
  }));

  // ---------- store-scoped carts (FR-CART-01, BR-01) ----------
  r.get('/carts', wrap(async (req: Request, res: Response) => {
    const carts = await ctx.db.prepare('SELECT * FROM carts WHERE customer_id = ? ORDER BY created_at').all(req.user!.id) as {
      id: string;
      store_id: string;
    }[];
    res.json({
      carts: await Promise.all(carts.map(async (c) => ({ ...c, ...await cartDetail(ctx, c.id) })))
    });
  }));

  r.post('/carts', wrap(async (req: Request, res: Response) => {
    const { storeId } = (req.body ?? {}) as { storeId?: string };
    if (!storeId) throw errors.validation('storeId is required.');
    const store = await ctx.db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId);
    if (!store) throw errors.notFound('Store not found.');
    const existing = await ctx.db.prepare('SELECT * FROM carts WHERE customer_id = ? AND store_id = ?').get(req.user!.id, storeId);
    if (existing) return res.status(200).json({ cart: { ...(existing as object), ...await cartDetail(ctx, (existing as { id: string }).id) } });
    const id = uuid();
    await ctx.db.prepare('INSERT INTO carts (id, customer_id, store_id, created_at) VALUES (?, ?, ?, ?)').run(id, req.user!.id, storeId, now());
    res.status(201).json({ cart: { id, store_id: storeId, ...await cartDetail(ctx, id) } });
  }));

  r.post('/carts/:cartId/items', wrap(async (req: Request, res: Response) => {
    const cart = await ownedCart(ctx, req);
    const { productId, quantity } = (req.body ?? {}) as { productId?: string; quantity?: number };
    if (!productId || !Number.isInteger(quantity) || quantity! <= 0) {
      throw errors.validation('productId and a positive quantity are required.');
    }
    const product = await ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
      | { id: string; store_id: string; status: string; name: string }
      | undefined;
    if (!product) throw errors.notFound('Product not found.');
    if (product.store_id !== cart.store_id) {
      // Store-scoped carts: a different store gets its own cart (CART-004).
      throw errors.badRequest('DIFFERENT_STORE', 'This product belongs to a different store. Start a cart for that store.');
    }
    if (!isOrderable(product.status as never)) {
      throw errors.badRequest('PRODUCT_NOT_ORDERABLE', 'This product is not available.');
    }
    const stock = await ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(productId) as
      | { quantity: number }
      | undefined;
    if (!stock || stock.quantity <= 0) {
      throw errors.badRequest('OUT_OF_STOCK', 'This product is out of stock.');
    }
    const current = await ctx.db.prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?').get(cart.id, productId) as
      | { quantity: number }
      | undefined;
    const nextQty = (current?.quantity ?? 0) + quantity!;
    if (nextQty > stock.quantity) {
      throw errors.badRequest('INSUFFICIENT_STOCK', `Only ${stock.quantity} unit(s) available.`);
    }
    await ctx.db
      .prepare(
        `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT(cart_id, product_id) DO UPDATE SET quantity = excluded.quantity`
      )
      .run(cart.id, productId, nextQty);
    res.status(201).json({ cart: await cartDetail(ctx, cart.id) });
  }));

  r.patch('/carts/:cartId/items/:productId', wrap(async (req: Request, res: Response) => {
    const cart = await ownedCart(ctx, req);
    const { quantity } = (req.body ?? {}) as { quantity?: number };
    if (!Number.isInteger(quantity) || quantity! < 0) throw errors.validation('quantity must be a non-negative integer.');
    if (quantity === 0) {
      await ctx.db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?').run(cart.id, req.params.productId);
      return res.json({ cart: await cartDetail(ctx, cart.id) });
    }
    const stock = await ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(req.params.productId) as
      | { quantity: number }
      | undefined;
    if (stock && quantity! > stock.quantity) {
      throw errors.badRequest('INSUFFICIENT_STOCK', `Only ${stock.quantity} unit(s) available.`);
    }
    const upd = await ctx.db
      .prepare('UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?')
      .run(quantity!, cart.id, req.params.productId);
    if (Number(upd.changes ?? 0) === 0) throw errors.notFound('Cart item not found.');
    res.json({ cart: await cartDetail(ctx, cart.id) });
  }));

  r.delete('/carts/:cartId/items/:productId', wrap(async (req: Request, res: Response) => {
    const cart = await ownedCart(ctx, req);
    await ctx.db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?').run(cart.id, req.params.productId);
    res.json({ cart: await cartDetail(ctx, cart.id) });
  }));

  r.get('/carts/:cartId', wrap(async (req: Request, res: Response) => {
    const cart = await ownedCart(ctx, req);
    res.json({ cart: await cartDetail(ctx, cart.id) });
  }));

  // ---------- checkout (UC-DC-05) ----------
  r.post('/orders', wrap(async (req: Request, res: Response, next: NextFunction) => {
    const b = (req.body ?? {}) as {
      cartId?: string;
      addressId?: string;
      deliveryMethod?: 'delivery' | 'pickup';
      paymentMethod?: 'momo' | 'card' | 'cod';
      notes?: string;
      idempotencyKey?: string;
    };
    if (!b.cartId) throw errors.validation('cartId is required.');
    const deliveryMethod = b.deliveryMethod ?? 'delivery';
    const paymentMethod = b.paymentMethod ?? 'momo';
    if (!['delivery', 'pickup'].includes(deliveryMethod)) throw errors.validation('Invalid delivery method.');
    if (!['momo', 'card', 'cod'].includes(paymentMethod)) throw errors.validation('Invalid payment method.');
    const idempotencyKey =
      b.idempotencyKey ?? (req.headers['idempotency-key'] as string | undefined) ?? null;
    try {
      const order = await checkout(ctx, {
        customerId: req.user!.id,
        cartId: b.cartId,
        addressId: b.addressId ?? null,
        deliveryMethod,
        paymentMethod,
        notes: b.notes,
        idempotencyKey,
        traceId: req.traceId
      });
      let payment: PaymentRow | undefined;
      if (paymentMethod !== 'cod') {
        payment = (await initiatePayment(ctx, {
          orderId: order.id,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:pay` : null,
          customerPhone: req.user!.phone,
          traceId: req.traceId
        })).payment;
      }
      res.status(201).json({ order: await orderSummary(ctx, order), payment });
    } catch (err) {
      next(err);
    }
  }));

  r.get('/orders', wrap(async (req: Request, res: Response) => {
    const rows = await ctx.db
      .prepare(
        `SELECT o.*, s.name AS store_name FROM orders o JOIN stores s ON s.id = o.store_id
         WHERE o.customer_id = ? ORDER BY o.created_at DESC LIMIT 100`
      )
      .all(req.user!.id);
    res.json({ orders: rows });
  }));

  r.get('/orders/:orderId', wrap(async (req: Request, res: Response) => {
    // AU-008 / SEC-003: another customer's order is indistinguishable from missing.
    const order = await assertOrderVisibleToCustomer(ctx, req.params.orderId, req.user!.id);
    res.json({ order: await orderSummary(ctx, order) });
  }));

  r.post('/orders/:orderId/cancel', wrap(async (req: Request, res: Response) => {
    const { reason } = (req.body ?? {}) as { reason?: string };
    const order = await customerCancel(ctx, req.params.orderId, req.user!.id, reason);
    res.json({ order: await orderSummary(ctx, order) });
  }));

  // ---------- payments (UC-DC-06) ----------
  r.post('/payments', wrap(async (req: Request, res: Response) => {
    const { orderId, idempotencyKey } = (req.body ?? {}) as { orderId?: string; idempotencyKey?: string };
    if (!orderId) throw errors.validation('orderId is required.');
    const order = await assertOrderVisibleToCustomer(ctx, orderId, req.user!.id);
    const result = await initiatePayment(ctx, {
      orderId: order.id,
      idempotencyKey: idempotencyKey ?? null,
      customerPhone: req.user!.phone,
      traceId: req.traceId
    });
    res.status(result.reused ? 200 : 201).json(result);
  }));

  r.get('/payments/:paymentId', wrap(async (req: Request, res: Response) => {
    const payment = await ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.paymentId) as PaymentRow | undefined;
    if (!payment) throw errors.notFound('Payment not found.');
    const order = await getOrderRow(ctx, payment.order_id);
    if (!order || order.customer_id !== req.user!.id) throw errors.notFound('Payment not found.');
    res.json({ payment, checkoutUrl: `https://sandbox.momo.example/pay/${payment.provider_ref}?amount=${payment.amount}` });
  }));

  /**
   * Sandbox simulator (dev/test only): produces the provider callback and pushes
   * it through the exact same processing path as a real webhook.
   */
  r.post('/payments/:paymentId/simulate', wrap(async (req: Request, res: Response) => {
    if (ctx.config.env === 'production') throw errors.notFound('Not found.');
    const { result } = (req.body ?? {}) as { result?: string };
    if (!['success', 'failure', 'timeout'].includes(result ?? '')) {
      throw errors.validation('result must be success, failure or timeout.');
    }
    const payment = await ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.paymentId) as PaymentRow | undefined;
    if (!payment) throw errors.notFound('Payment not found.');
    const order = await getOrderRow(ctx, payment.order_id);
    if (!order || order.customer_id !== req.user!.id) throw errors.notFound('Payment not found.');
    const adapter = getAdapter(ctx);
    const payload = {
      externalEventId: `EVT-SIM-${uuid()}`,
      providerRef: payment.provider_ref ?? '',
      result: result as 'success' | 'failure' | 'timeout',
      amount: payment.amount
    };
    const rawBody = JSON.stringify(payload);
    const signature = adapter.sign(rawBody);
    const outcome = await processCallback(ctx, 'momo', rawBody, signature, req.traceId);
    res.json({ outcome, payment: await ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) });
  }));

  r.get('/notifications', wrap(async (req: Request, res: Response) => {
    res.json({ notifications: await notificationsFor(ctx, req.user!.id) });
  }));

  return r;
}

async function ownedCart(ctx: AppCtx, req: Request) {
  const cart = await ctx.db.prepare('SELECT * FROM carts WHERE id = ? AND customer_id = ?').get(req.params.cartId, req.user!.id) as
    | { id: string; store_id: string; customer_id: string }
    | undefined;
  if (!cart) throw errors.notFound('Cart not found.');
  return cart;
}

async function cartDetail(ctx: AppCtx, cartId: string) {
  const cart = await ctx.db.prepare('SELECT * FROM carts WHERE id = ?').get(cartId) as { store_id: string };
  const items = await ctx.db
    .prepare(
      `SELECT ci.product_id, ci.quantity, p.name, p.sku, p.price, p.image_url, p.status,
              COALESCE(i.quantity, 0) AS stock, p.store_id
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN inventory_items i ON i.product_id = p.id
       WHERE ci.cart_id = ?`
    )
    .all(cartId) as { product_id: string; quantity: number; price: number; status: string; stock: number }[];
  const store = await ctx.db.prepare('SELECT id, name, slug, status FROM stores WHERE id = ?').get(cart.store_id);
  const merchantStatus = await ctx.db
    .prepare('SELECT m.status FROM stores s JOIN merchants m ON m.id = s.merchant_id WHERE s.id = ?')
    .get(cart.store_id) as { status: string } | undefined;
  const deliveryFee = ctx.config.deliveryFee;
  // Server-side price revalidation: totals always use current authoritative prices.
  const totals = computeTotals({
    lineSubtotals: items.map((it) => it.price * it.quantity),
    deliveryFee,
    discount: 0
  });
  const issues: string[] = [];
  for (const it of items) {
    if (!isOrderable(it.status as never)) issues.push('A product in your cart is no longer available.');
    if (it.quantity > it.stock) issues.push('A product in your cart no longer has enough stock.');
  }
  if (store && (store as { status: string }).status !== 'open') issues.push('This store is currently not accepting orders.');
  if (merchantStatus && merchantStatus.status !== 'approved') issues.push('This store is currently not accepting orders.');
  return { store, items, totals: { ...totals, deliveryFee }, issues, checkoutBlocked: issues.length > 0 };
}

export { cartDetail };
