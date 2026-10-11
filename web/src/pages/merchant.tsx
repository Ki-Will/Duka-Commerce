import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, rwf } from '../api';
import { useAuth } from '../auth';
import { Card, Field, Notice, ErrorMsg, Table, Empty, Skeleton, useFlash, StateBadge, PayBadge } from '../components';

/** Load the caller's store (404 → null when no store exists yet). */
function useStore() {
  const [store, setStore] = useState<any>(null);
  const [merchant, setMerchant] = useState<any>(null);
  const [access, setAccess] = useState<{ role: string; perms: string[] } | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<any>('/merchant/store')
      .then((r) => { setStore(r.store); setMerchant(r.merchant); setAccess(r.access); })
      .catch((e) => setError(e))
      .finally(() => setReady(true));
  }, []);
  return { store, merchant, access, ready, error, setStore };
}

export function MerchantHome() {
  const { store, merchant, ready, error, setStore } = useStore();
  const [summary, setSummary] = useState<any>(null);
  const [newStore, setNewStore] = useState({ name: '', description: '', contact: '' });
  const { error: fErr, ok, run } = useFlash();

  useEffect(() => {
    if (store) run(() => api<any>('/merchant/reports/summary')).then((r) => r && setSummary(r));
  }, [store]);

  const createStore = () =>
    run(async () => {
      const r = await api<any>('/merchant/store', { method: 'POST', body: newStore });
      setStore(r.store);
    }, 'Store created!');

  if (!ready) return <Skeleton lines={4} />;

  if (error && (!merchant || merchant.status !== 'approved')) {
    return (
      <div>
        <h1>🏪 Merchant console</h1>
        <Card title="Before you start">
          <p>You need an approved merchant account and a store.</p>
          <Link className="btn" to="/apply">Apply for a merchant account</Link>
        </Card>
      </div>
    );
  }

  if (!store) {
    return (
      <div>
        <h1>🏪 Create your store</h1>
        <Notice kind="ok">{ok}</Notice>
        <ErrorMsg error={fErr} />
        <Card>
          <Field label="Store name"><input value={newStore.name} onChange={(e) => setNewStore({ ...newStore, name: e.target.value })} /></Field>
          <Field label="Description"><input value={newStore.description} onChange={(e) => setNewStore({ ...newStore, description: e.target.value })} /></Field>
          <Field label="Contact"><input value={newStore.contact} onChange={(e) => setNewStore({ ...newStore, contact: e.target.value })} /></Field>
          <button className="btn" onClick={createStore}>Create store</button>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="row between">
        <h1>🏬 {store.name}</h1>
        <span className={`badge ${store.status === 'open' ? 's-confirmed' : 's-cancelled'}`}>{store.status}</span>
      </div>
      <ErrorMsg error={fErr} />
      <Notice kind="ok">{ok}</Notice>
      <div className="grid cols-4">
        <div className="stat"><div className="num">{summary?.totals?.order_count ?? '—'}</div><div className="lbl">Orders</div></div>
        <div className="stat"><div className="num">{rwf(summary?.totals?.sales_total ?? 0)}</div><div className="lbl">Sales</div></div>
        <div className="stat"><div className="num">{summary?.totals?.cancelled_count ?? '—'}</div><div className="lbl">Cancelled</div></div>
        <div className="stat"><div className="num">{summary?.refunds?.refund_count ?? '—'}</div><div className="lbl">Refunds</div></div>
      </div>
      <Card title="Quick actions">
        <div className="row">
          <Link className="btn" to="/merchant/orders">Order queue</Link>
          <Link className="btn ghost" to="/merchant/products">Products</Link>
          <Link className="btn ghost" to="/merchant/inventory">Inventory</Link>
          <Link className="btn ghost" to="/merchant/reports">Reports</Link>
          <Link className="btn ghost" to="/merchant/staff">Staff</Link>
          <Link className="btn ghost" to="/merchant/settings">Settings</Link>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Merchant account: <b>{merchant?.business_name}</b> · status <b>{merchant?.status}</b> · your role <b>{store && 'owner/manager/staff'}</b>
        </p>
      </Card>
    </div>
  );
}

/* ---------------- Products ---------------- */
const emptyProduct = { name: '', sku: '', price: '', quantity: '', description: '', imageUrl: '', lowStockThreshold: '5' };

export function MerchantProducts() {
  const { store, ready } = useStore();
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [form, setForm] = useState(emptyProduct);
  const [showForm, setShowForm] = useState(false);
  const { error, ok, run } = useFlash();

  const reload = () => run(async () => {
    const [p, c] = await Promise.all([api<any>('/merchant/products'), api<any>('/categories')]);
    setProducts(p.products);
    setCategories(c.categories);
  });

  useEffect(() => { if (store) reload(); }, [store]);

  const create = () =>
    run(async () => {
      await api('/merchant/products', {
        method: 'POST',
        body: {
          name: form.name,
          sku: form.sku,
          price: Number(form.price),
          quantity: Number(form.quantity || 0),
          description: form.description,
          imageUrl: form.imageUrl,
          lowStockThreshold: Number(form.lowStockThreshold || 5)
        }
      });
      setForm(emptyProduct);
      setShowForm(false);
      await reload();
    }, 'Product saved as draft.');

  const action = (id: string, act: string) =>
    run(async () => {
      await api(`/merchant/products/${id}/${act}`, { method: 'POST' });
      await reload();
    }, `Product ${act}ed.`);

  const remove = (id: string) =>
    run(async () => {
      await api(`/merchant/products/${id}/archive`, { method: 'POST' });
      await reload();
    }, 'Product archived.');

  if (!ready) return <Skeleton lines={4} />;
  return (
    <div>
      <div className="row between">
        <h1>📦 Products</h1>
        <button className="btn" onClick={() => setShowForm(!showForm)}>{showForm ? 'Close' : '+ New product'}</button>
      </div>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>

      {showForm && (
        <Card title="New product (saved as draft)">
          <div className="grid cols-2">
            <div>
              <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="SKU"><input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></Field>
              <Field label="Price (RWF, integer)"><input type="number" min={0} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
            </div>
            <div>
              <Field label="Initial stock"><input type="number" min={0} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></Field>
              <Field label="Low-stock threshold"><input type="number" min={0} value={form.lowStockThreshold} onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })} /></Field>
              <Field label="Image URL (optional)"><input value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} placeholder="https://…" /></Field>
            </div>
          </div>
          <Field label="Description"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <button className="btn" onClick={create}>Save draft</button>
        </Card>
      )}

      <Card>
        {products.length === 0 ? <Empty>No products yet — create your first one.</Empty> : (
          <Table cols={['Product', 'Price', 'Stock', 'Status', 'Actions']}>
            {products.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b><div className="muted">{p.sku}{p.category_name ? ` · ${p.category_name}` : ''}</div></td>
                <td>{rwf(p.price)}</td>
                <td>{p.quantity} {p.quantity < p.low_stock_threshold && <span className="badge s-cancelled">low</span>}</td>
                <td><span className={`badge ${p.status === 'published' ? 's-confirmed' : 's-pendingpayment'}`}>{p.status}</span></td>
                <td>
                  <div className="row">
                    {p.status === 'draft' && <button className="btn small" onClick={() => action(p.id, 'publish')}>Publish</button>}
                    {p.status === 'published' && <button className="btn small ghost" onClick={() => action(p.id, 'unpublish')}>Unpublish</button>}
                    {(p.status === 'unpublished' || p.status === 'suspended') && (
                      <button className="btn small" onClick={() => action(p.id, 'publish')}>Republish</button>
                    )}
                    {p.status !== 'archived' && <button className="btn small danger" onClick={() => remove(p.id)}>Archive</button>}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Inventory ---------------- */
export function MerchantInventory() {
  const { store, ready } = useStore();
  const [items, setItems] = useState<any[]>([]);
  const [adjust, setAdjust] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('manual_adjustment');
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>('/merchant/inventory')).then((r) => r && setItems(r.inventory));
  useEffect(() => { if (store) reload(); }, [store]);

  const applyAdjustment = (productId: string) =>
    run(async () => {
      const delta = Number(adjust[productId] ?? 0);
      if (!delta) throw new Error('Enter a non-zero quantity change.');
      await api('/merchant/inventory/adjustments', { method: 'POST', body: { productId, delta, reason } });
      setAdjust({ ...adjust, [productId]: '' });
      await reload();
    }, 'Stock adjusted.');

  const setThreshold = (productId: string, threshold: number) =>
    run(async () => {
      await api(`/merchant/inventory/${productId}`, { method: 'PATCH', body: { lowStockThreshold: threshold } });
      await reload();
    }, 'Threshold updated.');

  if (!ready) return <Skeleton lines={4} />;
  return (
    <div>
      <h1>🗄️ Inventory</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <Card title="Stock levels">
        {items.length === 0 ? <Empty>No products yet.</Empty> : (
          <Table cols={['Product', 'Stock', 'Low-stock at', 'Change', 'Reason', '']}>
            {items.map((i) => (
              <tr key={i.product_id}>
                <td><b>{i.name}</b><div className="muted">{i.sku}</div></td>
                <td>
                  <b>{i.quantity}</b> {i.low_stock === 1 && <span className="badge s-cancelled">LOW</span>}
                </td>
                <td>
                  <input className="qty" type="number" min={0} defaultValue={i.low_stock_threshold}
                    onBlur={(e) => Number(e.target.value) !== i.low_stock_threshold && setThreshold(i.product_id, Number(e.target.value))} />
                </td>
                <td>
                  <input className="qty" type="number" placeholder="+/-" value={adjust[i.product_id] ?? ''}
                    onChange={(e) => setAdjust({ ...adjust, [i.product_id]: e.target.value })} />
                </td>
                <td>
                  <input className="text-input" value={reason} onChange={(e) => setReason(e.target.value)} />
                </td>
                <td><button className="btn small" onClick={() => applyAdjustment(i.product_id)}>Apply</button></td>
              </tr>
            ))}
          </Table>
        )}
        <p className="muted">Stock changes are recorded with actor, reason and time in the audit trail. Negative stock is never allowed.</p>
      </Card>
    </div>
  );
}

/* ---------------- Orders queue ---------------- */
const FILTERS = ['', 'Confirmed', 'Accepted', 'Preparing', 'ReadyForDispatch', 'Dispatched', 'Delivered', 'Completed', 'Cancelled', 'PaymentFailed'];

export function MerchantOrders() {
  const { store, ready } = useStore();
  const [orders, setOrders] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const { error, run } = useFlash();

  const reload = (f = '') => run(() => api<any>('/merchant/orders', { query: { state: f } })).then((r) => r && setOrders(r.orders));
  useEffect(() => { if (store) reload(filter); }, [store, filter]);

  if (!ready) return <Skeleton lines={4} />;
  return (
    <div>
      <h1>🧾 Order queue</h1>
      <ErrorMsg error={error} />
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f || 'All'}
          </button>
        ))}
      </div>
      <Card>
        {orders.length === 0 ? <Empty>No orders{filter ? ` in state ${filter}` : ''}.</Empty> : (
          <Table cols={['Order', 'Customer', 'Total', 'Status', 'Placed', '']}>
            {orders.map((o) => (
              <tr key={o.id}>
                <td><b>{o.order_number}</b></td>
                <td>{o.customer_name}</td>
                <td>{rwf(o.total)}</td>
                <td><StateBadge state={o.state} /></td>
                <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                <td><Link className="btn small ghost" to={`/merchant/orders/${o.id}`}>Process</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Order detail (process/fulfill/refund) ---------------- */
export function MerchantOrderDetail() {
  const { orderId } = useParams();
  const nav = useNavigate();
  const [order, setOrder] = useState<any>(null);
  const [reason, setReason] = useState('');
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>(`/merchant/orders/${orderId}`)).then((r) => r && setOrder(r.order));
  useEffect(() => { reload(); }, [orderId]);

  const call = (path: string, body?: unknown, success?: string) =>
    run(async () => {
      await api(path, { method: 'POST', body });
      await reload();
    }, success);

  if (!order) return <ErrorMsg error={error} />;
  const s = order.state;
  const payment = order.payments?.[order.payments.length - 1];
  const pendingRefund = order.refunds?.find((r: any) => r.state === 'pending');

  const next: Record<string, string> = {
    Accepted: 'Preparing',
    Preparing: 'ReadyForDispatch',
    ReadyForDispatch: 'Dispatched',
    Dispatched: 'Delivered',
    Delivered: 'Completed'
  };

  return (
    <div>
      <div className="row between">
        <h1>🧾 {order.order_number}</h1>
        <div className="row">
          <StateBadge state={order.state} />
          <button className="btn ghost small" onClick={() => nav('/merchant/orders')}>← Queue</button>
        </div>
      </div>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>

      <div className="grid cols-2">
        <Card title="Order lines">
          <Table cols={['Product', 'Unit price', 'Qty', 'Line total']}>
            {order.items.map((it: any) => (
              <tr key={it.id}>
                <td>{it.product_name}<div className="muted">{it.sku}</div></td>
                <td>{rwf(it.unit_price)}</td>
                <td>{it.quantity}</td>
                <td>{rwf(it.line_total)}</td>
              </tr>
            ))}
          </Table>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Subtotal</dt><dd>{rwf(order.subtotal)}</dd>
            <dt>Delivery fee</dt><dd>{rwf(order.delivery_fee)}</dd>
            <dt>Total</dt><dd><b>{rwf(order.total)}</b></dd>
          </dl>
        </Card>

        <div>
          <Card title="Customer & delivery">
            <dl className="kv">
              <dt>Customer</dt><dd>{order.customer?.name}</dd>
              <dt>Delivery</dt><dd>{order.delivery_method === 'delivery' ? 'Delivery' : 'Pickup'}</dd>
              <dt>Address</dt>
              <dd>{order.delivery_method === 'delivery'
                ? <>{order.address_snapshot?.name}, {order.address_snapshot?.line1}, {order.address_snapshot?.city}</>
                : '—'}</dd>
              <dt>Payment</dt>
              <dd>{payment ? <PayBadge state={payment.state} /> : <span className="muted">{order.payment_method.toUpperCase()}</span>}</dd>
              {payment?.provider_ref && (<><dt>Provider ref</dt><dd className="muted">{payment.provider_ref}</dd></>)}
              {order.refunds?.length > 0 && (<><dt>Refund</dt><dd>{order.refunds.map((r: any) => `${rwf(r.amount)} (${r.state})`).join(', ')}</dd></>)}
            </dl>
          </Card>

          <Card title="Actions">
            <div className="row">
              {s === 'Confirmed' && (
                <>
                  <button className="btn" onClick={() => call(`/merchant/orders/${orderId}/accept`, undefined, 'Order accepted.')}>Accept order</button>
                  <button className="btn danger" onClick={() => call(`/merchant/orders/${orderId}/reject`, { reason: reason || 'Rejected by merchant' }, 'Order rejected.')}>Reject</button>
                </>
              )}
              {next[s] && (
                <button className="btn" onClick={() => call(`/merchant/orders/${orderId}/status`, { to: next[s] }, `Marked ${next[s]}.`)}>
                  Mark {next[s].replace(/([A-Z])/g, ' $1').toLowerCase()}
                </button>
              )}
              {payment?.state === 'Paid' && !pendingRefund && (
                <button className="btn ghost" onClick={() => call(`/merchant/orders/${orderId}/refund`, { reason: reason || 'Refund requested', idempotencyKey: crypto.randomUUID() }, 'Refund initiated.')}>
                  Initiate refund
                </button>
              )}
              {pendingRefund && (
                <>
                  <button className="btn" onClick={() => call(`/merchant/orders/${orderId}/refunds/${pendingRefund.id}/complete`, { success: true }, 'Refund completed.')}>Complete refund</button>
                  <button className="btn danger" onClick={() => call(`/merchant/orders/${orderId}/refunds/${pendingRefund.id}/complete`, { success: false }, 'Refund failed.')}>Fail refund</button>
                </>
              )}
              {['Confirmed', 'Accepted', 'Preparing'].includes(s) && (
                <button className="btn danger" onClick={() => call(`/merchant/orders/${orderId}/cancel`, { reason: reason || 'Merchant cancelled' }, 'Order cancelled.')}>
                  Cancel order
                </button>
              )}
            </div>
            <Field label="Reason (used for reject / cancel / refund)">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Item out of stock" />
            </Field>
            <p className="muted">Every state change is validated against the order state machine, audited, and notifies the customer.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Staff ---------------- */
export function MerchantStaff() {
  const { store, ready } = useStore();
  const [staff, setStaff] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'staff' });
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>('/merchant/staff')).then((r) => r && setStaff(r.staff));
  useEffect(() => { if (store) reload(); }, [store]);

  const add = () =>
    run(async () => {
      await api('/merchant/staff', { method: 'POST', body: form });
      setForm({ name: '', email: '', password: '', role: 'staff' });
      await reload();
    }, 'Staff member assigned.');

  const remove = (userId: string) =>
    run(async () => {
      await api(`/merchant/staff/${userId}`, { method: 'DELETE' });
      await reload();
    }, 'Staff removed.');

  if (!ready) return <Skeleton lines={4} />;
  return (
    <div>
      <h1>👥 Staff</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <div className="grid cols-2">
        <Card title="Assigned staff">
          {staff.length === 0 ? <Empty>No staff assigned yet.</Empty> : (
            <Table cols={['Name', 'Email', 'Role', '']}>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="muted">{s.email}</td>
                  <td><span className="pill">{s.role}</span></td>
                  <td><button className="btn small danger" onClick={() => remove(s.id)}>Remove</button></td>
                </tr>
              ))}
            </Table>
          )}
          <p className="muted">Staff get order processing and reports by default; managers get full store permissions.</p>
        </Card>
        <Card title="Add staff member">
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password" hint="At least 8 characters."><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="staff">Staff (orders + reports)</option>
              <option value="manager">Manager (full store access)</option>
            </select>
          </Field>
          <button className="btn" onClick={add}>Assign to store</button>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Settings ---------------- */
export function MerchantSettings() {
  const { store, ready, setStore } = useStore();
  const [form, setForm] = useState({ name: '', description: '', contact: '' });
  const { error, ok, run } = useFlash();

  useEffect(() => {
    if (store) setForm({ name: store.name, description: store.description, contact: store.contact });
  }, [store]);

  const save = () =>
    run(async () => {
      const r = await api<any>('/merchant/store', { method: 'PATCH', body: form });
      setStore(r.store);
    }, 'Store profile saved (audited).');

  const toggleStatus = () =>
    run(async () => {
      const r = await api<any>('/merchant/store/status', { method: 'PATCH', body: { status: store.status === 'open' ? 'closed' : 'open' } });
      setStore(r.store);
    }, 'Store status updated.');

  if (!ready || !store) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h1>⚙️ Store settings</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <div className="grid cols-2">
        <Card title="Profile">
          <Field label="Store name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Description"><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Contact"><input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} /></Field>
          <button className="btn" onClick={save}>Save changes</button>
        </Card>
        <Card title="Operating status">
          <p>Current status: <span className={`badge ${store.status === 'open' ? 's-confirmed' : 's-cancelled'}`}>{store.status}</span></p>
          <p className="muted">A closed or suspended store blocks new customer orders immediately.</p>
          <button className={`btn ${store.status === 'open' ? 'danger' : ''}`} onClick={toggleStatus}>
            {store.status === 'open' ? 'Close store' : 'Reopen store'}
          </button>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Reports ---------------- */
export function MerchantReports() {
  const { store, ready } = useStore();
  const [summary, setSummary] = useState<any>(null);
  const [top, setTop] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const { error, run } = useFlash();

  const reload = () => run(async () => {
    const [s, t, i] = await Promise.all([
      api<any>('/merchant/reports/summary'),
      api<any>('/merchant/reports/top-products'),
      api<any>('/merchant/reports/inventory')
    ]);
    setSummary(s);
    setTop(t.topProducts);
    setInventory(i.inventory);
  });

  useEffect(() => { if (store) reload(); }, [store]);

  if (!ready) return <Skeleton lines={4} />;
  return (
    <div>
      <h1>📊 Reports</h1>
      <ErrorMsg error={error} />
      <div className="grid cols-4">
        <div className="stat"><div className="num">{summary?.totals?.order_count ?? '—'}</div><div className="lbl">Orders in range</div></div>
        <div className="stat"><div className="num">{rwf(summary?.totals?.sales_total ?? 0)}</div><div className="lbl">Sales total</div></div>
        <div className="stat"><div className="num">{rwf(summary?.refunds?.refund_total ?? 0)}</div><div className="lbl">Refunded</div></div>
        <div className="stat"><div className="num">{summary?.totals?.failed_count ?? '—'}</div><div className="lbl">Failed payments</div></div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="Orders by status">
          {!summary ? <Empty>Loading…</Empty> : (
            <Table cols={['Status', 'Count']}>
              {summary.byState.map((r: any) => (
                <tr key={r.state}><td><StateBadge state={r.state} /></td><td>{r.count}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Payments by state">
          {!summary ? <Empty>Loading…</Empty> : summary.payments.length === 0 ? <Empty>No payments recorded.</Empty> : (
            <Table cols={['State', 'Count']}>
              {summary.payments.map((p: any) => (
                <tr key={p.state}><td><PayBadge state={p.state} /></td><td>{p.count}</td></tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Top products">
          {top.length === 0 ? <Empty>No sales yet.</Empty> : (
            <Table cols={['Product', 'Units sold', 'Revenue']}>
              {top.map((t) => (
                <tr key={t.product_name}><td>{t.product_name}</td><td>{t.units_sold}</td><td>{rwf(t.revenue)}</td></tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Inventory / low stock">
          {inventory.length === 0 ? <Empty>No products.</Empty> : (
            <Table cols={['Product', 'Stock', 'Threshold']}>
              {inventory.map((i) => (
                <tr key={i.product_id}>
                  <td>{i.name}</td>
                  <td>{i.quantity} {i.low_stock === 1 && <span className="badge s-cancelled">LOW</span>}</td>
                  <td>{i.low_stock_threshold}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
