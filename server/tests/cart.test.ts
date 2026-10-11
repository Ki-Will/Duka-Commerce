import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { system, register, request, makeMerchant, addProduct, addAddress, cartWith, type TestSystem } from './helpers.js';

// Cart & checkout — UAT CART-001..CART-012
describe('CART — Cart & checkout', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  let customer: { cookie: string; id: string };
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
    customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
  });
  afterEach(() => sys.close());

  async function newCart(storeId: string): Promise<string> {
    const res = await request(sys.app).post('/api/v1/carts').set('Cookie', customer.cookie).send({ storeId });
    expect(res.status).toBe(201);
    return res.body.cart.id;
  }

  it('CART-001: adding an in-stock product creates the correct cart line', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    const add = await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 2 });
    expect(add.status).toBe(201);
    expect(add.body.cart.items).toHaveLength(1);
    expect(add.body.cart.items[0].quantity).toBe(2);
    expect(add.body.cart.items[0].price).toBe(15000);
    expect(add.body.cart.totals.subtotal).toBe(30000);
  });

  it('CART-002: changing quantity recalculates the cart', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 2 });
    const up = await request(sys.app).patch(`/api/v1/carts/${cartId}/items/${p}`).set('Cookie', customer.cookie)
      .send({ quantity: 5 });
    expect(up.status).toBe(200);
    expect(up.body.cart.items[0].quantity).toBe(5);
    expect(up.body.cart.totals.subtotal).toBe(75000);
    const down = await request(sys.app).patch(`/api/v1/carts/${cartId}/items/${p}`).set('Cookie', customer.cookie)
      .send({ quantity: 1 });
    expect(down.body.cart.totals.subtotal).toBe(15000);
  });

  it('CART-003: removing an item empties the line', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 1 });
    const del = await request(sys.app).delete(`/api/v1/carts/${cartId}/items/${p}`).set('Cookie', customer.cookie);
    expect(del.status).toBe(200);
    expect(del.body.cart.items).toHaveLength(0);
    expect(del.body.cart.totals.subtotal).toBe(0);
  });

  it('CART-004: carts are store-scoped — cross-store products get separate carts', async () => {
    const other = await makeMerchant(sys, { ownerEmail: 'tech@test.com', storeName: 'Tech Corner' });
    const pa = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const pb = addProduct(sys, { storeId: other.storeId, sku: 'TC-001', name: 'USB-C Cable', price: 7500, stock: 60 });
    const cartA = await newCart(m.storeId);
    const cartB = await newCart(other.storeId);
    expect(cartA).not.toBe(cartB);
    await request(sys.app).post(`/api/v1/carts/${cartA}/items`).set('Cookie', customer.cookie)
      .send({ productId: pa, quantity: 1 });
    // Store B product cannot enter store A cart
    const cross = await request(sys.app).post(`/api/v1/carts/${cartA}/items`).set('Cookie', customer.cookie)
      .send({ productId: pb, quantity: 1 });
    expect(cross.status).toBe(400);
    expect(cross.body.code).toBe('DIFFERENT_STORE');
    // Requesting a cart for store B returns store B's cart
    const again = await request(sys.app).post('/api/v1/carts').set('Cookie', customer.cookie).send({ storeId: other.storeId });
    expect(again.status).toBe(200);
    expect(again.body.cart.id).toBe(cartB);
    const list = await request(sys.app).get('/api/v1/carts').set('Cookie', customer.cookie);
    expect(list.body.carts).toHaveLength(2);
  });

  it('CART-005: checkout is blocked when the product is out of stock — no order created', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 2 });
    // Stock is exhausted externally (e.g. another order won the race)
    sys.ctx.db.prepare('UPDATE inventory_items SET quantity = 0 WHERE product_id = ?').run(p);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'cod' });
    expect(order.status).toBe(400);
    expect(order.body.code).toBe('ORDER_STOCK_UNAVAILABLE');
    const count = sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('CART-006: checkout blocked when cart quantity exceeds available stock', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 5 });
    // Inventory reduced after the item entered the cart
    sys.ctx.db.prepare('UPDATE inventory_items SET quantity = 2 WHERE product_id = ?').run(p);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'cod' });
    expect(order.status).toBe(400);
    expect(order.body.code).toBe('ORDER_STOCK_UNAVAILABLE');
    expect(order.body.message).toMatch(/no longer available/i);
    const count = sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('CART-007: price is revalidated at checkout — current valid price is used', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 2 });
    // Merchant raises the price after the item was added
    await request(sys.app).patch(`/api/v1/merchant/products/${p}`).set('Cookie', m.ownerCookie).send({ price: 17000 });
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'cod' });
    expect(order.status).toBe(201);
    expect(order.body.order.subtotal).toBe(34000); // 2 × 17000, stale price not used
    const items = sys.ctx.db.prepare('SELECT unit_price FROM order_items WHERE order_id = ?').all(order.body.order.id) as { unit_price: number }[];
    expect(items[0].unit_price).toBe(17000);
  });

  it('CART-008: client-supplied discount is ignored — totals computed server-side', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 2 });
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'pickup', paymentMethod: 'cod', discount: 29000, subtotal: 100 });
    expect(order.status).toBe(201);
    expect(order.body.order.discount).toBe(0);
    expect(order.body.order.subtotal).toBe(30000);
    expect(order.body.order.total).toBe(30000);
  });

  it('CART-009: delivery checkout requires a delivery address', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 1 });
    const noAddr = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, deliveryMethod: 'delivery', paymentMethod: 'cod' });
    expect(noAddr.status).toBe(400);
    expect(noAddr.body.code).toBe('ADDRESS_REQUIRED');
    const addrId = addAddress(sys, customer.id);
    const withAddr = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, addressId: addrId, deliveryMethod: 'delivery', paymentMethod: 'cod' });
    expect(withAddr.status).toBe(201);
    expect(withAddr.body.order.delivery_method).toBe('delivery');
    expect(withAddr.body.order.delivery_fee).toBe(2000);
    expect(withAddr.body.order.total).toBe(17000);
  });

  it('CART-010: total arithmetic — subtotal + delivery fee − discount', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const p2 = addProduct(sys, { storeId: m.storeId, sku: 'KHS-002', name: 'Hammer', price: 8500, stock: 40 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 2 });
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p2, quantity: 1 });
    const addrId = addAddress(sys, customer.id);
    const order = await request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie)
      .send({ cartId, addressId: addrId, deliveryMethod: 'delivery', paymentMethod: 'cod' });
    expect(order.status).toBe(201);
    // subtotal = 30000 + 8500 = 38500; + 2000 delivery − 0 discount = 40500
    expect(order.body.order.subtotal).toBe(38500);
    expect(order.body.order.delivery_fee).toBe(2000);
    expect(order.body.order.discount).toBe(0);
    expect(order.body.order.total).toBe(38500 + 2000 - 0);
  });

  it('CART-011: double-submitting checkout creates only one order', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 1 });
    const body = { cartId, deliveryMethod: 'pickup', paymentMethod: 'cod', idempotencyKey: 'checkout-key-1' };
    const [r1, r2] = await Promise.all([
      request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send(body),
      request(sys.app).post('/api/v1/orders').set('Cookie', customer.cookie).send(body)
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.order.id).toBe(r2.body.order.id);
    const count = sys.ctx.db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number };
    expect(count.c).toBe(1);
    // stock decremented exactly once
    const stock = sys.ctx.db.prepare('SELECT quantity FROM inventory_items WHERE product_id = ?').get(p) as { quantity: number };
    expect(stock.quantity).toBe(99);
  });

  it('CART-012: customer sees a full checkout summary from the cart', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 100 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 2 });
    const res = await request(sys.app).get(`/api/v1/carts/${cartId}`).set('Cookie', customer.cookie);
    expect(res.status).toBe(200);
    const cart = res.body.cart;
    expect(cart.items[0].name).toBe('Cement 50kg');
    expect(cart.items[0].quantity).toBe(2);
    expect(cart.items[0].price).toBe(15000);
    expect(cart.totals.subtotal).toBe(30000);
    expect(cart.totals.deliveryFee).toBe(2000);
    expect(cart.totals.total).toBe(32000);
    expect(cart.store.name).toBe('Kigali Home');
    expect(cart.checkoutBlocked).toBe(false);
  });

  it('out-of-stock product cannot be added to cart', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-009', name: 'Gone', price: 100, stock: 0 });
    const cartId = await newCart(m.storeId);
    const add = await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 1 });
    expect(add.status).toBe(400);
    expect(add.body.code).toBe('OUT_OF_STOCK');
  });

  it('carts are private to their owner', async () => {
    const p = addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const cartId = await newCart(m.storeId);
    await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', customer.cookie)
      .send({ productId: p, quantity: 1 });
    const other = await register(sys, { name: 'Eric', email: 'eric@test.com', password: 'password123' });
    const view = await request(sys.app).get(`/api/v1/carts/${cartId}`).set('Cookie', other.cookie);
    expect(view.status).toBe(404);
    const add = await request(sys.app).post(`/api/v1/carts/${cartId}/items`).set('Cookie', other.cookie)
      .send({ productId: p, quantity: 1 });
    expect(add.status).toBe(404);
  });
});
