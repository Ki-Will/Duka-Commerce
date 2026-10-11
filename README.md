# DukaCommerce — Phase 1

A multi-store e-commerce marketplace for East Africa (Rwanda-first), built as a simple
school project from the KivuTech document set:

| Document | ID | Role in this repo |
|---|---|---|
| Inception Report | KVT-DC-INC-2026-001 | scope, journeys, architecture baseline |
| Software Requirements Specification | KVT-DC-SRS-2026-001 | requirements (FR/BR/NFR/SEC), state machines, data model |
| UAT Test Pack | KVT-DC-UAT-2026-001 | 144 acceptance cases → `docs/rtm.csv` + automated tests |

## Quick start

```bash
npm install            # installs server + web workspaces
npm run seed           # demo/UAT data (idempotent)
npm test               # 166 automated tests (vitest)
npm run typecheck      # server + web TypeScript
npm run dev            # API on http://localhost:4000
npm run dev:web        # UI on http://localhost:5173 (proxies /api to :4000)
```

Seeded test accounts — **password for all: `password123`**

| Account | Role |
|---|---|
| `customer1@test.com`, `customer2@test.com` | customer |
| `merchant1@test.com` (Kigali Home) | merchant owner |
| `merchant2@test.com` (Imbere Fashion) | merchant owner |
| `merchant3@test.com` (Tech Corner) | merchant owner |
| `staff1@test.com` | store staff (Kigali Home) |
| `support@test.com` | support agent |
| `admin@test.com` | platform admin |

Payments use a **sandbox adapter** — the order-detail page has
*Simulate SUCCESS / FAILURE / TIMEOUT* buttons that push a signed callback through the
same code path as a real provider webhook (`POST /api/v1/payments/webhooks/:provider`).

## Architecture (simple, single-repo)

```
server/   Express + TypeScript API, SQLite via node:sqlite (PostgreSQL baseline dialect)
  src/db/          schema + re-entrant transaction helper (SAVEPOINT nesting)
  src/domain/      order/payment/product state machines, money math, permissions, errors
  src/services/    auth (scrypt+sessions+rate limit), audit, notifications,
                   inventory (atomic conditional updates), checkout (single tx),
                   orders (one transition path), payments (adapter + processor + refunds)
  src/routes/      auth, public discovery, customer, merchant, admin, support
  tests/           15 vitest suites — one per UAT chapter
web/    React + Vite SPA (customer storefront, merchant console, admin console, support)
docs/   rtm.csv — machine-readable traceability matrix (SRS §18.4)
```

### The four load-bearing mechanisms

1. **Order state machine** (SRS §11.1) — every change goes through `applyTransition()`;
   illegal transitions rejected (ORD-009, FUL-006).
2. **Atomic checkout** (SRS §11.4) — validate → reprice → conditional stock decrement
   (`WHERE quantity >= ?`) → create order in one transaction; no oversell under
   concurrency (INV-006, NF-003), client-supplied prices/discounts ignored (CART-007/008).
3. **Idempotent payments** — unique attempts, HMAC-verified webhooks, event-ID dedupe,
   amount check, timeout ≠ Paid (PAY-004..008, BR-05).
4. **Server-side authorization** — role + tenant ownership from the session only;
   default deny (SEC-003/004/009/010, AU-008, MER-009, CAT-014, ORD-014).

## Testing

```bash
npm test                          # full suite
npx vitest run -t "PAY-00"        # single UAT case by id
node scripts/generate-rtm.mjs     # regenerate docs/rtm.csv from test titles
```

- **166 automated tests / 15 files** covering **139 of the 144 UAT cases**
  (all Critical and High cases), each test titled with its UAT ID.
- **5 cases remain manual/ops** and are recorded `not_executed` in the RTM:
  NF-008 (`npm audit --omit=dev` in CI), NF-010/NF-011 (dashboards/alerts),
  NF-012 (keyboard accessibility), NF-013 (mobile viewport).
- The business UAT session itself (sign-off, verdicts) stays *Not Executed* until
  stakeholders run it — per the UAT pack's no-fabrication rule.

### Manual UAT checks (browser)

- NF-012: tab through login → product → cart → checkout with visible focus rings.
- NF-013: open the storefront at a 360 px viewport and complete a checkout.
- Sign-in as each seeded role and confirm nav + access rules match the permission matrix.

## Operations

- `GET /health` — liveness + database state, no secrets (NFR-REL-01).
- Structured JSON logs with `requestId` trace IDs (SRS §15.1); passwords, webhook
  secrets and raw PII never logged (SEC-06).
- Metrics/alerts (NF-010/011) belong to the deployment environment (Grafana/Prometheus);
  the app exposes counters through logs for a pilot.
- **Backup/restore (NF-014)**: stop the app, copy `server/duka.sqlite` (plus any
  `-wal`/`-shm` files) to backup, restore by copying it back. Covered by an automated test.
- Secrets come from environment variables (`PAYMENT_WEBHOOK_SECRET`, `SESSION_TTL_MS`,
  `LOGIN_MAX_ATTEMPTS`, `DELIVERY_FEE`, `DUKA_DB_FILE`); no `.env` or production
  secrets are committed (SEC-007).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | API port |
| `DUKA_DB_FILE` | `duka.sqlite` | SQLite database path |
| `PAYMENT_WEBHOOK_SECRET` | sandbox placeholder | HMAC secret for payment callbacks (set in prod) |
| `SESSION_TTL_MS` | 24h | session lifetime |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MS` | 5 / 15 min | login rate limiting |
| `DELIVERY_FEE` | 2000 | default delivery fee (RWF) |

## Phase 1 boundaries (kept deliberately)

Single-store checkout per order, physical goods, RWF, sandbox payments, merchant-managed
fulfillment. Out of scope per the Inception report: native apps, split settlement,
ERP/accounting, loyalty/AI, tax engines, crypto.
