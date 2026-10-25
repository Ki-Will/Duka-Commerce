import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { system, register, request, makeMerchant, addProduct, purchase, orderState, type TestSystem } from './helpers.js';

// Cancellations & refunds — UAT REF-001..REF-006
describe('REF — Cancellations & refunds', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  async function paidOrder(qty = 1) {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    return await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, quantity: qty });
  }

  it('REF-001: customer cancels an eligible order successfully', async () => {
    const { orderId } = await paidOrder();
    const res = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({ reason: 'No longer needed' });
    expect(res.status).toBe(200);
    expect(res.body.order.state).toBe('Cancelled');
    expect(res.body.order.cancel_reason).toBe('No longer needed');
  });

  it('REF-002: customer cancellation in an ineligible state is rejected safely', async () => {
    const { orderId } = await paidOrder();
    // Progress beyond the cancellable window
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'Preparing' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'ReadyForDispatch' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'Dispatched' });
    const res = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({ reason: 'too late' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANCELLATION_NOT_ALLOWED');
    expect(res.body.message).toMatch(/no longer be cancelled/i);
    expect(await orderState(sys, orderId)).toBe('Dispatched');
    // Stock remains consumed for a dispatched order
    const movements = await sys.ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM inventory_movements WHERE reason = 'order_release'`)
      .get() as { c: number };
    expect(movements.c).toBe(0);
  });

  it('REF-003: merchant cancellation records actor and reason', async () => {
    const { orderId } = await paidOrder();
    const noReason = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/cancel`)
      .set('Cookie', m.ownerCookie).send({});
    expect(noReason.status).toBe(400);
    const res = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/cancel`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Item found damaged in store' });
    expect(res.status).toBe(200);
    const auditRow = await sys.ctx.db
      .prepare(`SELECT * FROM audit_events WHERE entity_id = ? AND action = 'order.state_changed' AND detail LIKE '%Cancelled%'`)
      .get(orderId) as { actor_id: string; actor_role: string; detail: string; created_at: string } | undefined;
    expect(auditRow).toBeTruthy();
    expect(auditRow!.actor_id).toBe(m.ownerUserId);
    expect(auditRow!.actor_role).toBe('owner');
    expect(auditRow!.detail).toContain('Item found damaged in store');
    expect(new Date(auditRow!.created_at).getTime()).toBeGreaterThan(0);
    const order = await sys.ctx.db.prepare('SELECT cancel_reason FROM orders WHERE id = ?').get(orderId) as { cancel_reason: string };
    expect(order.cancel_reason).toBe('Item found damaged in store');
  });

  it('REF-004: refund status is visible on the order', async () => {
    const { orderId } = await paidOrder();
    const refund = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Customer complaint upheld' });
    expect(refund.status).toBe(201);
    const view = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', customer.cookie);
    expect(view.status).toBe(200);
    expect(view.body.order.refunds).toHaveLength(1);
    expect(view.body.order.refunds[0].state).toBe('pending');
    expect(view.body.order.refunds[0].amount).toBe(15000);
    // Complete it and status flips to succeeded
    await request(sys.app)
      .post(`/api/v1/merchant/orders/${orderId}/refunds/${refund.body.refund.id}/complete`)
      .set('Cookie', m.ownerCookie).send({ success: true });
    const view2 = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', customer.cookie);
    expect(view2.body.order.refunds[0].state).toBe('succeeded');
    expect(view2.body.order.payments[0].state).toBe('Refunded');
  });

  it('REF-005: original payment record remains auditable after refund (Critical)', async () => {
    const { orderId, paymentId } = await paidOrder();
    const refund = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Refund requested' });
    await request(sys.app)
      .post(`/api/v1/merchant/orders/${orderId}/refunds/${refund.body.refund.id}/complete`)
      .set('Cookie', m.ownerCookie).send({ success: true });
    // Payment row still exists (never deleted) with provider reference intact
    const payment = await sys.ctx.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId!) as {
      id: string; state: string; provider_ref: string; amount: number;
    };
    expect(payment).toBeTruthy();
    expect(payment.state).toBe('Refunded');
    expect(payment.provider_ref).toMatch(/^MOMO-STUB-/);
    expect(payment.amount).toBe(15000);
    // Refund row links back to the original payment
    const refundRow = await sys.ctx.db.prepare('SELECT * FROM refunds WHERE payment_id = ?').get(paymentId!) as {
      amount: number; state: string; actor_id: string;
    };
    expect(refundRow.amount).toBe(15000);
    expect(refundRow.state).toBe('succeeded');
    expect(refundRow.actor_id).toBe(m.ownerUserId);
    // Order history retained
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    const orderCount = await sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM orders WHERE id = ?').get(orderId) as { c: number };
    expect(orderCount.c).toBe(1);
    // Refund lifecycle audited
    const audits = await sys.ctx.db.prepare(`SELECT action FROM audit_events WHERE entity = 'refund'`).all() as { action: string }[];
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['refund.initiated', 'refund.succeeded']));
  });

  it('REF-006: duplicate cancellation request causes no duplicate side effect', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, quantity: 3, paymentMethod: 'cod' });
    const first = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({ reason: 'once' });
    expect(first.status).toBe(200);
    const stockAfterFirst = (await sys.ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(p) as { quantity: number }).quantity;
    expect(stockAfterFirst).toBe(100);
    // Repeat — must not double-release stock or duplicate notifications
    const repeat = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({ reason: 'twice' });
    expect([200, 400, 409]).toContain(repeat.status);
    const stockAfterRepeat = (await sys.ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(p) as { quantity: number }).quantity;
    expect(stockAfterRepeat).toBe(100);
    const releases = await sys.ctx.db.prepare(`SELECT COUNT(*) AS c FROM inventory_movements WHERE reason = 'order_release'`).get() as { c: number };
    expect(releases.c).toBe(1);
    const cancels = await sys.ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE entity_id = ? AND detail LIKE '%Cancelled%'`)
      .get(orderId) as { c: number };
    expect(cancels.c).toBe(1);
    expect(await orderState(sys, orderId)).toBe('Cancelled');
  });

  it('refund cannot be requested for unpaid orders', async () => {
    const { orderId } = await paidOrder();
    // Cancel order → payment was Paid though; create unpaid pending order instead
    const p2 = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-002', name: 'Hammer', price: 8500, stock: 40 });
    const cartRes = await request(sys.app).post('/api/v1/carts').set('Cookie', customer.cookie).send({ storeId: m.storeId });
    await request(sys.app).post(`/api/v1/carts/${cartRes.body.cart.id}/items`).set('Cookie', customer.cookie)
      .send({ productId: p2, quantity: 1 });
    const pending = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId: cartRes.body.cart.id, deliveryMethod: 'pickup', paymentMethod: 'momo' });
    const res = await request(sys.app).post(`/api/v1/merchant/orders/${pending.body.order.id}/refund`)
      .set('Cookie', m.ownerCookie).send({ reason: 'premature' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REFUND_NOT_POSSIBLE');
    expect(orderId).toBeTruthy();
  });
});
