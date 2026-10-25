import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  system, register, request, makeMerchant, addProduct, addAddress, cartWith, purchase, orderState, stockOf,
  type TestSystem
} from './helpers.js';

// Orders — UAT ORD-001..ORD-014
describe('ORD — Orders lifecycle', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  it('ORD-001: checkout creates a pending order', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1);
    const res = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'momo' });
    expect(res.status).toBe(201);
    expect(res.body.order.state).toBe('PendingPayment');
    expect(res.body.payment.state).toBe('Pending');
    expect(res.body.order.order_number).toMatch(/^DC-/);
  });

  it('ORD-002: order numbers are unique', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const o1 = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const o2 = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    expect(o1.orderNumber).not.toBe(o2.orderNumber);
  });

  it('ORD-003: successful payment confirms the order (Critical)', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId, paymentId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p });
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    const row = await sys.ctx.db.prepare('SELECT state FROM payments WHERE id = ?').get(paymentId) as { state: string };
    expect(row.state).toBe('Paid');
  });

  it('ORD-004: failed payment does not confirm the order (Critical)', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'momo' });
    const paymentId = order.body.payment.id;
    const sim = await request(sys.app).post(`/api/v1/payments/${paymentId}/simulate`).set('Cookie', customer.cookie)
      .send({ result: 'failure' });
    expect(sim.status).toBe(200);
    expect(await orderState(sys, order.body.order.id)).toBe('PaymentFailed');
    expect(await orderState(sys, order.body.order.id)).not.toBe('Confirmed');
    const pay = await sys.ctx.db.prepare('SELECT state FROM payments WHERE id = ?').get(paymentId) as { state: string };
    expect(pay.state).toBe('Failed');
  });

  it('ORD-005: customer views their own order details', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 100 });
    const { orderId, orderNumber } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const res = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', customer.cookie);
    expect(res.status).toBe(200);
    expect(res.body.order.order_number).toBe(orderNumber);
    expect(res.body.order.items[0].product_name).toBe('Cement 50kg');
    expect(res.body.order.store.name).toBe('Kigali Home');
    expect(res.body.order.customer.email).toBe('amina@test.com');
  });

  it('ORD-006: merchant sees a new confirmed order in the queue', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderNumber } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const res = await request(sys.app).get('/api/v1/merchant/orders').set('Cookie', m.ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].order_number).toBe(orderNumber);
    expect(res.body.orders[0].customer_name).toBe('Amina');
  });

  it('ORD-007: merchant accepts a confirmed order → Accepted', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const res = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.order.state).toBe('Accepted');
  });

  it('ORD-008: merchant rejects an eligible order with a retained reason', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const noReason = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/reject`).set('Cookie', m.ownerCookie).send({});
    expect(noReason.status).toBe(400);
    const res = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/reject`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Item unavailable' });
    expect(res.status).toBe(200);
    expect(res.body.order.state).toBe('Rejected');
    expect(res.body.order.cancel_reason).toBe('Item unavailable');
    const row = await sys.ctx.db.prepare('SELECT cancel_reason FROM orders WHERE id = ?').get(orderId) as { cancel_reason: string };
    expect(row.cancel_reason).toBe('Item unavailable');
    // rejected order releases reserved stock
    expect(await stockOf(sys, p)).toBe(100);
  });

  it('ORD-009: illegal order state transitions are rejected (Critical)', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    // Confirmed → Dispatched is not allowed (must go through accept/prepare)
    const skip = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`)
      .set('Cookie', m.ownerCookie).send({ to: 'Dispatched' });
    expect(skip.status).toBe(400);
    expect(skip.body.code).toBe('ILLEGAL_STATE_TRANSITION');
    // Confirmed → Completed not allowed
    const complete = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`)
      .set('Cookie', m.ownerCookie).send({ to: 'Completed' });
    expect(complete.status).toBe(400);
    // Preparing is not allowed before Accept
    const prep = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`)
      .set('Cookie', m.ownerCookie).send({ to: 'Preparing' });
    expect(prep.status).toBe(400);
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    // Merchant cannot accept a payment-pending order
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1);
    const pending = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'momo' });
    const acceptPending = await request(sys.app)
      .post(`/api/v1/merchant/orders/${pending.body.order.id}/accept`).set('Cookie', m.ownerCookie);
    expect(acceptPending.status).toBe(400);
  });

  it('ORD-010: order line price snapshot is immutable after confirmation (Critical)', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    // Merchant raises the price after the order
    await request(sys.app).patch(`/api/v1/merchant/products/${p}`).set('Cookie', m.ownerCookie).send({ price: 99000 });
    const view = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', customer.cookie);
    expect(view.body.order.items[0].unit_price).toBe(15000);
    expect(view.body.order.subtotal).toBe(15000);
    const row = await sys.ctx.db.prepare('SELECT unit_price FROM order_items WHERE order_id = ?').get(orderId) as { unit_price: number };
    expect(row.unit_price).toBe(15000);
  });

  it('ORD-011: order state changes produce an audit trail', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    const events = await sys.ctx.db
      .prepare(`SELECT * FROM audit_events WHERE entity = 'order' AND entity_id = ?
                 AND action IN ('order.created', 'order.state_changed')`)
      .all(orderId) as { actor_id: string; actor_role: string; detail: string; created_at: string }[];
    expect(events.length).toBeGreaterThanOrEqual(2); // created + accepted
    const acceptEvent = events.find((e) => e.detail.includes('"to":"Accepted"'));
    expect(acceptEvent).toBeTruthy();
    expect(acceptEvent!.actor_id).toBe(m.ownerUserId);
    expect(acceptEvent!.actor_role).toBe('owner');
    expect(new Date(acceptEvent!.created_at).getTime()).toBeGreaterThan(0);
  });

  it('ORD-012: customer cancels an order from an eligible state', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const res = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({ reason: 'Changed my mind' });
    expect(res.status).toBe(200);
    expect(res.body.order.state).toBe('Cancelled');
    expect(await orderState(sys, orderId)).toBe('Cancelled');
  });

  it('ORD-013: customer cancellation is blocked after fulfillment has progressed', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'Preparing' });
    const cancelPreparing = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({});
    expect(cancelPreparing.status).toBe(400);
    expect(cancelPreparing.body.code).toBe('CANCELLATION_NOT_ALLOWED');
    // Progress to delivered
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'ReadyForDispatch' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'Dispatched' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'Delivered' });
    const cancelDelivered = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`)
      .set('Cookie', customer.cookie).send({});
    expect(cancelDelivered.status).toBe(400);
    expect(await orderState(sys, orderId)).toBe('Delivered');
  });

  it('ORD-014: merchant cannot view or modify another store\'s order (Critical)', async () => {
    const other = await makeMerchant(sys, { ownerEmail: 'tech@test.com', storeName: 'Tech Corner' });
    const p = await addProduct(sys, { storeId: other.storeId, sku: 'TC-001', name: 'Cable', price: 7500, stock: 60 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: other.storeId, productId: p, paymentMethod: 'cod' });
    const view = await request(sys.app).get(`/api/v1/merchant/orders/${orderId}`).set('Cookie', m.ownerCookie);
    expect(view.status).toBe(404);
    const accept = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    expect(accept.status).toBe(404);
    const status = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`)
      .set('Cookie', m.ownerCookie).send({ to: 'Preparing' });
    expect(status.status).toBe(404);
    const cancel = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/cancel`)
      .set('Cookie', m.ownerCookie).send({ reason: 'tamper' });
    expect(cancel.status).toBe(404);
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    // Queue only lists own orders
    const queue = await request(sys.app).get('/api/v1/merchant/orders').set('Cookie', m.ownerCookie);
    expect(queue.body.orders).toHaveLength(0);
  });

  it('COD orders are confirmed immediately without online payment', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId, paymentId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    expect(await orderState(sys, orderId)).toBe('Confirmed');
    expect(paymentId).toBeNull();
  });
});
