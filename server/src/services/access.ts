import type { AppCtx } from '../context.js';
import type { Role, StorePerm } from '../domain/permissions.js';
import { ALL_STORE_PERMS, MANAGER_PERMS, DEFAULT_STAFF_PERMS } from '../domain/permissions.js';
import { errors } from '../domain/errors.js';
import type { SessionUser } from './auth.js';

export interface StoreAccess {
  storeId: string;
  merchantId: string;
  role: 'owner' | 'manager' | 'staff';
  perms: StorePerm[];
  userRole: Role;
}

/** Extract the caller's store access for a given store; null when not related. */
export async function storeAccessFor(ctx: AppCtx, user: SessionUser, storeId: string): Promise<StoreAccess | null> {
  const store = await ctx.db
    .prepare('SELECT id, merchant_id FROM stores WHERE id = ?')
    .get(storeId) as { id: string; merchant_id: string } | undefined;
  if (!store) return null;

  const merchant = await ctx.db
    .prepare('SELECT id, owner_user_id FROM merchants WHERE id = ?')
    .get(store.merchant_id) as { id: string; owner_user_id: string } | undefined;
  if (!merchant) return null;

  if (user.role === 'admin') {
    return { storeId: store.id, merchantId: merchant.id, role: 'owner', perms: ALL_STORE_PERMS, userRole: user.role };
  }

  if (merchant.owner_user_id === user.id) {
    return { storeId: store.id, merchantId: merchant.id, role: 'owner', perms: ALL_STORE_PERMS, userRole: user.role };
  }

  const staff = await ctx.db
    .prepare('SELECT role, perms FROM store_staff WHERE store_id = ? AND user_id = ?')
    .get(storeId, user.id) as { role: 'staff' | 'manager'; perms: string } | undefined;
  if (!staff) return null;

  let perms: StorePerm[];
  if (staff.role === 'manager') {
    perms = MANAGER_PERMS;
  } else {
    try {
      const parsed = JSON.parse(staff.perms) as StorePerm[];
      perms = parsed.length ? parsed : DEFAULT_STAFF_PERMS;
    } catch {
      perms = DEFAULT_STAFF_PERMS;
    }
  }
  return { storeId: store.id, merchantId: merchant.id, role: staff.role, perms, userRole: user.role };
}

/**
 * FR-AUTH-09 / SEC-05: tenant ownership from authenticated context only.
 * Throws 403/404 without revealing other tenants' data.
 */
export async function requireStoreAccess(ctx: AppCtx, user: SessionUser, storeId: string): Promise<StoreAccess> {
  const access = await storeAccessFor(ctx, user, storeId);
  if (!access) throw errors.forbidden('You do not have access to this store.');
  return access;
}

export function requirePerm(access: StoreAccess, perm: StorePerm): void {
  if (!access.perms.includes(perm)) {
    throw errors.forbidden(`Missing permission: ${perm}`);
  }
}

export function canAccessPerm(access: StoreAccess, perm: StorePerm): boolean {
  return access.perms.includes(perm);
}
