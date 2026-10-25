import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { system, register, login, request, makeUser, makeMerchant, addProduct, makeCategory, type TestSystem } from './helpers.js';

// Catalogue & discovery — UAT CAT-001..CAT-014
describe('CAT — Catalogue & discovery', () => {
  let sys: TestSystem;
  let m: Awaited<ReturnType<typeof makeMerchant>>;
  beforeEach(async () => {
    sys = system();
    m = await makeMerchant(sys, { ownerEmail: 'm@test.com', storeName: 'Kigali Home' });
  });
  afterEach(() => sys.close());

  async function createProduct(body: Record<string, unknown>) {
    return request(sys.app).post('/api/v1/merchant/products').set('Cookie', m.ownerCookie).send(body);
  }

  it('CAT-001: merchant creates a product saved as draft', async () => {
    const res = await createProduct({ name: 'Cement 50kg', sku: 'KHS-001', price: 15000, quantity: 100 });
    expect(res.status).toBe(201);
    expect(res.body.product.status).toBe('draft');
    // Draft is not publicly visible
    const pub = await request(sys.app).get(`/api/v1/products/${res.body.product.id}`);
    expect(pub.status).toBe(404);
  });

  it('CAT-002: required product fields are validated', async () => {
    const noName = await createProduct({ sku: 'X-1', price: 100 });
    expect(noName.status).toBe(400);
    expect(noName.body.code).toBe('VALIDATION_ERROR');
    const noSku = await createProduct({ name: 'Hammer', price: 100 });
    expect(noSku.status).toBe(400);
  });

  it('CAT-003: invalid product price is rejected', async () => {
    for (const price of [-100, 9.99, 'free', null]) {
      const res = await createProduct({ name: 'Hammer', sku: `H-${String(price)}`, price });
      expect(res.status, `price=${JSON.stringify(price)}`).toBe(400);
    }
  });

  it('CAT-004: publishing makes the product visible and orderable', async () => {
    const created = await createProduct({ name: 'Cement 50kg', sku: 'KHS-001', price: 15000, quantity: 50 });
    const pub = await request(sys.app)
      .post(`/api/v1/merchant/products/${created.body.product.id}/publish`)
      .set('Cookie', m.ownerCookie);
    expect(pub.status).toBe(200);
    expect(pub.body.product.status).toBe('published');
    const view = await request(sys.app).get(`/api/v1/products/${created.body.product.id}`);
    expect(view.status).toBe(200);
    expect(view.body.product.orderable).toBe(true);
    const storeProducts = await request(sys.app).get(`/api/v1/stores/${m.storeId}/products`);
    expect(storeProducts.body.products.map((p: { id: string }) => p.id)).toContain(created.body.product.id);
  });

  it('CAT-005: unpublishing makes the product no longer orderable', async () => {
    const created = await createProduct({ name: 'Cement 50kg', sku: 'KHS-001', price: 15000, quantity: 50 });
    const id = created.body.product.id;
    await request(sys.app).post(`/api/v1/merchant/products/${id}/publish`).set('Cookie', m.ownerCookie);
    const unpub = await request(sys.app).post(`/api/v1/merchant/products/${id}/unpublish`).set('Cookie', m.ownerCookie);
    expect(unpub.body.product.status).toBe('unpublished');
    const view = await request(sys.app).get(`/api/v1/products/${id}`);
    expect(view.status).toBe(404);
    // Adding an unpublished product to the cart is blocked
    const customer = await register(sys, { name: 'Amina', email: 'amina@test.com', password: 'password123' });
    const cart = await request(sys.app).post('/api/v1/carts').set('Cookie', customer.cookie).send({ storeId: m.storeId });
    const add = await request(sys.app)
      .post(`/api/v1/carts/${cart.body.cart.id}/items`)
      .set('Cookie', customer.cookie)
      .send({ productId: id, quantity: 1 });
    expect(add.status).toBe(400);
    expect(add.body.code).toBe('PRODUCT_NOT_ORDERABLE');
  });

  it('CAT-006: merchant edits product details and changes persist', async () => {
    const created = await createProduct({ name: 'Cement 50kg', sku: 'KHS-001', price: 15000, quantity: 50 });
    const edit = await request(sys.app)
      .patch(`/api/v1/merchant/products/${created.body.product.id}`)
      .set('Cookie', m.ownerCookie)
      .send({ description: 'Strong Portland cement', price: 16000 });
    expect(edit.status).toBe(200);
    expect(edit.body.product.description).toBe('Strong Portland cement');
    expect(edit.body.product.price).toBe(16000);
    const row = await sys.ctx.db.prepare('SELECT price FROM products WHERE id = ?').get(created.body.product.id) as { price: number };
    expect(row.price).toBe(16000);
  });

  it('CAT-007: valid product image URL is stored and displayed', async () => {
    const created = await createProduct({
      name: 'Cement 50kg', sku: 'KHS-001', price: 15000, quantity: 50,
      imageUrl: 'https://cdn.example.com/images/cement.jpg'
    });
    expect(created.status).toBe(201);
    expect(created.body.product.image_url).toBe('https://cdn.example.com/images/cement.jpg');
    await request(sys.app).post(`/api/v1/merchant/products/${created.body.product.id}/publish`).set('Cookie', m.ownerCookie);
    const view = await request(sys.app).get(`/api/v1/products/${created.body.product.id}`);
    expect(view.body.product.image_url).toBe('https://cdn.example.com/images/cement.jpg');
  });

  it('CAT-008: invalid/oversized image input is rejected', async () => {
    const bad = await createProduct({ name: 'Hammer', sku: 'H-001', price: 8500, imageUrl: 'not-a-url' });
    expect(bad.status).toBe(400);
    const huge = await createProduct({ name: 'Hammer', sku: 'H-002', price: 8500, imageUrl: 'https://x.example/' + 'a'.repeat(400) });
    expect(huge.status).toBe(400);
    const script = await createProduct({ name: 'Hammer', sku: 'H-003', price: 8500, imageUrl: 'javascript:alert(1)' });
    expect(script.status).toBe(400);
  });

  it('CAT-009: customer browses an open store', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 50 });
    const store = await request(sys.app).get(`/api/v1/stores/${m.storeId}`);
    expect(store.status).toBe(200);
    expect(store.body.store.name).toBe('Kigali Home');
    const products = await request(sys.app).get(`/api/v1/stores/${m.storeId}/products`);
    expect(products.body.products.map((x: { id: string }) => x.id)).toContain(p);
  });

  it('CAT-010: customer browses a category', async () => {
    const catId = await makeCategory(sys, 'Building Materials');
    await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 50, categoryId: catId });
    await addProduct(sys, { storeId: m.storeId, sku: 'KHS-002', name: 'Loose Tool', price: 5000, stock: 5 });
    const bySlug = await request(sys.app).get('/api/v1/products').query({ category: 'building-materials' });
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.products).toHaveLength(1);
    expect(bySlug.body.products[0].name).toBe('Cement 50kg');
  });

  it('CAT-011: customer searches products by SKU and name', async () => {
    await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 50 });
    await addProduct(sys, { storeId: m.storeId, sku: 'KHS-002', name: 'Hammer', price: 8500, stock: 40 });
    const byName = await request(sys.app).get('/api/v1/products').query({ search: 'Cement' });
    expect(byName.body.products).toHaveLength(1);
    expect(byName.body.products[0].sku).toBe('KHS-001');
    const bySku = await request(sys.app).get('/api/v1/products').query({ search: 'KHS-002' });
    expect(bySku.body.products).toHaveLength(1);
    expect(bySku.body.products[0].name).toBe('Hammer');
  });

  it('CAT-012: customer filters products with matching results', async () => {
    const catId = await makeCategory(sys, 'Electronics');
    await addProduct(sys, { storeId: m.storeId, sku: 'TC-001', name: 'USB-C Cable', price: 7500, stock: 60, categoryId: catId });
    await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement', price: 15000, stock: 10 });
    const filtered = await request(sys.app).get('/api/v1/products').query({ category: catId });
    expect(filtered.body.products).toHaveLength(1);
    expect(filtered.body.products[0].name).toBe('USB-C Cable');
    const sorted = await request(sys.app).get('/api/v1/products').query({ sort: 'price_asc' });
    expect(sorted.body.products[0].name).toBe('USB-C Cable');
  });

  it('CAT-013: suspended product is hidden from browse/search and not orderable', async () => {
    const p = await addProduct(sys, { storeId: m.storeId, sku: 'KHS-001', name: 'Cement 50kg', price: 15000, stock: 50 });
    await makeUser(sys, { role: 'admin', name: 'Admin', email: 'admin@test.com' });
    const { cookie: admin } = await login(sys, 'admin@test.com', 'password123');
    const susp = await request(sys.app)
      .post(`/api/v1/admin/products/${p}/status`)
      .set('Cookie', admin)
      .send({ status: 'suspended', reason: 'Policy' });
    expect(susp.status).toBe(200);
    expect(susp.body.product.status).toBe('suspended');
    const detail = await request(sys.app).get(`/api/v1/products/${p}`);
    expect(detail.status).toBe(404);
    const search = await request(sys.app).get('/api/v1/products').query({ search: 'Cement' });
    expect(search.body.products).toHaveLength(0);
  });

  it('CAT-014: Merchant A cannot edit Store B product (ownership isolation)', async () => {
    const other = await makeMerchant(sys, { ownerEmail: 'other@test.com', storeName: 'Tech Corner' });
    const productB = await addProduct(sys, { storeId: other.storeId, sku: 'TC-001', name: 'USB-C Cable', price: 7500, stock: 60 });
    const edit = await request(sys.app)
      .patch(`/api/v1/merchant/products/${productB}`)
      .set('Cookie', m.ownerCookie)
      .send({ price: 1 });
    expect(edit.status).toBe(404);
    const row = await sys.ctx.db.prepare('SELECT price FROM products WHERE id = ?').get(productB) as { price: number };
    expect(row.price).toBe(7500);
    // Publish attempt also denied
    const pub = await request(sys.app)
      .post(`/api/v1/merchant/products/${productB}/publish`)
      .set('Cookie', m.ownerCookie);
    expect(pub.status).toBe(404);
  });

  it('duplicate SKU within a store is rejected', async () => {
    await createProduct({ name: 'Cement', sku: 'KHS-001', price: 15000 });
    const dup = await createProduct({ name: 'Cement again', sku: 'KHS-001', price: 15000 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SKU_EXISTS');
  });
});
