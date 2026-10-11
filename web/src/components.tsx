import { type ReactNode, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { STATE_LABELS, PAYMENT_LABELS } from './api';

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const isMerchant = user && ['owner', 'manager', 'staff'].includes(user.role);
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">🇰🇪 <b>Duka</b>Commerce</Link>
        <nav className="mainnav">
          <NavLink to="/">Stores</NavLink>
          {user && <NavLink to="/carts">Cart</NavLink>}
          {user && <NavLink to="/orders">Orders</NavLink>}
          {user && <NavLink to="/notifications">Alerts</NavLink>}
          {isMerchant && <NavLink to="/merchant">Merchant</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
          {user?.role === 'support' && <NavLink to="/support">Support</NavLink>}
        </nav>
        <div className="authbox">
          {user ? (
            <>
              <Link to="/profile" className="whoami">{user.name} <span className={`pill role-${user.role}`}>{user.role}</span></Link>
              <button className="btn ghost" onClick={async () => { await logout(); nav('/'); }}>Log out</button>
            </>
          ) : (
            <>
              <Link className="btn ghost" to="/login">Log in</Link>
              <Link className="btn" to="/register">Sign up</Link>
            </>
          )}
        </div>
      </header>
      {/* keyed by path so the enter transition replays on navigation */}
      <main key={loc.pathname} className="page">{children}</main>
      <footer className="footer">DukaCommerce Phase 1 — multi-store marketplace for East Africa · RWF</footer>
    </div>
  );
}

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card">
      {(title || right) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function StateBadge({ state }: { state: string }) {
  const cls = `badge s-${(state || '').toLowerCase()}`;
  return <span className={cls}>{STATE_LABELS[state] ?? state}</span>;
}

export function PayBadge({ state }: { state: string }) {
  return <span className={`badge p-${(state || '').toLowerCase()}`}>{PAYMENT_LABELS[state] ?? state}</span>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: ReactNode }) {
  if (!children) return null;
  return <div className={`notice ${kind}`}>{children}</div>;
}

export function ErrorMsg({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <Notice kind="error">{msg}</Notice>;
}

/** Skeleton placeholder — avoids layout shift while data loads. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true">
      <div className="skeleton title" />
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton line" />)}
    </div>
  );
}

export function useFlash() {
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | null> => {
    try {
      setError(null);
      setOk(null);
      const out = await fn();
      if (success) setOk(success);
      return out;
    } catch (e) {
      setError(e);
      return null;
    }
  };
  return { error, ok, setError, setOk, run };
}

export function Table({ cols, children }: { cols: string[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
