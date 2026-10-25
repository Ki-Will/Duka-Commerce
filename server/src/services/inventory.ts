import { uuid, now } from '../db/index.js';
import type { AppCtx } from '../context.js';
import { errors } from '../domain/errors.js';
import { notify } from './notifications.js';

export async function getStock(ctx: AppCtx, productId: string): Promise<number> {
  const row = await ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(productId) as
    | { quantity: number }
    | undefined;
  return row?.quantity ?? 0;
}

async function recordMovement(
  ctx: AppCtx,
  input: { productId: string; delta: number; reason: string; actorId?: string | null; orderId?: string | null }
): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO inventory_movements (id, product_id, delta, reason, actor_id, order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(uuid(), input.productId, input.delta, input.reason, input.actorId ?? null, input.orderId ?? null, now());
}

async function maybeLowStockEvent(ctx: AppCtx, productId: string): Promise<void> {
  const row = await ctx.db
    .prepare(
      `SELECT i.quantity, i.low_stock_threshold, s.id AS store_id, s.name AS store_name, p.name AS product_name,
              m.owner_user_id
       FROM inventory_items i
       JOIN products p ON p.id = i.product_id
       JOIN stores s ON s.id = p.store_id
       JOIN merchants m ON m.id = s.merchant_id
       WHERE i.product_id = ?`
    )
    .get(productId) as
    | { quantity: number; low_stock_threshold: number; store_id: string; store_name: string; product_name: string; owner_user_id: string }
    | undefined;
  if (!row) return;
  if (row.quantity < row.low_stock_threshold) {
    // INV-007 / FR-INV-07: low-stock event when threshold is crossed.
    await notify(ctx, {
      type: 'low_stock',
      recipient: row.owner_user_id,
      subject: `Low stock: ${row.product_name}`,
      body: `${row.product_name} in ${row.store_name} is down to ${row.quantity} unit(s).`
    });
  }
}

/**
 * Atomic conditional stock change (FR-INV-04/05): the WHERE guard makes the
 * decrement fail rather than go negative (INV-008), safe under concurrency
 * (INV-006 / NF-003) because SQLite serializes the IMMEDIATE transaction.
 */
export async function changeStock(
  ctx: AppCtx,
  input: {
    productId: string;
    delta: number;
    reason: string;
    actorId?: string | null;
    orderId?: string | null;
    allowZeroTarget?: boolean;
  }
): Promise<number> {
  const res = await ctx.db
    .prepare(
      `UPDATE inventory_items SET quantity = quantity + ?
       WHERE product_id = ? AND quantity + ? >= 0`
    )
    .run(input.delta, input.productId, input.delta);
  if (Number(res.changes ?? 0) === 0) {
    const exists = await ctx.db.prepare('SELECT 1 FROM inventory_items WHERE product_id = ?').get(input.productId);
    if (!exists) throw errors.notFound('Product inventory record not found.');
    throw errors.badRequest('INVENTORY_NEGATIVE', 'Adjustment would make stock negative.');
  }
  await recordMovement(ctx, {
    productId: input.productId,
    delta: input.delta,
    reason: input.reason,
    actorId: input.actorId,
    orderId: input.orderId
  });
  await maybeLowStockEvent(ctx, input.productId);
  return await getStock(ctx, input.productId);
}

/** Reserve (consume) stock for an order inside the checkout transaction. */
export async function reserveStock(ctx: AppCtx, productId: string, qty: number, orderId: string): Promise<void> {
  const res = await ctx.db
    .prepare(`UPDATE inventory_items SET quantity = quantity - ? WHERE product_id = ? AND quantity >= ?`)
    .run(qty, productId, qty);
  if (Number(res.changes ?? 0) === 0) {
    throw errors.badRequest(
      'ORDER_STOCK_UNAVAILABLE',
      'One or more items are no longer available in the requested quantity.'
    );
  }
  await recordMovement(ctx, { productId, delta: -qty, reason: 'order_reserve', orderId });
  await maybeLowStockEvent(ctx, productId);
}

/** Release reserved stock on cancellation/rejection (INV-005). */
export async function releaseStock(ctx: AppCtx, productId: string, qty: number, orderId: string): Promise<void> {
  await changeStock(ctx, { productId, delta: qty, reason: 'order_release', orderId });
}

export async function inventoryView(ctx: AppCtx, storeId: string) {
  return await ctx.db
    .prepare(
      `SELECT p.id AS product_id, p.name, p.sku, p.status, i.quantity, i.low_stock_threshold,
              CASE WHEN i.quantity < i.low_stock_threshold THEN 1 ELSE 0 END AS low_stock
       FROM products p JOIN inventory_items i ON i.product_id = p.id
       WHERE p.store_id = ? ORDER BY p.name`
    )
    .all(storeId);
}
