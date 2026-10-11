import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rwf } from '../api';
import { Card, Field, Notice, ErrorMsg, Table, Empty, useFlash, StateBadge, PayBadge } from '../components';

/* ---------------- Admin dashboard ---------------- */
export function AdminHome() {
  const [data, setData] = useState<any>(null);
  const { error, run } = useFlash();
  useEffect(() => { run(() => api<any>('/admin/reports/overview')).then((r) => r && setData(r)); }, []);

  const count = (rows: any[] | undefined, key: string, value: string) =>
    rows?.find((r: any) => r[key] === value)?.count ?? 0;

  return (
    <div>
      <h1>🛡️ Platform overview</h1>
      <ErrorMsg error={error} />
      <div className="grid cols-4">
        <div className="stat"><div className="num">{count(data?.merchants, 'status', 'pending')}</div><div className="lbl">Pending merchants</div></div>
        <div className="stat"><div className="num">{count(data?.merchants, 'status', 'approved')}</div><div className="lbl">Approved merchants</div></div>
        <div className="stat"><div className="num">{rwf(data?.grossRevenue ?? 0)}</div><div className="lbl">Gross revenue</div></div>
        <div className="stat"><div className="num">{data?.lowStockCount ?? '—'}</div><div className="lbl">Low-stock products</div></div>
        <div className="stat"><div className="num">{count(data?.orders, 'state', 'Confirmed')}</div><div className="lbl">Confirmed orders</div></div>
        <div className="stat"><div className="num">{count(data?.orders, 'state', 'PaymentFailed')}</div><div className="lbl">Failed payments</div></div>
        <div className="stat"><div className="num">{count(data?.payments, 'state', 'Pending')}</div><div className="lbl">Pending payments</div></div>
        <div className="stat"><div className="num">{count(data?.stores, 'status', 'suspended')}</div><div className="lbl">Suspended stores</div></div>
      </div>
      <Card title="Governance">
        <div className="row">
          <Link className="btn" to="/admin/merchants">Approve merchants</Link>
          <Link className="btn ghost" to="/admin/categories">Categories</Link>
          <Link className="btn ghost" to="/admin/stores">Stores</Link>
          <Link className="btn ghost" to="/admin/products">Moderation</Link>
          <Link className="btn ghost" to="/admin/orders">Orders</Link>
          <Link className="btn ghost" to="/admin/payments">Payments</Link>
          <Link className="btn ghost" to="/admin/audit">Audit log</Link>
        </div>
      </Card>
      <Card title="Orders by status">
        {!data ? <Empty>Loading…</Empty> : (
          <Table cols={['Status', 'Count']}>
            {data.orders.map((o: any) => <tr key={o.state}><td><StateBadge state={o.state} /></td><td>{o.count}</td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Merchants governance ---------------- */
export function AdminMerchants() {
  const [merchants, setMerchants] = useState<any[]>([]);
  const [reason, setReason] = useState('');
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>('/admin/merchants')).then((r) => r && setMerchants(r.merchants));
  useEffect(() => { reload(); }, []);

  const act = (id: string, action: string, needReason: boolean) =>
    run(async () => {
      if (needReason && !reason.trim()) throw new Error('A reason is required for reject/suspend.');
      await api(`/admin/merchants/${id}/${action}`, { method: 'POST', body: { reason } });
      await reload();
    }, `Merchant ${action}d.`);

  return (
    <div>
      <h1>🏪 Merchant applications</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <Card>
        <Field label="Reason (used for reject / suspend)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Incomplete verification documents" />
        </Field>
        {merchants.length === 0 ? <Empty>No applications yet.</Empty> : (
          <Table cols={['Business', 'Owner', 'Store', 'Status', 'Actions']}>
            {merchants.map((m) => (
              <tr key={m.id}>
                <td><b>{m.business_name}</b><div className="muted">{m.contact_email}</div></td>
                <td>{m.owner_name}<div className="muted">{m.owner_email}</div></td>
                <td>{m.store_name ? `${m.store_name} (${m.store_status})` : '—'}</td>
                <td><span className={`badge ${m.status === 'approved' ? 's-confirmed' : m.status === 'rejected' || m.status === 'suspended' ? 's-cancelled' : 's-pendingpayment'}`}>{m.status}</span></td>
                <td>
                  <div className="row">
                    {m.status !== 'approved' && <button className="btn small" onClick={() => act(m.id, 'approve', false)}>Approve</button>}
                    {m.status === 'pending' && <button className="btn small danger" onClick={() => act(m.id, 'reject', true)}>Reject</button>}
                    {m.status === 'approved' && <button className="btn small danger" onClick={() => act(m.id, 'suspend', true)}>Suspend</button>}
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

/* ---------------- Categories ---------------- */
export function AdminCategories() {
  const [categories, setCategories] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>('/admin/categories')).then((r) => r && setCategories(r.categories));
  useEffect(() => { reload(); }, []);

  const create = () => run(async () => {
    await api('/admin/categories', { method: 'POST', body: { name } });
    setName('');
    await reload();
  }, 'Category created.');

  const saveEdit = () => run(async () => {
    if (!edit) return;
    await api(`/admin/categories/${edit.id}`, { method: 'PATCH', body: { name: edit.name } });
    setEdit(null);
    await reload();
  }, 'Category updated.');

  return (
    <div>
      <h1>🏷️ Categories</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <div className="grid cols-2">
        <Card title="All categories">
          {categories.length === 0 ? <Empty>No categories yet.</Empty> : (
            <Table cols={['Name', 'Slug', '']}>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    {edit && edit.id === c.id ? (
                      <input value={edit.name} onChange={(e) => setEdit({ id: c.id, name: e.target.value })} />
                    ) : c.name}
                  </td>
                  <td className="muted">{c.slug}</td>
                  <td>
                    {edit && edit.id === c.id
                      ? <button className="btn small" onClick={saveEdit}>Save</button>
                      : <button className="btn small ghost" onClick={() => setEdit({ id: c.id, name: c.name })}>Rename</button>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Add category">
          <Field label="Category name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Building Materials" /></Field>
          <button className="btn" onClick={create}>Create</button>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Stores moderation ---------------- */
export function AdminStores() {
  const [stores, setStores] = useState<any[]>([]);
  const [reason, setReason] = useState('');
  const { error, ok, run } = useFlash();
  const reload = () => run(() => api<any>('/admin/stores')).then((r) => r && setStores(r.stores));
  useEffect(() => { reload(); }, []);

  const setStatus = (id: string, status: string) =>
    run(async () => {
      await api(`/admin/stores/${id}/status`, { method: 'POST', body: { status, reason } });
      await reload();
    }, `Store set to ${status}.`);

  return (
    <div>
      <h1>🏬 Stores</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <Card>
        <Field label="Reason (recorded in audit)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Policy violation" />
        </Field>
        {stores.length === 0 ? <Empty>No stores yet.</Empty> : (
          <Table cols={['Store', 'Merchant', 'Merchant status', 'Store status', 'Actions']}>
            {stores.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b><div className="muted">{s.slug}</div></td>
                <td>{s.business_name}</td>
                <td>{s.merchant_status}</td>
                <td><span className={`badge ${s.status === 'open' ? 's-confirmed' : 's-cancelled'}`}>{s.status}</span></td>
                <td>
                  <div className="row">
                    {s.status !== 'open' && <button className="btn small" onClick={() => setStatus(s.id, 'open')}>Open</button>}
                    {s.status !== 'closed' && <button className="btn small ghost" onClick={() => setStatus(s.id, 'closed')}>Close</button>}
                    {s.status !== 'suspended' && <button className="btn small danger" onClick={() => setStatus(s.id, 'suspended')}>Suspend</button>}
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

/* ---------------- Product moderation ---------------- */
export function AdminProducts() {
  const [products, setProducts] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const { error, ok, run } = useFlash();

  const reload = (q = '') => run(() => api<any>('/admin/products', { query: { search: q } })).then((r) => r && setProducts(r.products));
  useEffect(() => { reload(); }, []);

  const setStatus = (id: string, status: string) =>
    run(async () => {
      await api(`/admin/products/${id}/status`, { method: 'POST', body: { status, reason } });
      await reload(search);
    }, `Product set to ${status}.`);

  return (
    <div>
      <h1>🕵️ Product moderation</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <Card>
        <div className="row">
          <input className="searchbar" style={{ flex: 1, padding: '9px 10px', border: '1px solid var(--line)', borderRadius: 8 }}
            placeholder="Search name or SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn ghost" onClick={() => reload(search)}>Search</button>
        </div>
        <Field label="Reason (recorded in audit)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Counterfeit concern" />
        </Field>
        {products.length === 0 ? <Empty>No products found.</Empty> : (
          <Table cols={['Product', 'Store', 'Price', 'Status', 'Actions']}>
            {products.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b><div className="muted">{p.sku}</div></td>
                <td>{p.store_name}</td>
                <td>{rwf(p.price)}</td>
                <td><span className={`badge ${p.status === 'published' ? 's-confirmed' : 's-pendingpayment'}`}>{p.status}</span></td>
                <td>
                  <div className="row">
                    {p.status === 'published' && <button className="btn small danger" onClick={() => setStatus(p.id, 'suspended')}>Suspend</button>}
                    {p.status === 'published' && <button className="btn small ghost" onClick={() => setStatus(p.id, 'unpublished')}>Unpublish</button>}
                    {(p.status === 'unpublished' || p.status === 'suspended') && <button className="btn small" onClick={() => setStatus(p.id, 'published')}>Restore</button>}
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

/* ---------------- Platform orders ---------------- */
export function AdminOrders() {
  const [orders, setOrders] = useState<any[]>([]);
  const [state, setState] = useState('');
  const { error, run } = useFlash();
  const reload = (s = '') => run(() => api<any>('/admin/orders', { query: { state: s } })).then((r) => r && setOrders(r.orders));
  useEffect(() => { reload(); }, []);

  return (
    <div>
      <h1>🧾 Platform orders</h1>
      <ErrorMsg error={error} />
      <div className="tabs">
        {['', 'Confirmed', 'PaymentFailed', 'Cancelled', 'Completed'].map((s) => (
          <button key={s} className={state === s ? 'active' : ''} onClick={() => { setState(s); reload(s); }}>{s || 'All'}</button>
        ))}
      </div>
      <Card>
        {orders.length === 0 ? <Empty>No orders.</Empty> : (
          <Table cols={['Order', 'Store', 'Customer', 'Total', 'Status', 'Placed']}>
            {orders.map((o) => (
              <tr key={o.id}>
                <td><b>{o.order_number}</b></td>
                <td>{o.store_name}</td>
                <td>{o.customer_name}</td>
                <td>{rwf(o.total)}</td>
                <td><StateBadge state={o.state} /></td>
                <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Payments reconciliation ---------------- */
export function AdminPayments() {
  const [payments, setPayments] = useState<any[]>([]);
  const { error, run } = useFlash();
  useEffect(() => { run(() => api<any>('/admin/payments')).then((r) => r && setPayments(r.payments)); }, []);

  return (
    <div>
      <h1>💳 Payments & reconciliation</h1>
      <ErrorMsg error={error} />
      <Card>
        {payments.length === 0 ? <Empty>No payment attempts yet.</Empty> : (
          <Table cols={['Order', 'Provider', 'Provider ref', 'Amount', 'Payment state', 'Order state', 'Updated']}>
            {payments.map((p) => (
              <tr key={p.id}>
                <td><b>{p.order_number}</b></td>
                <td>{p.provider}</td>
                <td className="muted">{p.provider_ref}</td>
                <td>{rwf(p.amount)}</td>
                <td><PayBadge state={p.state} /></td>
                <td><StateBadge state={p.order_state} /></td>
                <td className="muted">{new Date(p.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="muted">Payment state comes only from authoritative provider callbacks — never from browser redirects.</p>
      </Card>
    </div>
  );
}

/* ---------------- Audit log ---------------- */
export function AdminAudit() {
  const [entries, setEntries] = useState<any[]>([]);
  const [entity, setEntity] = useState('');
  const { error, run } = useFlash();
  const reload = (e = '') => run(() => api<any>('/admin/audit', { query: { entity: e, limit: 200 } })).then((r) => r && setEntries(r.audit));
  useEffect(() => { reload(); }, []);

  return (
    <div>
      <h1>📜 Audit log</h1>
      <ErrorMsg error={error} />
      <div className="tabs">
        {['', 'order', 'payment', 'product', 'store', 'merchant', 'refund', 'user', 'category'].map((e) => (
          <button key={e} className={entity === e ? 'active' : ''} onClick={() => { setEntity(e); reload(e); }}>{e || 'All'}</button>
        ))}
      </div>
      <Card>
        {entries.length === 0 ? <Empty>No audit entries.</Empty> : (
          <Table cols={['Time', 'Actor', 'Role', 'Action', 'Entity', 'Detail']}>
            {entries.map((a) => (
              <tr key={a.id}>
                <td className="muted">{new Date(a.created_at).toLocaleString()}</td>
                <td className="muted">{a.actor_id ? a.actor_id.slice(0, 8) : 'system'}</td>
                <td>{a.actor_role ?? '—'}</td>
                <td><b>{a.action}</b></td>
                <td className="muted">{a.entity}{a.entity_id ? `:${String(a.entity_id).slice(0, 8)}` : ''}</td>
                <td className="muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.detail}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Support lookup ---------------- */
export function SupportHome() {
  const [orderNumber, setOrderNumber] = useState('');
  const [result, setResult] = useState<any>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const { error, ok, run } = useFlash();

  const findOrder = () =>
    run(async () => {
      setResult(null);
      const r = await api<any>(`/support/orders/${encodeURIComponent(orderNumber.trim())}`);
      setResult(r);
    });

  const findCustomer = () =>
    run(async () => {
      const r = await api<any>('/support/customers', { query: { search: customerSearch } });
      setCustomers(r.users);
    }, 'Lookup recorded in audit log.');

  return (
    <div>
      <h1>🎧 Support lookup</h1>
      <p className="muted">Read-only investigation. Every lookup is audited; you cannot modify orders or payments.</p>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <div className="grid cols-2">
        <Card title="Find an order">
          <Field label="Order number"><input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="DC-20261009-0001-XXXX" /></Field>
          <button className="btn" onClick={findOrder}>Search</button>
          {result && (
            <div style={{ marginTop: 14 }}>
              <dl className="kv">
                <dt>Order</dt><dd>{result.order.order_number}</dd>
                <dt>Status</dt><dd><StateBadge state={result.order.state} /></dd>
                <dt>Store</dt><dd>{result.order.store_name}</dd>
                <dt>Customer</dt><dd>{result.order.customer_name}</dd>
                <dt>Total</dt><dd>{rwf(result.order.total)}</dd>
                <dt>Payment</dt>
                <dd>{result.payment ? <PayBadge state={result.payment.state} /> : <span className="muted">none (COD)</span>}</dd>
              </dl>
              <Table cols={['Item', 'Qty', 'Line total']}>
                {result.items.map((it: any, idx: number) => (
                  <tr key={idx}><td>{it.product_name}</td><td>{it.quantity}</td><td>{rwf(it.line_total)}</td></tr>
                ))}
              </Table>
            </div>
          )}
        </Card>
        <Card title="Find a customer">
          <Field label="Name, email or phone"><input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} /></Field>
          <button className="btn ghost" onClick={findCustomer}>Search</button>
          {customers.length > 0 && (
            <Table cols={['Name', 'Email', 'Phone', 'Joined']}>
              {customers.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="muted">{u.email}</td>
                  <td className="muted">{u.phone ?? '—'}</td>
                  <td className="muted">{new Date(u.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
