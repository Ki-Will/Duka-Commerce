/**
 * DukaCommerce demo/UAT seed data (mirrors SRS Appendix B + UAT pack §4.2/4.3).
 * Run: npm run seed   (idempotent — skips if stores already exist)
 * All passwords are documented test values: "password123"
 */
import { createContext } from './context.js';
import { hashPassword } from './services/auth.js';
import { uuid, now, j } from './db/index.js';
import { DEFAULT_STAFF_PERMS } from './domain/permissions.js';

const PASSWORD = 'password123';

function main() {
  const ctx = createContext({ file: process.env.DUKA_DB_FILE ?? 'duka.sqlite' });
  const db = ctx.db;

  const existing = db.prepare('SELECT COUNT(*) AS c FROM stores').get() as { c: number };
  if (existing.c > 0) {
    console.log('Seed skipped: stores already exist. Delete duka.sqlite to reseed.');
    ctx.close();
    return;
  }

  const ts = now();
  const userId = (email: string, role: string, name: string, phone: string | null = null): string => {
    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, phone, password_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(id, role, name, email, phone, hashPassword(PASSWORD), ts);
    return id;
  };

  // ---- accounts (UAT §4.2 seed accounts, emails normalized to the test pack) ----
  const customer1 = userId('customer1@test.com', 'customer', 'Amina Test', '0788000001');
  userId('customer2@test.com', 'customer', 'Eric Test', '0788000002');
  const merchant1 = userId('merchant1@test.com', 'owner', 'Jean Bosco', '0788111111');
  const merchant2 = userId('merchant2@test.com', 'owner', 'Claudine Uwase', '0788222222');
  const merchant3 = userId('merchant3@test.com', 'owner', 'Eric Mugisha', '0788333333');
  const staff1 = userId('staff1@test.com', 'staff', 'Staff One');
  userId('support@test.com', 'support', 'Support Agent');
  userId('admin@test.com', 'admin', 'Platform Admin');

  // ---- categories ----
  const catId = (name: string): string => {
    const id = uuid();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    db.prepare('INSERT INTO categories (id, name, slug, parent_id, created_at) VALUES (?, ?, ?, NULL, ?)').run(id, name, slug, ts);
    return id;
  };
  const building = catId('Building Materials');
  const fashion = catId('Fashion');
  const electronics = catId('Electronics');
  catId('Home & Garden');

  // ---- merchants + stores (approved/open) ----
  const merchantStore = (ownerId: string, business: string, storeName: string, description: string) => {
    const mid = uuid();
    db.prepare(
      `INSERT INTO merchants (id, owner_user_id, business_name, contact_email, contact_phone, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'approved', ?, ?)`
    ).run(mid, ownerId, business, `${storeName.toLowerCase().replace(/\s+/g, '')}@example.rw`, ts, ts);
    const sid = uuid();
    const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    db.prepare(
      `INSERT INTO stores (id, merchant_id, name, slug, description, contact, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', 'open', ?, ?)`
    ).run(sid, mid, storeName, slug, description, ts, ts);
    return { merchantId: mid, storeId: sid };
  };

  const kigaliHome = merchantStore(merchant1, 'Kigali Home Supplies Ltd', 'Kigali Home', 'Building materials & hardware, Kigali.');
  const imbere = merchantStore(merchant2, 'Imbere Fashion Store', 'Imbere Fashion', 'Local fashion and apparel.');
  const techCorner = merchantStore(merchant3, 'Tech Corner Rwanda', 'Tech Corner', 'Gadgets and accessories.');

  // staff assignment for staff1@test.com (Kigali Home) — default permissions
  db.prepare('INSERT INTO store_staff (store_id, user_id, role, perms, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kigaliHome.storeId, staff1, 'staff', j(DEFAULT_STAFF_PERMS), ts);

  // ---- products with inventory (UAT §4.3 seed stores/products) ----
  const product = (storeId: string, sku: string, name: string, price: number, stock: number, categoryId: string, description = '', threshold = 5) => {
    const id = uuid();
    db.prepare(
      `INSERT INTO products (id, store_id, category_id, sku, name, description, price, image_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 'published', ?, ?)`
    ).run(id, storeId, categoryId, sku, name, description, price, ts, ts);
    db.prepare('INSERT INTO inventory_items (product_id, quantity, low_stock_threshold) VALUES (?, ?, ?)').run(id, stock, threshold);
    db.prepare(
      `INSERT INTO inventory_movements (id, product_id, delta, reason, actor_id, order_id, created_at) VALUES (?, ?, ?, 'initial_stock', NULL, NULL, ?)`
    ).run(uuid(), id, stock, ts);
    return id;
  };

  product(kigaliHome.storeId, 'KHS-001', 'Cement 50kg', 15000, 100, building, 'Portland cement, 50kg bag.', 10);
  product(kigaliHome.storeId, 'KHS-002', 'Hammer', 8500, 40, building, 'Claw hammer, 16oz.', 5);
  product(kigaliHome.storeId, 'KHS-003', 'Roofing Sheets', 12500, 60, building, 'Gauge 30 roofing sheets, 3m.', 8);
  product(kigaliHome.storeId, 'KHS-004', 'Paint 10L', 22000, 25, building, 'Interior emulsion paint, white.', 5);
  product(imbere.storeId, 'IF-001', 'Polo Shirt', 18000, 25, fashion, 'Cotton polo shirt, assorted colours.', 5);
  product(imbere.storeId, 'IF-002', 'Kitenge Dress', 32000, 15, fashion, 'Tailored kitenge dress.', 3);
  product(imbere.storeId, 'IF-003', 'Denim Jeans', 24000, 20, fashion, 'Slim-fit denim jeans.', 5);
  product(techCorner.storeId, 'TC-001', 'USB-C Cable', 7500, 60, electronics, 'Braided USB-C cable, 1m.', 10);
  product(techCorner.storeId, 'TC-002', 'Phone Case', 5000, 80, electronics, 'Shockproof phone case.', 10);
  product(techCorner.storeId, 'TC-003', 'Wireless Mouse', 15500, 30, electronics, '2.4GHz wireless mouse.', 5);
  product(techCorner.storeId, 'TC-004', 'Laptop Stand', 28000, 12, electronics, 'Aluminium adjustable stand.', 3);

  // ---- addresses for customer1 ----
  db.prepare(
    `INSERT INTO addresses (id, user_id, label, name, line1, line2, city, phone, is_default, created_at)
     VALUES (?, ?, 'Home', 'Amina Test', '12 KG St', '', 'Kigali', '0788000001', 1, ?)`
  ).run(uuid(), customer1, ts);

  console.log('Seed complete.');
  console.log('Test accounts (password: password123):');
  console.log('  customer1@test.com  customer2@test.com');
  console.log('  merchant1@test.com (Kigali Home)  merchant2@test.com (Imbere Fashion)  merchant3@test.com (Tech Corner)');
  console.log('  staff1@test.com (staff @ Kigali Home)');
  console.log('  support@test.com  admin@test.com');
  ctx.close();
}

main();
