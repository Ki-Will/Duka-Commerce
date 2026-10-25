import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  system, register, login, request, makeUser, makeMerchant, addProduct, cartWith, purchase,
  orderState, paymentState, type TestSystem
} from './helpers.js';
import { getAdapter } from '../src/services/payments/stub.js';

// Payments — UAT PAY-001..PAY-012
describe('PAY — Payments', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  async function pendingOrder(opts: { paymentMethod?: 'momo' | 'card' | 'cod'; qty?: number } = {}) {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, opts.qty ?? 1);
    const res = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: opts.paymentMethod ?? 'momo' });
    expect(res.status).toBe(201);
    return { orderId: res.body.order.id as string, paymentId: res.body.payment?.id as string | undefined, productId: p, total: res.body.order.total as number };
  }

  async function sendCallback(paymentId: string, payload: Record<string, unknown>, opts: { sign?: boolean } = {}) {
    const adapter = getAdapter(sys.ctx);
    const raw = JSON.stringify(payload);
    const signature = opts.sign === false ? undefined : adapter.sign(raw);
    return request(sys.app)
      .post('/api/v1/payments/webhooks/momo')
      .set('Content-Type', 'application/json')
      .set('x-signature', signature ?? '')
      .send(raw);
  }

  it('PAY-001: payment initiation creates a unique payment attempt', async () => {
    const { paymentId } = await pendingOrder();
    expect(paymentId).toBeTruthy();
    const row = await sys.ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId!) as { state: string; provider_ref: string; amount: number };
    expect(row.state).toBe('Pending');
    expect(row.provider_ref).toMatch(/^MOMO-STUB-/);
    expect(row.amount).toBe(15000);
    const count = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('PAY-002: mobile-money success marks payment Paid and confirms the order (Critical)', async () => {
    const { orderId, paymentId, total } = await pendingOrder();
    const sim = await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'success' });
    expect(sim.status).toBe(200);
    expect(sim.body.outcome.status).toBe('applied');
    expect(await paymentState(sys, paymentId!)).toBe('Paid');
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    expect(total).toBe(15000);
  });

  it('PAY-003: mobile-money failure never falsely confirms the order (Critical)', async () => {
    const { orderId, paymentId } = await pendingOrder();
    const sim = await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'failure' });
    expect(sim.status).toBe(200);
    expect(await paymentState(sys, paymentId!)).toBe('Failed');
    expect(await orderState(sys, orderId)).toBe('PaymentFailed');
  });

  it('PAY-004: payment timeout leaves payment non-final — never silently Paid (Critical)', async () => {
    const { orderId, paymentId } = await pendingOrder();
    const sim = await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'timeout' });
    expect(sim.status).toBe(200);
    expect(await paymentState(sys, paymentId!)).toBe('Expired');
    expect(await paymentState(sys, paymentId!)).not.toBe('Paid');
    expect(await orderState(sys, orderId)).toBe('PaymentFailed');
    // Expired cannot be resurrected by a late success callback
    const late = await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'success' });
    expect(late.status).toBe(400); // payment not awaiting result anymore
    expect(await paymentState(sys, paymentId!)).toBe('Expired');
  });

  it('PAY-005: duplicate callbacks are idempotently ignored (Critical)', async () => {
    const { orderId, paymentId, total } = await pendingOrder();
    const adapter = getAdapter(sys.ctx);
    const payload = { externalEventId: 'EVT-DUP-1', providerRef: 'MOMO-STUB-X', result: 'success', amount: total };
    // Align provider ref with the actual payment
    const pref = (await sys.ctx.db.prepare('SELECT provider_ref FROM payments WHERE id = ?').get(paymentId!) as { provider_ref: string }).provider_ref;
    payload.providerRef = pref;
    const first = await sendCallback(paymentId!, payload);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('applied');
    const second = await sendCallback(paymentId!, payload);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate');
    // Exactly one Paid event and one confirmation
    expect(await paymentState(sys, paymentId!)).toBe('Paid');
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    const confirmEvents = await sys.ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE entity_id = ? AND action = 'order.state_changed' AND detail LIKE '%"to":"Confirmed"%'`)
      .get(orderId) as { c: number };
    expect(confirmEvents.c).toBe(1);
    const eventRows = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM payment_events WHERE external_event_id = ?').get('EVT-DUP-1') as { c: number };
    expect(eventRows.c).toBe(1);
    expect(adapter.provider).toBe('momo');
  });

  it('PAY-006: invalid/unauthenticated callbacks are rejected and logged safely (Critical)', async () => {
    const { paymentId, total } = await pendingOrder();
    const pref = (await sys.ctx.db.prepare('SELECT provider_ref FROM payments WHERE id = ?').get(paymentId!) as { provider_ref: string }).provider_ref;
    const payload = { externalEventId: 'EVT-BAD-1', providerRef: pref, result: 'success', amount: total };
    // No signature
    const unsigned = await sendCallback(paymentId!, payload, { sign: false });
    expect(unsigned.status).toBe(403);
    // Wrong signature
    const wrong = await request(sys.app)
      .post('/api/v1/payments/webhooks/momo')
      .set('x-signature', 'deadbeef'.repeat(8))
      .send(JSON.stringify(payload));
    expect(wrong.status).toBe(403);
    // Malformed payload with valid signature
    const adapter = getAdapter(sys.ctx);
    const raw = 'not-json';
    const malformed = await request(sys.app)
      .post('/api/v1/payments/webhooks/momo')
      .set('x-signature', adapter.sign(raw))
      .send(raw);
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('INVALID_CALLBACK');
    // No state change, nothing applied, rejection audited
    expect(await paymentState(sys, paymentId!)).toBe('Pending');
    const rejected = await sys.ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE action = 'payment.callback.rejected'`)
      .get() as { c: number };
    expect(rejected.c).toBe(3);
    const events = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM payment_events').get() as { c: number };
    expect(events.c).toBe(0);
    // Error responses carry no stack traces or SQL
    expect(JSON.stringify(wrong.body)).not.toMatch(/stack|SELECT |sqlite/i);
  });

  it('PAY-007: duplicate payment request with same idempotency key creates one attempt', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1);
    const body = { cartId, deliveryMethod: 'pickup', paymentMethod: 'momo', idempotencyKey: 'pay-key-1' };
    const r1 = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send(body);
    const r2 = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send(body);
    expect(r1.body.payment.id).toBe(r2.body.payment.id);
    const count = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number };
    expect(count.c).toBe(1);
    // Explicit duplicate payment initiation with same key also reuses
    const init1 = await request(sys.app).post('/api/v1/payments').set('Cookie', customer.cookie)
      .send({ orderId: r1.body.order.id, idempotencyKey: 'pay-key-1:pay' });
    expect(init1.status).toBe(200);
    const count2 = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number };
    expect(count2.c).toBe(1);
  });

  it('PAY-008: payment amount tampering is rejected server-side (Critical)', async () => {
    const { paymentId, total } = await pendingOrder();
    const pref = (await sys.ctx.db.prepare('SELECT provider_ref FROM payments WHERE id = ?').get(paymentId!) as { provider_ref: string }).provider_ref;
    const tampered = await sendCallback(paymentId!, {
      externalEventId: 'EVT-TAMPER-1', providerRef: pref, result: 'success', amount: total - 5000
    });
    expect(tampered.status).toBe(400);
    expect(tampered.body.code).toBe('AMOUNT_MISMATCH');
    expect(await paymentState(sys, paymentId!)).toBe('Pending');
    expect(await orderState(sys, (await sys.ctx.db.prepare('SELECT order_id FROM payments WHERE id = ?').get(paymentId!) as { order_id: string }).order_id))
      .toBe('PendingPayment');
    const rej = await sys.ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE action = 'payment.callback.rejected' AND detail LIKE '%amount_mismatch%'`)
      .get() as { c: number };
    expect(rej.c).toBe(1);
  });

  it('PAY-009: provider payment reference is retained and visible on the order', async () => {
    const { orderId, paymentId } = await pendingOrder();
    await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'success' });
    const view = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', customer.cookie);
    expect(view.body.order.payments).toHaveLength(1);
    expect(view.body.order.payments[0].provider_ref).toMatch(/^MOMO-STUB-/);
    expect(view.body.order.payments[0].state).toBe('Paid');
  });

  it('PAY-010: operator reconciliation view shows consistent payment status and references', async () => {
    await makeUser(sys, { role: 'admin', name: 'Admin', email: 'admin@test.com' });
    const { cookie: adminCookie } = await login(sys, 'admin@test.com', 'password123');
    const { paymentId, orderId } = await pendingOrder();
    await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'success' });
    const res = await request(sys.app).get('/api/v1/admin/payments').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
    const entry = res.body.payments[0];
    expect(entry.order_id).toBe(orderId);
    expect(entry.state).toBe('Paid');
    expect(entry.provider_ref).toMatch(/^MOMO-STUB-/);
    expect(entry.order_state).toBe('Confirmed');
    expect(entry.amount).toBe(15000);
  });

  it('PAY-011: refund is initiated with the correct amount and state', async () => {
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 }) });
    const res = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Defective goods' });
    expect(res.status).toBe(201);
    expect(res.body.refund.amount).toBe(15000);
    expect(res.body.refund.state).toBe('pending');
    const pay = await sys.ctx.db.prepare('SELECT state FROM payments WHERE order_id = ?').get(orderId) as { state: string };
    expect(pay.state).toBe('RefundPending');
    // Complete refund via sandbox confirmation
    const done = await request(sys.app)
      .post(`/api/v1/merchant/orders/${orderId}/refunds/${res.body.refund.id}/complete`)
      .set('Cookie', m.ownerCookie).send({ success: true });
    expect(done.status).toBe(200);
    expect(done.body.refund.state).toBe('succeeded');
    const pay2 = await sys.ctx.db.prepare('SELECT state FROM payments WHERE order_id = ?').get(orderId) as { state: string };
    expect(pay2.state).toBe('Refunded');
  });

  it('PAY-012: duplicate refund request does not double-refund (Critical)', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p });
    const r1 = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Defective', idempotencyKey: 'refund-1' });
    expect(r1.status).toBe(201);
    const r2 = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Defective', idempotencyKey: 'refund-1' });
    expect(r2.status).toBe(200);
    expect(r2.body.reused).toBe(true);
    // Different key but refund already pending also refused
    const r3 = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Again' });
    expect(r3.status).toBe(200);
    const count = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM refunds').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('webhook with unknown provider reference is rejected', async () => {
    const raw = JSON.stringify({ externalEventId: 'EVT-UNKNOWN', providerRef: 'NOPE', result: 'success', amount: 100 });
    const adapter = getAdapter(sys.ctx);
    const res = await request(sys.app).post('/api/v1/payments/webhooks/momo')
      .set('x-signature', adapter.sign(raw)).send(raw);
    expect(res.status).toBe(404);
  });

  it('payment retry after failure moves order back to PendingPayment', async () => {
    const { orderId, paymentId } = await pendingOrder();
    await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'failure' });
    expect(await orderState(sys, orderId)).toBe('PaymentFailed');
    const retry = await request(sys.app).post('/api/v1/payments').set('Cookie', customer.cookie)
      .send({ orderId, idempotencyKey: 'retry-1' });
    expect(retry.status).toBe(201);
    expect(await orderState(sys, orderId)).toBe('PendingPayment');
    expect(retry.body.payment.id).not.toBe(paymentId);
    const count = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM payments WHERE order_id = ?').get(orderId) as { c: number };
    expect(count.c).toBe(2);
  });
});
