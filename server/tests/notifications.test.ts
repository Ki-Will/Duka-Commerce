import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  system, register, request, makeMerchant, addProduct, purchase, orderState, type TestSystem
} from './helpers.js';
import { flushNotifications, retryNotifications, notificationsFor } from '../src/services/notifications.js';

// Notifications — UAT NOT-001..NOT-006
describe('NOT — Notifications', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  function allNotifications() {
    return sys.ctx.db.prepare('SELECT * FROM notifications ORDER BY created_at').all() as {
      type: string; recipient: string; subject: string; body: string; status: string; attempts: number;
    }[];
  }

  it('NOT-001: a new confirmed order queues a merchant notification', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const merchantNotes = allNotifications().filter((n) => n.recipient === m.ownerUserId && n.type === 'order.new');
    expect(merchantNotes).toHaveLength(1);
    expect(merchantNotes[0].subject).toMatch(/^New order DC-/);
    expect(merchantNotes[0].status).toBe('pending');
  });

  it('NOT-002: customer receives a payment result notification', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { paymentId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p });
    const inApp = notificationsFor(sys.ctx, customer.id) as { type: string; status: string }[];
    expect(inApp.some((n) => n.type === 'payment.success')).toBe(true);
    expect(inApp.some((n) => n.type === 'order.confirmed')).toBe(true);
    // Failure path notifies too
    const p2 = addProduct(sys, { storeId: m.storeId, sku: 'KHS-002', name: 'Hammer', price: 8500, stock: 40 });
    const cartRes = await request(sys.app).post('/api/v1/carts').set('Cookie', customer.cookie).send({ storeId: m.storeId });
    await request(sys.app).post(`/api/v1/carts/${cartRes.body.cart.id}/items`).set('Cookie', customer.cookie)
      .send({ productId: p2, quantity: 1 });
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId: cartRes.body.cart.id, deliveryMethod: 'pickup', paymentMethod: 'momo' });
    await request(sys.app).post(`/api/v1/payments/${order.body.payment.id}/simulate`)
      .set('Cookie', customer.cookie).send({ result: 'failure' });
    const after = notificationsFor(sys.ctx, customer.id) as { type: string }[];
    expect(after.some((n) => n.type === 'payment.failed')).toBe(true);
    expect(paymentId).toBeTruthy();
  });

  it('NOT-003: fulfillment status changes notify the customer', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/accept`).set('Cookie', m.ownerCookie);
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'Preparing' });
    await request(sys.app).post(`/api/v1/merchant/orders/${orderId}/status`).set('Cookie', m.ownerCookie).send({ to: 'ReadyForDispatch' });
    const notes = notificationsFor(sys.ctx, customer.id) as { type: string; body: string }[];
    const statusNotes = notes.filter((n) => n.type === 'order.status');
    expect(statusNotes.length).toBeGreaterThanOrEqual(3); // confirmed + accepted + preparing + ready
    expect(statusNotes.some((n) => n.body.includes('being prepared'))).toBe(true);
    expect(statusNotes.some((n) => n.body.includes('ready for dispatch'))).toBe(true);
  });

  it('NOT-004: notification provider outage does not change commercial order state (BR-14)', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { orderId } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    expect(orderState(sys, orderId)).toBe('Confirmed');
    // Provider is down: flush fails every pending message
    const result = flushNotifications(sys.ctx, { providerDown: true });
    expect(result.sent).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    // Authoritative state untouched
    expect(orderState(sys, orderId)).toBe('Confirmed');
    const all = allNotifications();
    expect(all.every((n) => n.status === 'failed')).toBe(true);
    // The order/audit records remain intact
    const orderRow = sys.ctx.db.prepare('SELECT state FROM orders WHERE id = ?').get(orderId) as { state: string };
    expect(orderRow.state).toBe('Confirmed');
  });

  it('NOT-005: failed notifications are retried and then delivered', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
      await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    flushNotifications(sys.ctx, { providerDown: true });
    const failed = allNotifications().filter((n) => n.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].attempts).toBe(1);
    // Provider restored → retry returns messages to pending, then they send
    const requeued = retryNotifications(sys.ctx);
    expect(requeued).toBe(failed.length);
    const result = flushNotifications(sys.ctx);
    expect(result.sent).toBe(failed.length);
    expect(result.failed).toBe(0);
    expect(allNotifications().every((n) => n.status === 'sent')).toBe(true);
    expect(allNotifications().every((n) => n.attempts === 2)).toBe(true);
  });

  it('NOT-006: notification content minimizes sensitive data', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const { paymentId, orderNumber } = await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p });
    const notes = allNotifications();
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      const content = `${n.subject} ${n.body}`;
      // No emails, phone numbers, passwords, hashes or full payment credentials
      expect(content).not.toMatch(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
      expect(content).not.toMatch(/password|scrypt/i);
      expect(content).not.toMatch(/07\\d{8}/);
      expect(content).not.toContain('MOMO-STUB-');
    }
    // Order number is acceptable minimal reference data
    expect(notes.some((n) => n.subject.includes(orderNumber) || n.body.includes(orderNumber))).toBe(true);
    expect(paymentId).toBeTruthy();
  });

  it('customers only see their own notifications', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    await purchase(sys, { cookie: customer.cookie, storeId: m.storeId, productId: p, paymentMethod: 'cod' });
    const eric = await register(sys, { name: 'Eric', email: 'eric@test.com', password: 'password123' });
    const res = await request(sys.app).get('/api/v1/notifications').set('Cookie', eric.cookie);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(0);
    const mine = await request(sys.app).get('/api/v1/notifications').set('Cookie', customer.cookie);
    expect(mine.body.notifications.length).toBeGreaterThan(0);
  });
});
