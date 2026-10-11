import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  system, register, request, makeMerchant, addProduct, addAddress, cartWith, purchase, orderState, stockOf,
  type TestSystem
} from './helpers.js';

// Fulfillment — UAT FUL-001..FUL-008
describe('FUL — Fulfillment workflow', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  async function confirmedOrder(qty = 1): Promise<string> {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, quantity: qty, paymentMethod: 'cod' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    return orderId;
  }

  async function setStatus(orderId: string, to: string) {
    return request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to });
  }

  it('FUL-001: merchant starts preparation from Accepted', async () => {
    const orderId = await confirmedOrder();
    expect(orderState(sys, orderId)).toBe('Accepted');
    const res = await setStatus(orderId, 'Preparing');
    expect(res.status).toBe(200);
    expect(res.body.order.state).toBe('Preparing');
  });

  it('FUL-002: order becomes ready — customer-visible status updates', async () => {
    const orderId = await confirmedOrder();
    await setStatus(orderId, 'Preparing');
    const res = await setStatus(orderId, 'ReadyForDispatch');
    expect(res.status).toBe(200);
    expect(res.body.order.state).toBe('ReadyForDispatch');
    const customerView = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', customer.cookie);
    expect(customerView.body.order.state).toBe('ReadyForDispatch');
  });

  it('FUL-003: dispatch order', async () => {
    const orderId = await confirmedOrder();
    await setStatus(orderId, 'Preparing');
    await setStatus(orderId, 'ReadyForDispatch');
    const res = await setStatus(orderId, 'Dispatched');
    expect(res.status).toBe(200);
    expect(orderState(sys, orderId)).toBe('Dispatched');
  });

  it('FUL-004: deliver order', async () => {
    const orderId = await confirmedOrder();
    await setStatus(orderId, 'Preparing');
    await setStatus(orderId, 'ReadyForDispatch');
    await setStatus(orderId, 'Dispatched');
    const res = await setStatus(orderId, 'Delivered');
    expect(res.status).toBe(200);
    expect(orderState(sys, orderId)).toBe('Delivered');
  });

  it('FUL-005: complete order reaches the final state', async () => {
    const orderId = await confirmedOrder();
    await setStatus(orderId, 'Preparing');
    await setStatus(orderId, 'ReadyForDispatch');
    await setStatus(orderId, 'Dispatched');
    await setStatus(orderId, 'Delivered');
    const res = await setStatus(orderId, 'Completed');
    expect(res.status).toBe(200);
    expect(orderState(sys, orderId)).toBe('Completed');
    // Final states are terminal
    const after = await setStatus(orderId, 'Dispatched');
    expect(after.status).toBe(400);
    const cancel = await request(sys.app).post(`/api/v1/orders/${orderId}/cancel`).set('Cookie', customer.cookie).send({});
    expect(cancel.status).toBe(400);
    expect(orderState(sys, orderId)).toBe('Completed');
  });

  it('FUL-006: invalid fulfillment transitions are rejected', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    // Order is Confirmed (not accepted): dispatch must be rejected
    const dispatch = await setStatus(orderId, 'Dispatched');
    expect(dispatch.status).toBe(400);
    expect(dispatch.body.code).toBe('ILLEGAL_STATE_TRANSITION');
    expect(orderState(sys, orderId)).toBe('Confirmed');
    // Unknown target state is rejected by validation
    const bogus = await setStatus(orderId, 'Teleported');
    expect(bogus.status).toBe(400);
    // Skip-ahead within accepted chain is rejected
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    const skip = await setStatus(orderId, 'Delivered');
    expect(skip.status).toBe(400);
    expect(orderState(sys, orderId)).toBe('Accepted');
  });

  it('FUL-007: customer sees fulfillment status and tracking fields', async () => {
    const orderId = await confirmedOrder();
    await setStatus(orderId, 'Preparing');
    const res = await request(sys.app).get(`/api/v1/orders/${orderId}`).set('Cookie', customer.cookie);
    expect(res.status).toBe(200);
    expect(res.body.order.state).toBe('Preparing');
    expect(res.body.order.delivery_method).toBeTruthy();
    expect(res.body.order.items[0].product_name).toBe('Cement 50kg');
    expect(res.body.order.store.name).toBe('Kigali Home');
  });

  it('FUL-008: order address snapshot is preserved when the customer edits their address', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const addrId = addAddress(sys, customer.id);
    const cartId = await cartWith(sys, customer.cookie, m.storeId, p, 1);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, addressId: addrId, deliveryMethod: 'delivery', paymentMethod: 'cod' });
    expect(order.status).toBe(201);
    expect(order.body.order.address_snapshot.line1).toBe('123 KG St');
    // Customer edits their address after the order
    await request(sys.app).patch(`/api/v1/addresses/${addrId}`).set('Cookie', customer.cookie)
      .send({ line1: '999 New Road', city: 'Huye' });
    const view = await request(sys.app).get(`/api/v1/orders/${order.body.order.id}`).set('Cookie', customer.cookie);
    expect(view.body.order.address_snapshot.line1).toBe('123 KG St');
    expect(view.body.order.address_snapshot.city).toBe('Kigali');
    const row = sys.ctx.db.prepare('SELECT address_snapshot FROM orders WHERE id = ?').get(order.body.order.id) as { address_snapshot: string };
    expect(JSON.parse(row.address_snapshot).line1).toBe('123 KG St');
  });

  it('merchant cancellation through the chain records actor and releases stock', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, quantity: 2, paymentMethod: 'cod' });
    expect(stockOf(sys, p)).toBe(98);
    const cancel = await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/cancel`)
      .set('Cookie', m.ownerCookie).send({ reason: 'Stock discrepancy found' });
    expect(cancel.status).toBe(200);
    expect(orderState(sys, orderId)).toBe('Cancelled');
    expect(cancel.body.order.cancel_reason).toBe('Stock discrepancy found');
    expect(stockOf(sys, p)).toBe(100);
    const auditRow = sys.ctx.db
      .prepare(`SELECT * FROM audit_events WHERE entity = 'order' AND entity_id = ? AND action = 'order.state_changed' AND detail LIKE '%Cancelled%'`)
      .get(orderId) as { actor_id: string; detail: string } | undefined;
    expect(auditRow).toBeTruthy();
    expect(auditRow!.actor_id).toBe(m.ownerUserId);
    expect(auditRow!.detail).toContain('Stock discrepancy found');
  });
});
