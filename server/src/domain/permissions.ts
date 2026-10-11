/**
 * Permission model (SRS §4). Default deny; server-side authorization on every
 * protected resource (SEC-04/05).
 */
export type Role = 'customer' | 'staff' | 'manager' | 'owner' | 'support' | 'admin';

export type StorePerm =
  | 'store:write'
  | 'staff:write'
  | 'catalogue:write'
  | 'inventory:write'
  | 'orders:write'
  | 'reports:read';

export const ALL_STORE_PERMS: StorePerm[] = [
  'store:write',
  'staff:write',
  'catalogue:write',
  'inventory:write',
  'orders:write',
  'reports:read'
];

/** Store staff start with limited permissions; owner/manager grant more (FR-MER-06). */
export const DEFAULT_STAFF_PERMS: StorePerm[] = ['orders:write', 'reports:read'];
export const MANAGER_PERMS: StorePerm[] = ALL_STORE_PERMS;

export function isAdmin(role: Role): boolean {
  return role === 'admin';
}

export function isPlatformStaff(role: Role): boolean {
  return role === 'admin' || role === 'support';
}

/** Merchant console access roles. */
export function canAccessMerchantConsole(role: Role): boolean {
  return role === 'owner' || role === 'manager' || role === 'staff';
}
