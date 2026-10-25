import { uuid, now, j, tx } from '../db/index.js';
import type { AppCtx } from '../context.js';
import { errors } from '../domain/errors.js';
import { computeTotals } from '../domain/money.js';
import { isOrderable } from '../domain/productState.js';
import type { OrderState } from '../domain/orderState.js';
import { reserveStock } from './inventory.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';

export interface CheckoutInput {
  customerId: string;
  cartId: string;
  addressId?: string | null;
  deliveryMethod: 'delivery' | 'pickup';
  paymentMethod: 'momo' | 'card' | 'cod';
  notes?: string;
  idempotencyKey?: string | null;
  traceId?: string;
}

export interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  store_id: string;
  state: OrderState;
  payment_method: 'momo' | 'card' | 'cod';
  delivery_method: 'delivery' | 'pickup';
  subtotal: number;
  delivery_fee: number;
  discount: number;
  total: number;
  address_snapshot: string;
  cancel_reason: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

let orderCounter = 0;

function nextOrderNumber(): string {
  orderCounter += 1;
  const ts = new Date();
  const ymd = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DC-${ymd}-${String(orderCounter).padStart(4, '0')}-${rand}`;
}

export async function findByIdempotencyKey(ctx: AppCtx, key: string): Promise<OrderRow | undefined> {
  return await ctx.db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(key) as OrderRow | undefined;
}

export async function getOrderRow(ctx: AppCtx, orderId: string): Promise<OrderRow | undefined> {
  return await ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined;
}

export async function getOrderItems(ctx: AppCtx, orderId: string) {
  return await ctx.db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
}

/**
 * UC-DC-05 / FR-ORD-01..05, BR-01..BR-08.
 * One transaction: validate product state → revalidate price → atomic stock
 * reservation → order creation → event/notification records (SRS §11.4).
 */
export async function checkout(ctx: AppCtx, input: CheckoutInput): Promise<OrderRow> {
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(ctx, input.idempotencyKey);
    if (existing) {
      if (existing.customer_id !== input.customerId) {
        throw errors.conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key already used.');
      }
      return existing; // duplicate submission is safe (FR-ORD-03, CART-011)
    }
  }

  try {
    return await tx(ctx.db, async () => {
    const cart = await ctx.db.prepare('SELECT * FROM carts WHERE id = ? AND customer_id = ?').get(input.cartId, input.customerId) as
      | { id: string; store_id: string; customer_id: string }
      | undefined;
    if (!cart) throw errors.notFound('Cart not found.');

    const store = await ctx.db
      .prepare('SELECT s.*, m.status AS merchant_status FROM stores s JOIN merchants m ON m.id = s.merchant_id WHERE s.id = ?')
      .get(cart.store_id) as { id: string; name: string; status: string; merchant_status: string } | undefined;
    if (!store) throw errors.notFound('Store not found.');
    if (store.status !== 'open') {
      throw errors.conflict('STORE_NOT_ACCEPTING_ORDERS', 'This store is not accepting orders.');
    }
    if (store.merchant_status !== 'approved') {
      throw errors.conflict('STORE_NOT_ACCEPTING_ORDERS', 'This store is not accepting orders.');
    }

    const items = await ctx.db
      .prepare(
        `SELECT ci.product_id, ci.quantity, p.name, p.sku, p.price, p.status, p.store_id
         FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ?`
      )
      .all(cart.id) as {
      product_id: string;
      quantity: number;
      name: string;
      sku: string;
      price: number;
      status: string;
      store_id: string;
    }[];

    if (items.length === 0) throw errors.badRequest('CART_EMPTY', 'Your cart is empty.');

    // BR-01: single-store checkout per order.
    for (const item of items) {
      if (item.store_id !== cart.store_id) {
        throw errors.badRequest('MULTI_STORE_CART', 'A checkout can only contain products from one store.');
      }
      // BR-08 / FR-CAT-11: only published products are orderable.
      if (!isOrderable(item.status as never)) {
        throw errors.badRequest('PRODUCT_NOT_ORDERABLE', `"${item.name}" is no longer available.`);
      }
    }

    // Address snapshot (FR-FUL-04, FUL-008).
    let addressSnapshot: Record<string, string> = {};
    if (input.deliveryMethod === 'delivery') {
      if (!input.addressId) {
        throw errors.badRequest('ADDRESS_REQUIRED', 'A delivery address is required.');
      }
      const addr = await ctx.db
        .prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
        .get(input.addressId, input.customerId) as
        | { id: string; name: string; line1: string; line2: string; city: string; phone: string }
        | undefined;
      if (!addr) throw errors.badRequest('ADDRESS_REQUIRED', 'A valid delivery address is required.');
      addressSnapshot = {
        name: addr.name,
        line1: addr.line1,
        line2: addr.line2,
        city: addr.city,
        phone: addr.phone
      };
    } else {
      const customer = await ctx.db.prepare('SELECT name, phone FROM users WHERE id = ?').get(input.customerId) as
        | { name: string; phone: string | null }
        | undefined;
      addressSnapshot = { name: customer?.name ?? '', line1: 'Store pickup', line2: '', city: '', phone: customer?.phone ?? '' };
    }

    // FR-CART-05/06/07: prices revalidated server-side at checkout; the current
    // valid price is used (never a stale client-supplied price — BR-03).
    const lineSubtotals = items.map((it) => it.quantity * it.price);
    const deliveryFee = input.deliveryMethod === 'pickup' ? 0 : ctx.config.deliveryFee;
    const totals = computeTotals({ lineSubtotals, deliveryFee, discount: 0 });

    const orderId = uuid();
    const orderNumber = nextOrderNumber();
    const state: OrderState = input.paymentMethod === 'cod' ? 'Confirmed' : 'PendingPayment'; // COD accepted
    const ts = now();

    await ctx.db
      .prepare(
        `INSERT INTO orders (id, order_number, customer_id, store_id, state, payment_method, delivery_method,
           subtotal, delivery_fee, discount, total, address_id, address_snapshot, notes, idempotency_key,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        orderId,
        orderNumber,
        input.customerId,
        cart.store_id,
        state,
        input.paymentMethod,
        input.deliveryMethod,
        totals.subtotal,
        totals.deliveryFee,
        totals.discount,
        totals.total,
        input.deliveryMethod === 'delivery' ? (input.addressId ?? null) : null,
        j(addressSnapshot),
        input.notes ?? '',
        input.idempotencyKey ?? null,
        ts,
        ts
      );

    for (const item of items) {
      const lineTotal = item.quantity * item.price;
      await ctx.db
        .prepare(
          `INSERT INTO order_items (id, order_id, product_id, product_name, sku, unit_price, quantity, discount, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(uuid(), orderId, item.product_id, item.name, item.sku, item.price, item.quantity, lineTotal);
      // Stock reservation/commit is server-controlled (FR-INV-04/05).
      await reserveStock(ctx, item.product_id, item.quantity, orderId);
    }

    // Cart is single-use per checkout.
    await ctx.db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cart.id);

    await audit(ctx, {
      actorId: input.customerId,
      actorRole: 'customer',
      action: 'order.created',
      entity: 'order',
      entityId: orderId,
      detail: { orderNumber, state, total: totals.total, storeId: cart.store_id },
      traceId: input.traceId
    });

    if (state === 'Confirmed') {
      await notifyMerchantNewOrder(ctx, orderId, cart.store_id, input.customerId);
    }

    return (await getOrderRow(ctx, orderId))!;
    });
  } catch (err) {
    // Concurrent double-submit (FR-ORD-03 / CART-011): under Postgres both
    // requests run in parallel, so the pre-check above can miss an order that
    // commits between it and our insert. The loser rolls back on the
    // UNIQUE(idempotency_key) violation — return the winner instead of a 500.
    // (SQLite serialises requests, so it only reaches the pre-check path.)
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const existing = await findByIdempotencyKey(ctx, input.idempotencyKey);
      if (existing && existing.customer_id === input.customerId) return existing;
      if (existing) throw errors.conflict('IDEMPOTENCY_CONFLICT', 'Idempotency key already used.');
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null | undefined;
  return e?.code === '23505' || /UNIQUE constraint failed/i.test(String(e?.message));
}

async function notifyMerchantNewOrder(ctx: AppCtx, orderId: string, storeId: string, customerId: string): Promise<void> {
  const order = await getOrderRow(ctx, orderId);
  const store = await ctx.db.prepare('SELECT name, merchant_id FROM stores WHERE id = ?').get(storeId) as
    | { name: string; merchant_id: string }
    | undefined;
  const merchant = store
    ? (await ctx.db.prepare('SELECT owner_user_id FROM merchants WHERE id = ?').get(store.merchant_id) as
        | { owner_user_id: string }
        | undefined)
    : undefined;
  if (!order || !store || !merchant) return;
  // NOT-001: merchant notified of a new confirmed order.
  await notify(ctx, {
    type: 'order.new',
    recipient: merchant.owner_user_id,
    subject: `New order ${order.order_number}`,
    body: `New order ${order.order_number} received for ${store.name}.`
  });
  await notify(ctx, {
    type: 'order.confirmed',
    recipient: customerId,
    subject: `Order ${order.order_number} confirmed`,
    body: `Your order ${order.order_number} has been confirmed.`
  });
}

export { notifyMerchantNewOrder };
