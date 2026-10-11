import { now, tx } from '../db/index.js';
import type { AppCtx } from '../context.js';
import { errors } from '../domain/errors.js';
import {
  canTransition,
  customerCanCancel,
  releasesStock,
  transitionOrder,
  type OrderState
} from '../domain/orderState.js';
import { releaseStock } from './inventory.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { getOrderRow, getOrderItems, notifyMerchantNewOrder, type OrderRow } from './checkout.js';

export type TransitionActor = 'system' | 'customer' | 'merchant' | 'admin';

export interface TransitionInput {
  orderId: string;
  to: OrderState;
  actor: TransitionActor;
  actorId?: string | null;
  actorRole?: string | null;
  reason?: string | null;
  traceId?: string;
  silentNotify?: boolean;
}

/**
 * FR-ORD-09/10: the single path for order state changes. Rejects illegal
 * transitions, releases stock when policy says so (INV-005), records audit
 * (FR-AUD-02) and queues notifications (BR-14 — never the source of truth).
 */
export function applyTransition(ctx: AppCtx, input: TransitionInput): OrderRow {
  return tx(ctx.db, () => {
    const order = getOrderRow(ctx, input.orderId);
    if (!order) throw errors.notFound('Order not found.');
    const from = order.state;

    try {
      transitionOrder(from, input.to, input.actor);
    } catch {
      throw errors.badRequest('ILLEGAL_STATE_TRANSITION', `Cannot move order from ${from} to ${input.to}.`);
    }

    const ts = now();
    if ((input.to === 'Cancelled' || input.to === 'Rejected') && input.reason) {
      // Cancellation/rejection reason retained on the order (ORD-008, REF-003).
      ctx.db
        .prepare('UPDATE orders SET state = ?, cancel_reason = ?, updated_at = ? WHERE id = ?')
        .run(input.to, input.reason, ts, order.id);
    } else {
      ctx.db.prepare('UPDATE orders SET state = ?, updated_at = ? WHERE id = ?').run(input.to, ts, order.id);
    }

    // INV-005: cancellation/rejection releases reserved stock.
    if (releasesStock(from, input.to)) {
      for (const item of getOrderItems(ctx, order.id) as { product_id: string; quantity: number }[]) {
        releaseStock(ctx, item.product_id, item.quantity, order.id);
      }
    }

    audit(ctx, {
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? input.actor,
      action: 'order.state_changed',
      entity: 'order',
      entityId: order.id,
      detail: { orderNumber: order.order_number, from, to: input.to, reason: input.reason ?? null },
      traceId: input.traceId
    });

    if (!input.silentNotify) {
      notifyOrderState(ctx, order, from, input.to, input.reason ?? null);
    }

    return getOrderRow(ctx, order.id)!;
  });
}

const STATE_LABEL: Partial<Record<OrderState, string>> = {
  Confirmed: 'confirmed',
  PaymentFailed: 'payment failed',
  Accepted: 'accepted by the merchant',
  Rejected: 'rejected by the merchant',
  Preparing: 'being prepared',
  ReadyForDispatch: 'ready for dispatch',
  Dispatched: 'dispatched',
  Delivered: 'delivered',
  Completed: 'completed',
  Cancelled: 'cancelled'
};

function notifyOrderState(ctx: AppCtx, order: OrderRow, from: OrderState, to: OrderState, reason: string | null): void {
  const label = STATE_LABEL[to] ?? to;
  // NOT-003: customer notified on fulfillment status changes; minimal data (NOT-006).
  notify(ctx, {
    type: 'order.status',
    recipient: order.customer_id,
    subject: `Order ${order.order_number} ${label}`,
    body: `Order ${order.order_number} is now ${label}.`
  });

  if (to === 'Confirmed' && from === 'PendingPayment') {
    // Payment confirmed → notify merchant of new order (NOT-001).
    const store = ctx.db.prepare('SELECT name, merchant_id FROM stores WHERE id = ?').get(order.store_id) as
      | { name: string; merchant_id: string }
      | undefined;
    const merchant = store
      ? (ctx.db.prepare('SELECT owner_user_id FROM merchants WHERE id = ?').get(store.merchant_id) as
          | { owner_user_id: string }
          | undefined)
      : undefined;
    if (merchant && store) {
      notify(ctx, {
        type: 'order.new',
        recipient: merchant.owner_user_id,
        subject: `New order ${order.order_number}`,
        body: `New order ${order.order_number} received for ${store.name}.`
      });
    }
  }

  if (to === 'Cancelled' || to === 'Rejected') {
    const store = ctx.db.prepare('SELECT name, merchant_id FROM stores WHERE id = ?').get(order.store_id) as
      | { name: string; merchant_id: string }
      | undefined;
    const merchant = store
      ? (ctx.db.prepare('SELECT owner_user_id FROM merchants WHERE id = ?').get(store.merchant_id) as
          | { owner_user_id: string }
          | undefined)
      : undefined;
    if (merchant) {
      notify(ctx, {
        type: 'order.cancelled',
        recipient: merchant.owner_user_id,
        subject: `Order ${order.order_number} ${label}`,
        body: `Order ${order.order_number} is ${label}${reason ? `: ${reason}` : '.'}`
      });
    }
  }
}

/** Customer cancellation policy (FR-ORD-11, FR-REF-01, REF-001/002). */
export function customerCancel(ctx: AppCtx, orderId: string, customerId: string, reason?: string): OrderRow {
  const order = getOrderRow(ctx, orderId);
  if (!order || order.customer_id !== customerId) throw errors.notFound('Order not found.');
  if (!customerCanCancel(order.state)) {
    throw errors.badRequest(
      'CANCELLATION_NOT_ALLOWED',
      'This order can no longer be cancelled.'
    );
  }
  if (order.state === 'Cancelled') {
    // REF-006: duplicate cancellation is a no-op, not a second side effect.
    return order;
  }
  return applyTransition(ctx, {
    orderId,
    to: 'Cancelled',
    actor: 'customer',
    actorId: customerId,
    actorRole: 'customer',
    reason: reason ?? 'Customer cancelled'
  });
}

export function assertOrderVisibleToCustomer(ctx: AppCtx, orderId: string, customerId: string): OrderRow {
  const order = getOrderRow(ctx, orderId);
  if (!order || order.customer_id !== customerId) throw errors.notFound('Order not found.');
  return order;
}

export function orderSummary(ctx: AppCtx, order: OrderRow) {
  const items = getOrderItems(ctx, order.id);
  const payments = ctx.db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at').all(order.id);
  const refunds = ctx.db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at').all(order.id);
  const store = ctx.db.prepare('SELECT id, name, slug FROM stores WHERE id = ?').get(order.store_id);
  const customer = ctx.db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(order.customer_id);
  const customerPhone = ctx.db.prepare('SELECT phone FROM users WHERE id = ?').get(order.customer_id) as
    | { phone: string | null }
    | undefined;
  return {
    ...order,
    address_snapshot: JSON.parse(order.address_snapshot || '{}'),
    items,
    payments,
    refunds,
    store,
    customer: customer ? { ...(customer as object), phone: customerPhone?.phone ?? null } : null
  };
}

export { canTransition, notifyMerchantNewOrder };
