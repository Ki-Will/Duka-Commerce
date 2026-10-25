/**
 * DukaCommerce Phase 1 schema (SRS KVT-DC-SRS-2026-001 §10 Data Requirements).
 * Dialect-neutral DDL: runs unchanged on both backends —
 *   - PostgreSQL (Neon) in dev/production: `server/src/db/index.ts` applies it
 *     over a direct (unpooled) connection on first use,
 *   - SQLite via node:sqlite for hermetic unit tests / offline fallback.
 * FKs, unique constraints and atomic conditional UPDATEs behave the same on
 * both; SQLite enforces FKs with a PRAGMA set in `openDb` (see below).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('customer','staff','manager','owner','support','admin')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key         TEXT PRIMARY KEY,
  attempts    INTEGER NOT NULL,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS merchants (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  business_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  reason        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL UNIQUE REFERENCES merchants(id),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  contact     TEXT DEFAULT '',
  logo_url    TEXT DEFAULT '',
  banner_url  TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','suspended')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Staff assignment + configurable permissions (FR-MER-06)
CREATE TABLE IF NOT EXISTS store_staff (
  store_id   TEXT NOT NULL REFERENCES stores(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('staff','manager')),
  perms      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (store_id, user_id)
);

CREATE TABLE IF NOT EXISTS addresses (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  label      TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  line1      TEXT NOT NULL,
  line2      TEXT DEFAULT '',
  city       TEXT NOT NULL,
  phone      TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  parent_id  TEXT REFERENCES categories(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  store_id    TEXT NOT NULL REFERENCES stores(id),
  category_id TEXT REFERENCES categories(id),
  sku         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL CHECK (price >= 0),
  image_url   TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','published','unpublished','suspended','archived')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (store_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

CREATE TABLE IF NOT EXISTS inventory_items (
  product_id          TEXT PRIMARY KEY REFERENCES products(id),
  quantity            INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  actor_id   TEXT,
  order_id   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carts (
  id         TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  store_id   TEXT NOT NULL REFERENCES stores(id),
  created_at TEXT NOT NULL,
  UNIQUE (customer_id, store_id)
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id    TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  order_number    TEXT NOT NULL UNIQUE,
  customer_id     TEXT NOT NULL REFERENCES users(id),
  store_id        TEXT NOT NULL REFERENCES stores(id),
  state           TEXT NOT NULL,
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('momo','card','cod')),
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('delivery','pickup')),
  subtotal        INTEGER NOT NULL,
  delivery_fee    INTEGER NOT NULL DEFAULT 0,
  discount        INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  address_id      TEXT REFERENCES addresses(id),
  address_snapshot TEXT NOT NULL DEFAULT '{}',
  notes           TEXT DEFAULT '',
  cancel_reason   TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

-- Immutable commercial line snapshots (BR-02, FR-ORD-05)
CREATE TABLE IF NOT EXISTS order_items (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  product_id     TEXT NOT NULL,
  product_name   TEXT NOT NULL,
  sku            TEXT NOT NULL,
  unit_price     INTEGER NOT NULL,
  quantity       INTEGER NOT NULL,
  discount       INTEGER NOT NULL DEFAULT 0,
  line_total     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  provider        TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('Initiated','Pending','Paid','Failed','Expired','RefundPending','Refunded','RefundFailed')),
  amount          INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  provider_ref    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- Dedupe for provider callbacks (FR-PAY-06): PK is the external event id
CREATE TABLE IF NOT EXISTS payment_events (
  external_event_id TEXT PRIMARY KEY,
  payment_id        TEXT NOT NULL REFERENCES payments(id),
  payload           TEXT NOT NULL,
  applied           INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id              TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id),
  order_id        TEXT NOT NULL REFERENCES orders(id),
  amount          INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed')),
  reason          TEXT NOT NULL DEFAULT '',
  actor_id        TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'inapp',
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient);

CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  actor_role TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  trace_id   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity, entity_id);
`;
