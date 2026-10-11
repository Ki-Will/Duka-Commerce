import { uuid, now, j, tx } from '../../db/index.js';
import type { AppCtx } from '../../context.js';
import { errors } from '../../domain/errors.js';
import { canPaymentTransition, transitionPayment, type PaymentState } from '../../domain/paymentState.js';
import { applyTransition } from '../orders.js';
import { getOrderRow, notifyMerchantNewOrder, type OrderRow } from '../checkout.js';
import { audit } from '../audit.js';
import { notify } from '../notifications.js';
import { getAdapter } from './stub.js';
import type { CallbackPayload } from './adapter.js';

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: string;
  state: PaymentState;
  amount: number;
  idempotency_key: string | null;
  provider_ref: string | null;
  created_at: string;
  updated_at: string;
}

/** FR-PAY-01..04: idempotent payment initiation with a unique attempt id. */
export function initiatePayment(ctx: AppCtx, input: {
  orderId: string;
  idempotencyKey?: string | null;
  customerPhone?: string | null;
  traceId?: string;
}): { payment: PaymentRow; checkoutUrl: string; reused: boolean } {
  if (input.idempotencyKey) {
    const existing = ctx.db
      .prepare('SELECT * FROM payments WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as unknown as PaymentRow | undefined;
    if (existing) {
      const adapter = getAdapter(ctx);
      return {
        payment: existing,
        checkoutUrl: `https://sandbox.momo.example/pay/${existing.provider_ref ?? ''}?amount=${existing.amount}`,
        reused: true
      };
    }
  }

  const order = getOrderRow(ctx, input.orderId);
  if (!order) throw errors.notFound('Order not found.');
  if (order.payment_method === 'cod') {
    throw errors.badRequest('PAYMENT_NOT_REQUIRED', 'Cash on delivery orders do not require online payment.');
  }
  if (order.state !== 'PendingPayment' && order.state !== 'PaymentFailed') {
    throw errors.badRequest('PAYMENT_NOT_POSSIBLE', 'This order is not awaiting payment.');
  }

  const adapter = getAdapter(ctx);
  const initiated = adapter.initiate({
    orderId: order.id,
    orderNumber: order.order_number,
    amount: order.total, // amount comes from the server-side order total (PAY-008)
    customerPhone: input.customerPhone ?? null
  });

  const paymentId = uuid();
  const ts = now();
  tx(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO payments (id, order_id, provider, state, amount, idempotency_key, provider_ref, created_at, updated_at)
         VALUES (?, ?, ?, 'Initiated', ?, ?, ?, ?, ?)`
      )
      .run(paymentId, order.id, adapter.provider, order.total, input.idempotencyKey ?? null, initiated.providerRef, ts, ts);
    ctx.db
      .prepare(`UPDATE payments SET state = 'Pending', updated_at = ? WHERE id = ?`)
      .run(now(), paymentId);
    audit(ctx, {
      actorId: order.customer_id,
      actorRole: 'customer',
      action: 'payment.initiated',
      entity: 'payment',
      entityId: paymentId,
      detail: { orderId: order.id, provider: adapter.provider, amount: order.total },
      traceId: input.traceId
    });
    // Order waits in PendingPayment until authoritative confirmation (BR-05).
    if (order.state === 'PaymentFailed') {
      applyTransition(ctx, {
        orderId: order.id,
        to: 'PendingPayment',
        actor: 'system',
        reason: 'payment retry',
        traceId: input.traceId
      });
    }
  });

  return { payment: ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as unknown as PaymentRow, checkoutUrl: initiated.checkoutUrl, reused: false };
}

export interface CallbackOutcome {
  status: 'applied' | 'duplicate' | 'ignored';
  paymentState: PaymentState;
  orderState?: string;
}

/**
 * SRS §11.4 payment callback processing: authenticate → identify attempt →
 * dedupe → atomic update → order transition only when valid → audit → ack.
 */
export function processCallback(
  ctx: AppCtx,
  provider: string,
  rawBody: string,
  signature: string | undefined,
  traceId?: string
): CallbackOutcome {
  const adapter = getAdapter(ctx);

  // SEC-11 / PAY-006: unauthenticated callbacks are rejected and logged safely.
  if (!adapter.verifySignature(rawBody, signature)) {
    ctx.log({ level: 'warn', event: 'payment.callback.rejected', result: 'invalid_signature', requestId: traceId });
    audit(ctx, {
      action: 'payment.callback.rejected',
      entity: 'payment',
      detail: { provider, reason: 'invalid_signature' },
      traceId: traceId ?? null
    });
    throw errors.forbidden('Callback signature verification failed.');
  }

  let payload: CallbackPayload;
  try {
    payload = JSON.parse(rawBody) as CallbackPayload;
    if (!payload.externalEventId || !payload.providerRef || !payload.result) throw new Error('missing fields');
  } catch {
    audit(ctx, {
      action: 'payment.callback.rejected',
      entity: 'payment',
      detail: { provider, reason: 'malformed' },
      traceId: traceId ?? null
    });
    ctx.log({ level: 'warn', event: 'payment.callback.rejected', result: 'malformed', requestId: traceId });
    throw errors.badRequest('INVALID_CALLBACK', 'Malformed callback payload.');
  }

  // ---- Validation happens before the transaction so rejection audits persist ----

  // PAY-005: duplicate callbacks are idempotently ignored.
  const seen = ctx.db.prepare('SELECT payment_id FROM payment_events WHERE external_event_id = ?').get(payload.externalEventId) as
    | { payment_id: string }
    | undefined;

  const payment = ctx.db.prepare('SELECT * FROM payments WHERE provider_ref = ? AND provider = ?').get(payload.providerRef, provider) as
    | PaymentRow
    | undefined;
  if (!payment) throw errors.notFound('Payment attempt not found for callback.');

  if (seen) {
    return { status: 'duplicate' as const, paymentState: payment.state };
  }

  const order = getOrderRow(ctx, payment.order_id);
  if (!order) throw errors.notFound('Order not found for payment.');

  // PAY-008: amount must match the server-side order total.
  if (payload.amount !== payment.amount || payload.amount !== order.total) {
    audit(ctx, {
      action: 'payment.callback.rejected',
      entity: 'payment',
      entityId: payment.id,
      detail: { reason: 'amount_mismatch', expected: order.total, received: payload.amount },
      traceId: traceId ?? null
    });
    ctx.log({ level: 'error', event: 'payment.callback.rejected', result: 'amount_mismatch', requestId: traceId });
    throw errors.badRequest('AMOUNT_MISMATCH', 'Payment amount does not match the order total.');
  }

  const target: PaymentState =
    payload.result === 'success' ? 'Paid' : payload.result === 'failure' ? 'Failed' : 'Expired';

  // Late/illegal callbacks for a finalised payment never mutate state (BR-05, PAY-004).
  if (!canPaymentTransition(payment.state, target)) {
    audit(ctx, {
      action: 'payment.callback.rejected',
      entity: 'payment',
      entityId: payment.id,
      detail: { reason: 'illegal_state', from: payment.state, to: target },
      traceId: traceId ?? null
    });
    ctx.log({ level: 'warn', event: 'payment.callback.rejected', result: 'illegal_state', requestId: traceId });
    throw errors.badRequest('PAYMENT_STATE_INVALID', `Payment cannot move from ${payment.state} to ${target}.`);
  }

  return tx(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO payment_events (external_event_id, payment_id, payload, applied, created_at) VALUES (?, ?, ?, 1, ?)`
      )
      .run(payload.externalEventId, payment.id, j(payload), now());

    // Timeout/failure never becomes Paid (BR-05, NFR-REL-04, PAY-004).
    const nextState = transitionPayment(payment.state, target);
    ctx.db.prepare('UPDATE payments SET state = ?, updated_at = ? WHERE id = ?').run(nextState, now(), payment.id);

    let orderState = order.state;
    if (nextState === 'Paid') {
      if (order.state === 'PendingPayment' || order.state === 'PaymentFailed') {
        orderState = applyTransition(ctx, {
          orderId: order.id,
          to: 'Confirmed',
          actor: 'system',
          reason: 'payment confirmed',
          traceId,
          silentNotify: true
        }).state;
        // NOT-001/NOT-002: merchant + customer notified once payment is confirmed.
        notifyMerchantNewOrder(ctx, order.id, order.store_id, order.customer_id);
        notify(ctx, {
          type: 'payment.success',
          recipient: order.customer_id,
          subject: `Payment received for ${order.order_number}`,
          body: `We received your payment for order ${order.order_number}.`
        });
      }
    } else if (nextState === 'Failed' || nextState === 'Expired') {
      if (order.state === 'PendingPayment') {
        orderState = applyTransition(ctx, {
          orderId: order.id,
          to: 'PaymentFailed',
          actor: 'system',
          reason: `payment ${nextState.toLowerCase()}`,
          traceId,
          silentNotify: true
        }).state;
        notify(ctx, {
          type: 'payment.failed',
          recipient: order.customer_id,
          subject: `Payment ${nextState.toLowerCase()} for ${order.order_number}`,
          body: `Your payment for order ${order.order_number} did not complete. You can try again.`
        });
      }
    }

    audit(ctx, {
      actorId: null,
      actorRole: 'system',
      action: `payment.${nextState.toLowerCase()}`,
      entity: 'payment',
      entityId: payment.id,
      detail: { orderId: order.id, externalEventId: payload.externalEventId, result: payload.result },
      traceId: traceId ?? null
    });

    ctx.log({
      level: 'info',
      event: 'payment.callback.applied',
      result: nextState,
      requestId: traceId,
      paymentId: payment.id
    });

    return { status: 'applied' as const, paymentState: nextState, orderState };
  });
}

export function getPaymentForOrder(ctx: AppCtx, orderId: string): PaymentRow | undefined {
  return ctx.db
    .prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(orderId) as PaymentRow | undefined;
}

/** FR-PAY-09 / REF-*: refund lifecycle kept separate from order state (BR-13). */
export function requestRefund(ctx: AppCtx, input: {
  orderId: string;
  actorId: string;
  actorRole: string;
  reason?: string;
  idempotencyKey?: string | null;
  traceId?: string;
}) {
  if (input.idempotencyKey) {
    const existing = ctx.db.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').get(input.idempotencyKey);
    if (existing) return { refund: existing, reused: true };
  }
  const order = getOrderRow(ctx, input.orderId);
  if (!order) throw errors.notFound('Order not found.');
  const payment = getPaymentForOrder(ctx, input.orderId);
  if (!payment) {
    throw errors.badRequest('REFUND_NOT_POSSIBLE', 'Only paid orders can be refunded.');
  }
  const duplicate = ctx.db
    .prepare(`SELECT * FROM refunds WHERE payment_id = ? AND state IN ('pending','succeeded')`)
    .get(payment.id);
  if (duplicate) {
    // PAY-012: duplicate refund request does not double-refund.
    return { refund: duplicate, reused: true };
  }
  if (payment.state !== 'Paid') {
    throw errors.badRequest('REFUND_NOT_POSSIBLE', 'Only paid orders can be refunded.');
  }

  const refundId = uuid();
  const ts = now();
  tx(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO refunds (id, payment_id, order_id, amount, state, reason, actor_id, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
      )
      .run(refundId, payment.id, order.id, payment.amount, input.reason ?? '', input.actorId, input.idempotencyKey ?? null, ts, ts);
    const nextPayment = transitionPayment(payment.state, 'RefundPending');
    ctx.db.prepare('UPDATE payments SET state = ?, updated_at = ? WHERE id = ?').run(nextPayment, now(), payment.id);
    audit(ctx, {
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: 'refund.initiated',
      entity: 'refund',
      entityId: refundId,
      detail: { orderId: order.id, amount: payment.amount, reason: input.reason ?? null },
      traceId: input.traceId ?? null
    });
    notify(ctx, {
      type: 'refund.initiated',
      recipient: order.customer_id,
      subject: `Refund initiated for ${order.order_number}`,
      body: `A refund for order ${order.order_number} has been initiated.`
    });
  });
  return { refund: ctx.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId), reused: false };
}

/** Sandbox-only helper for demos/tests: provider confirms the refund. */
export function completeRefund(ctx: AppCtx, refundId: string, success: boolean) {
  const refund = ctx.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as
    | { id: string; payment_id: string; order_id: string; amount: number; state: string }
    | undefined;
  if (!refund) throw errors.notFound('Refund not found.');
  if (refund.state !== 'pending') return refund;
  tx(ctx.db, () => {
    const payment = ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(refund.payment_id) as unknown as PaymentRow;
    if (success) {
      ctx.db.prepare(`UPDATE refunds SET state = 'succeeded', updated_at = ? WHERE id = ?`).run(now(), refund.id);
      const next = transitionPayment(payment.state, 'Refunded');
      ctx.db.prepare('UPDATE payments SET state = ?, updated_at = ? WHERE id = ?').run(next, now(), payment.id);
      notify(ctx, {
        type: 'refund.succeeded',
        recipient: (ctx.db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(refund.order_id) as { customer_id: string }).customer_id,
        subject: 'Refund completed',
        body: `Your refund for the order has been completed.`
      });
    } else {
      ctx.db.prepare(`UPDATE refunds SET state = 'failed', updated_at = ? WHERE id = ?`).run(now(), refund.id);
      const next = transitionPayment(payment.state, 'RefundFailed');
      ctx.db.prepare('UPDATE payments SET state = ?, updated_at = ? WHERE id = ?').run(next, now(), payment.id);
    }
    audit(ctx, {
      actorId: null,
      actorRole: 'system',
      action: success ? 'refund.succeeded' : 'refund.failed',
      entity: 'refund',
      entityId: refund.id,
      detail: { paymentId: payment.id }
    });
  });
  return ctx.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
}
