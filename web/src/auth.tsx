import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface Me {
  id: string;
  role: 'customer' | 'staff' | 'manager' | 'owner' | 'support' | 'admin';
  name: string;
  email: string;
  phone: string | null;
  merchant?: { id: string; business_name: string; status: string } | null;
  staff?: { store_id: string; role: string }[];
  staffStore?: { id: string; name: string; slug: string; status: string } | null;
}

interface AuthCtx {
  user: Me | null;
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {}
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ user: Me | null }>('/auth/me');
      setUser(res.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return <Ctx.Provider value={{ user, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
