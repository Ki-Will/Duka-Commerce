import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, rwf } from '../api';
import { useAuth } from '../auth';
import { Card, Field, Notice, ErrorMsg, Table, Empty, Skeleton, useFlash, StateBadge, PayBadge } from '../components';

/* ---------------- Discovery: Home ---------------- */
export function Home() {
  const [stores, setStores] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [loaded, setLoaded] = useState(false);
  const { run } = useFlash();

  const load = (q = '', cat = '') =>
    run(async () => {
      try {
        const [s, p, c] = await Promise.all([
          api<any>('/stores', { query: { search: q } }),
          api<any>('/products', { query: { search: q, category: cat } }),
          api<any>('/categories')
        ]);
        setStores(s.stores);
        setProducts(p.products);
        setCategories(c.categories);
      } finally {
        setLoaded(true); // stop skeletons even on error — the error notice shows instead
      }
    });

  useEffect(() => { load(); }, []);

  const loading = !loaded;
  return (
    <div>
      <section className="hero">
        <h1>Everything your neighbourhood sells, one marketplace.</h1>
        <p className="lead">
          Shops across Kigali and East Africa — building materials, fashion, electronics —
          with mobile-money checkout and live order tracking, in Rwandan francs.
        </p>
        <div className="searchbar">
          <input
            placeholder="Search products, SKUs or stores…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(search, category)}
          />
          <button className="btn" onClick={() => load(search, category)}>Search</button>
        </div>
      </section>

      <Card title="Stores" right={<span className="muted">{stores.length} open</span>}>
        {loading ? <Skeleton lines={2} /> : stores.length === 0 ? <Empty>No stores found.</Empty> : (
          <div className="grid cols-3">
            {stores.map((s) => (
              <Link key={s.id} to={`/store/${s.id}`} className="product-card" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="thumb">🏬</div>
                <h3>{s.name}</h3>
                <span className="muted">{s.product_count} products</span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Products"
        right={
          <select value={category} onChange={(e) => { setCategory(e.target.value); load(search, e.target.value); }}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        }
      >
        {loading ? <Skeleton lines={3} /> : products.length === 0 ? <Empty>No products match your search.</Empty> : (
          <div className="grid cols-4">
            {products.map((p) => (
              <div key={p.id} className="product-card">
                <div className="thumb">{p.image_url ? '🖼️' : '📦'}</div>
                <Link to={`/product/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <h3>{p.name}</h3>
                </Link>
                <span className="muted">{p.store_name}</span>
                <span className="price">{rwf(p.price)}</span>
                <span className="muted">{p.quantity > 0 ? `${p.quantity} in stock` : 'Out of stock'}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Store page ---------------- */
export function StorePage() {
  const { storeId } = useParams();
  const [store, setStore] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const { error, run } = useFlash();
  useEffect(() => {
    run(async () => {
      const [s, p] = await Promise.all([
        api<any>(`/stores/${storeId}`),
        api<any>(`/stores/${storeId}/products`)
      ]);
      setStore(s.store);
      setProducts(p.products);
    });
  }, [storeId]);
  if (!store) return <ErrorMsg error={error} />;
  return (
    <div>
      <h1>🏬 {store.name}</h1>
      <p className="muted">{store.description || 'No description yet.'}</p>
      <ErrorMsg error={error} />
      <Card title={`Products (${products.length})`}>
        {products.length === 0 ? <Empty>This store has no published products yet.</Empty> : (
          <div className="grid cols-4">
            {products.map((p) => (
              <div key={p.id} className="product-card">
                <div className="thumb">📦</div>
                <Link to={`/product/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}><h3>{p.name}</h3></Link>
                <span className="price">{rwf(p.price)}</span>
                <span className="muted">{p.quantity > 0 ? `${p.quantity} in stock` : 'Out of stock'}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Product detail ---------------- */
export function ProductPage() {
  const { productId } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const [product, setProduct] = useState<any>(null);
  const [qty, setQty] = useState(1);
  const { error, ok, run } = useFlash();
  useEffect(() => { run(() => api<any>(`/products/${productId}`)).then((r) => r && setProduct(r.product)); }, [productId]);

  const addToCart = () =>
    run(async () => {
      const cart = await api<any>('/carts', { method: 'POST', body: { storeId: product.store_id } });
      await api(`/carts/${cart.cart.id}/items`, { method: 'POST', body: { productId: product.id, quantity: qty } });
      nav(`/cart/${cart.cart.id}`);
    });

  if (!product) return <ErrorMsg error={error} />;
  return (
    <div className="grid cols-2">
      <Card>
        <div className="thumb" style={{ height: 220, fontSize: '4rem' }}>📦</div>
      </Card>
      <Card title={product.name}>
        <p className="muted">SKU {product.sku} · <Link to={`/store/${product.store_id}`}>{product.store_name}</Link></p>
        <p style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--brand-dark)' }}>{rwf(product.price)}</p>
        <p>{product.description || 'No description.'}</p>
        <p>
          <span className={`badge ${product.quantity > 0 ? 's-confirmed' : 's-cancelled'}`}>
            {product.quantity > 0 ? `${product.quantity} available` : 'Out of stock'}
          </span>
          {!product.orderable && <span className="badge s-cancelled" style={{ marginLeft: 6 }}>Not orderable</span>}
        </p>
        <ErrorMsg error={error} />
        <Notice kind="ok">{ok}</Notice>
        <div className="row">
          <input className="qty" type="number" min={1} max={product.quantity} value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
          {user ? (
            <button className="btn" disabled={product.quantity < 1} onClick={addToCart}>Add to cart</button>
          ) : (
            <Link className="btn" to="/login">Log in to buy</Link>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Carts list ---------------- */
export function CartsPage() {
  const [carts, setCarts] = useState<any[]>([]);
  const { error, run } = useFlash();
  useEffect(() => { run(() => api<any>('/carts')).then((r) => r && setCarts(r.carts)); }, []);
  return (
    <div>
      <h1>Your carts</h1>
      <ErrorMsg error={error} />
      {carts.length === 0 ? (
        <Card><Empty>No carts yet — every store gets its own cart.</Empty>
          <Link className="btn" to="/">Browse stores</Link>
        </Card>
      ) : (
        <div className="grid cols-3">
          {carts.map((c) => (
            <Link key={c.id} to={`/cart/${c.id}`} className="product-card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <h3>🏬 {c.store?.name}</h3>
              <span className="muted">{c.items.length} line(s)</span>
              <span className="price">{rwf(c.totals.total)}</span>
              {c.checkoutBlocked && <span className="badge s-cancelled">Needs attention</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Cart detail + checkout ---------------- */
export function CartDetailPage() {
  const { cartId } = useParams();
  const nav = useNavigate();
  const [cart, setCart] = useState<any>(null);
  const [addresses, setAddresses] = useState<any[]>([]);
  const [addressId, setAddressId] = useState('');
  const [delivery, setDelivery] = useState<'pickup' | 'delivery'>('pickup');
  const [payment, setPayment] = useState<'momo' | 'card' | 'cod'>('momo');
  const { error, ok, run } = useFlash();

  const reload = () => run(async () => {
    const [c, prof] = await Promise.all([api<any>(`/carts/${cartId}`), api<any>('/profile')]);
    setCart(c.cart);
    setAddresses(prof.addresses);
    setAddressId((prev) => prev || prof.addresses?.[0]?.id || '');
    return c;
  });

  useEffect(() => { reload(); }, [cartId]);

  const setQty = (productId: string, quantity: number) =>
    run(async () => {
      const r = await api<any>(`/carts/${cartId}/items/${productId}`, { method: 'PATCH', body: { quantity } });
      setCart(r.cart);
    });

  const remove = (productId: string) =>
    run(async () => {
      const r = await api<any>(`/carts/${cartId}/items/${productId}`, { method: 'DELETE' });
      setCart(r.cart);
    });

  const checkout = () =>
    run(async () => {
      const order = await api<any>('/orders', {
        method: 'POST',
        body: {
          cartId,
          addressId: delivery === 'delivery' ? addressId : null,
          deliveryMethod: delivery,
          paymentMethod: payment,
          idempotencyKey: crypto.randomUUID()
        }
      });
      nav(`/orders/${order.order.id}`);
    }, 'Order placed!');

  if (!cart) return <ErrorMsg error={error} />;
  const t = cart.totals;
  return (
    <div>
      <h1>🛒 {cart.store?.name} cart</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      {cart.issues?.length > 0 && (
        <Notice kind="error">
          {cart.issues.map((i: string, idx: number) => <div key={idx}>{i}</div>)}
        </Notice>
      )}
      <div className="grid cols-2">
        <Card title="Items">
          {cart.items.length === 0 ? <Empty>Cart is empty.</Empty> : (
            <Table cols={['Product', 'Price', 'Qty', 'Line total', '']}>
              {cart.items.map((it: any) => (
                <tr key={it.product_id}>
                  <td>{it.name}<div className="muted">{it.sku}</div></td>
                  <td>{rwf(it.price)}</td>
                  <td>
                    <input className="qty" type="number" min={0} max={it.stock} value={it.quantity}
                      onChange={(e) => setQty(it.product_id, Number(e.target.value))} />
                    <div className="muted">{it.stock} in stock</div>
                  </td>
                  <td><b>{rwf(it.price * it.quantity)}</b></td>
                  <td><button className="btn small danger" onClick={() => remove(it.product_id)}>Remove</button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div>
          <Card title="Checkout summary">
            <dl className="kv">
              <dt>Subtotal</dt><dd>{rwf(t.subtotal)}</dd>
              <dt>Delivery fee</dt><dd>{rwf(t.deliveryFee)}</dd>
              <dt>Discount</dt><dd>{rwf(t.discount)}</dd>
              <dt>Total</dt><dd style={{ fontSize: '1.2rem' }}>{rwf(t.total)}</dd>
            </dl>
          </Card>
          <Card title="Delivery & payment">
            <Field label="Delivery method">
              <select value={delivery} onChange={(e) => setDelivery(e.target.value as any)}>
                <option value="pickup">Pickup from store (no fee)</option>
                <option value="delivery">Delivery (fee {rwf(2000)})</option>
              </select>
            </Field>
            {delivery === 'delivery' && (
              <Field label="Delivery address">
                {addresses.length === 0 ? (
                  <div className="notice error">No address saved. Add one in your <Link to="/profile">profile</Link> first.</div>
                ) : (
                  <select value={addressId} onChange={(e) => setAddressId(e.target.value)}>
                    {addresses.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} — {a.line1}, {a.city}</option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <Field label="Payment method" hint="Phase 1 uses a sandbox payment stub — no real money moves.">
              <select value={payment} onChange={(e) => setPayment(e.target.value as any)}>
                <option value="momo">Mobile money (MoMo sandbox)</option>
                <option value="card">Card (sandbox)</option>
                <option value="cod">Cash on delivery</option>
              </select>
            </Field>
            <button className="btn" style={{ width: '100%' }} disabled={cart.checkoutBlocked || cart.items.length === 0}
              onClick={checkout}>
              Place order · {rwf(t.total)}
            </button>
            {cart.checkoutBlocked && <Notice kind="error">Resolve the issues above to continue.</Notice>}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Order history ---------------- */
export function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const { error, run } = useFlash();
  useEffect(() => { run(() => api<any>('/orders')).then((r) => r && setOrders(r.orders)); }, []);
  return (
    <div>
      <h1>Your orders</h1>
      <ErrorMsg error={error} />
      <Card>
        {orders.length === 0 ? <Empty>No orders yet. <Link to="/">Start shopping</Link>.</Empty> : (
          <Table cols={['Order', 'Store', 'Total', 'Status', 'Date', '']}>
            {orders.map((o) => (
              <tr key={o.id}>
                <td><b>{o.order_number}</b></td>
                <td>{o.store_name}</td>
                <td>{rwf(o.total)}</td>
                <td><StateBadge state={o.state} /></td>
                <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                <td><Link className="btn small ghost" to={`/orders/${o.id}`}>View</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Order detail + payment + cancel ---------------- */
export function OrderDetailPage() {
  const { orderId } = useParams();
  const [order, setOrder] = useState<any>(null);
  const [cancelReason, setCancelReason] = useState('');
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>(`/orders/${orderId}`)).then((r) => r && setOrder(r.order));
  useEffect(() => { reload(); }, [orderId]);

  const simulate = (paymentId: string, result: string) =>
    run(async () => {
      await api(`/payments/${paymentId}/simulate`, { method: 'POST', body: { result } });
      await reload();
    }, `Sandbox payment "${result}" processed — check the status.`);

  const pay = (orderIdArg: string) =>
    run(async () => {
      await api('/payments', { method: 'POST', body: { orderId: orderIdArg, idempotencyKey: crypto.randomUUID() } });
      await reload();
    }, 'Payment attempt created.');

  const cancel = () =>
    run(async () => {
      await api(`/orders/${orderId}/cancel`, { method: 'POST', body: { reason: cancelReason || 'Customer cancelled' } });
      await reload();
    }, 'Order cancelled.');

  if (!order) return <ErrorMsg error={error} />;
  const payment = order.payments?.[order.payments.length - 1];
  const awaitingPayment = ['PendingPayment', 'PaymentFailed'].includes(order.state) && payment;
  const canCancel = ['PendingPayment', 'PaymentFailed', 'Confirmed', 'Accepted'].includes(order.state);

  return (
    <div>
      <div className="row between">
        <h1>🧾 {order.order_number}</h1>
        <StateBadge state={order.state} />
      </div>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>

      <div className="grid cols-2">
        <Card title="Items">
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
            <dt>Discount</dt><dd>{rwf(order.discount)}</dd>
            <dt>Total</dt><dd style={{ fontSize: '1.15rem' }}>{rwf(order.total)}</dd>
          </dl>
        </Card>

        <div>
          <Card title="Details">
            <dl className="kv">
              <dt>Store</dt><dd><Link to={`/store/${order.store?.id}`}>{order.store?.name}</Link></dd>
              <dt>Delivery</dt><dd>{order.delivery_method === 'delivery' ? 'Delivery' : 'Store pickup'}</dd>
              {order.delivery_method === 'delivery' && (
                <>
                  <dt>Address</dt>
                  <dd>
                    {order.address_snapshot?.name}<br />
                    {order.address_snapshot?.line1} {order.address_snapshot?.line2}<br />
                    {order.address_snapshot?.city}
                  </dd>
                </>
              )}
              <dt>Placed</dt><dd>{new Date(order.created_at).toLocaleString()}</dd>
              {order.cancel_reason && (<><dt>Reason</dt><dd>{order.cancel_reason}</dd></>)}
              <dt>Payment</dt>
              <dd>{payment ? <PayBadge state={payment.state} /> : <span className="muted">No payment attempt</span>}</dd>
              {payment?.provider_ref && (<><dt>Provider ref</dt><dd className="muted">{payment.provider_ref}</dd></>)}
            </dl>
            {order.refunds?.length > 0 && (
              <p><b>Refunds:</b> {order.refunds.map((r: any) => `${rwf(r.amount)} (${r.state})`).join(', ')}</p>
            )}
          </Card>

          {awaitingPayment && (
            <Card title="Complete payment (sandbox)">
              <p className="muted">
                Payment {payment.state.toLowerCase()} for {rwf(payment.amount)}.
                In production this redirects to the mobile-money provider; here you can simulate the provider callback:
              </p>
              <div className="row">
                <button className="btn" onClick={() => simulate(payment.id, 'success')}>Simulate SUCCESS</button>
                <button className="btn ghost" onClick={() => simulate(payment.id, 'failure')}>Simulate FAILURE</button>
                <button className="btn ghost" onClick={() => simulate(payment.id, 'timeout')}>Simulate TIMEOUT</button>
                <button className="btn ghost" onClick={() => pay(order.id)}>New attempt</button>
              </div>
            </Card>
          )}

          {canCancel && (
            <Card title="Cancel order">
              <Field label="Reason">
                <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Why are you cancelling?" />
              </Field>
              <button className="btn danger" onClick={cancel}>Cancel this order</button>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Auth pages ---------------- */
export function LoginPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, run } = useFlash();
  const submit = () =>
    run(async () => {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      await refresh();
      nav('/');
    });
  return (
    <Card title="Log in" >
      <div className="auth-card" style={{ margin: 0 }}>
        <Field label="Email"><input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <ErrorMsg error={error} />
        <button className="btn" style={{ width: '100%' }} onClick={submit}>Log in</button>
        <p className="muted">No account? <Link to="/register">Sign up</Link></p>
      </div>
    </Card>
  );
}

export function RegisterPage() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const { error, run } = useFlash();
  const submit = () =>
    run(async () => {
      await api('/auth/register', {
        method: 'POST',
        body: { ...form, phone: form.phone || undefined }
      });
      await refresh();
      nav('/');
    });
  return (
    <Card title="Create your account">
      <div className="auth-card" style={{ margin: 0 }}>
        <Field label="Full name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Phone (optional)"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0788…" /></Field>
        <Field label="Password" hint="At least 8 characters.">
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <ErrorMsg error={error} />
        <button className="btn" style={{ width: '100%' }} onClick={submit}>Sign up</button>
        <p className="muted">Already registered? <Link to="/login">Log in</Link></p>
      </div>
    </Card>
  );
}

/* ---------------- Profile & addresses ---------------- */
export function ProfilePage() {
  const [profile, setProfile] = useState<any>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState({ label: '', name: '', line1: '', line2: '', city: '', phone: '' });
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>('/profile')).then((r) => {
    if (r) { setProfile(r.user); setName(r.user.name); setPhone(r.user.phone ?? ''); }
  });
  useEffect(() => { reload(); }, []);

  const saveProfile = () => run(async () => {
    await api('/profile', { method: 'PATCH', body: { name, phone } });
    await reload();
  }, 'Profile updated.');

  const addAddress = () => run(async () => {
    await api('/addresses', { method: 'POST', body: addr });
    setAddr({ label: '', name: '', line1: '', line2: '', city: '', phone: '' });
    await reload();
  }, 'Address added.');

  const removeAddress = (id: string) => run(async () => {
    await api(`/addresses/${id}`, { method: 'DELETE' });
    await reload();
  }, 'Address removed.');

  if (!profile) return <ErrorMsg error={error} />;
  return (
    <div>
      <h1>👤 Profile</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      <div className="grid cols-2">
        <Card title="Account">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email"><input value={profile.email} disabled /></Field>
          <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <button className="btn" onClick={saveProfile}>Save changes</button>
        </Card>
        <Card title="Delivery addresses">
          {profile && addresses(profile)}
          <hr style={{ margin: '12px 0', border: 'none', borderTop: '1px solid var(--line)' }} />
          <h3 style={{ margin: '0 0 8px' }}>Add address</h3>
          <Field label="Label"><input value={addr.label} onChange={(e) => setAddr({ ...addr, label: e.target.value })} placeholder="Home" /></Field>
          <Field label="Recipient name"><input value={addr.name} onChange={(e) => setAddr({ ...addr, name: e.target.value })} /></Field>
          <Field label="Street"><input value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} /></Field>
          <Field label="City"><input value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></Field>
          <button className="btn" onClick={addAddress}>Add address</button>
        </Card>
      </div>
    </div>
  );

  function addresses(p: any) {
    if (!p.addresses?.length) return <Empty>No addresses saved yet.</Empty>;
    return (
      <div className="grid" style={{ gap: 8 }}>
        {p.addresses.map((a: any) => (
          <div key={a.id} className="row between" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>
            <div>
              <b>{a.name}</b> <span className="muted">{a.label}</span>
              <div className="muted">{a.line1} {a.line2}, {a.city}</div>
            </div>
            <button className="btn small danger" onClick={() => removeAddress(a.id)}>Delete</button>
          </div>
        ))}
      </div>
    );
  }
}

/* ---------------- Notifications ---------------- */
export function NotificationsPage() {
  const [items, setItems] = useState<any[]>([]);
  const { error, run } = useFlash();
  useEffect(() => { run(() => api<any>('/notifications')).then((r) => r && setItems(r.notifications)); }, []);
  return (
    <div>
      <h1>🔔 Notifications</h1>
      <ErrorMsg error={error} />
      <Card>
        {items.length === 0 ? <Empty>No notifications yet.</Empty> : (
          <Table cols={['Type', 'Subject', 'Message', 'Status', 'When']}>
            {items.map((n) => (
              <tr key={n.id}>
                <td className="muted">{n.type}</td>
                <td><b>{n.subject}</b></td>
                <td>{n.body}</td>
                <td><span className={`badge ${n.status === 'sent' ? 's-confirmed' : n.status === 'failed' ? 's-cancelled' : 's-pendingpayment'}`}>{n.status}</span></td>
                <td className="muted">{new Date(n.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Merchant application ---------------- */
export function ApplyPage() {
  const { user } = useAuth();
  const [mine, setMine] = useState<any>(null);
  const [form, setForm] = useState({ businessName: '', contactEmail: user?.email ?? '', contactPhone: user?.phone ?? '' });
  const { error, ok, run } = useFlash();

  const reload = () => run(() => api<any>('/merchants/mine')).then((r) => r && setMine(r));
  useEffect(() => { reload(); }, []);

  const apply = () => run(async () => {
    await api('/merchants/apply', { method: 'POST', body: form });
    await reload();
  }, 'Application submitted for review.');

  return (
    <div>
      <h1>🏪 Sell on DukaCommerce</h1>
      <ErrorMsg error={error} />
      <Notice kind="ok">{ok}</Notice>
      {mine?.merchant ? (
        <Card title="Application status">
          <dl className="kv">
            <dt>Business</dt><dd>{mine.merchant.business_name}</dd>
            <dt>Status</dt>
            <dd>
              <span className={`badge ${mine.merchant.status === 'approved' ? 's-confirmed' : mine.merchant.status === 'rejected' ? 's-cancelled' : 's-pendingpayment'}`}>
                {mine.merchant.status}
              </span>
            </dd>
            {mine.merchant.reason && (<><dt>Reason</dt><dd>{mine.merchant.reason}</dd></>)}
            <dt>Store</dt><dd>{mine.store ? mine.store.name : 'Not created yet'}</dd>
          </dl>
          {mine.merchant.status === 'approved' && !mine.store && (
            <p className="muted">Your application is approved — open the <Link to="/merchant">merchant console</Link> to create your store.</p>
          )}
          {mine.merchant.status === 'pending' && <Notice kind="info">A platform admin will review your application.</Notice>}
        </Card>
      ) : (
        <Card title="Apply for a merchant account">
          <Field label="Business name"><input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} /></Field>
          <Field label="Contact email"><input value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} /></Field>
          <Field label="Contact phone"><input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} /></Field>
          <button className="btn" onClick={apply}>Submit application</button>
        </Card>
      )}
    </div>
  );
}
