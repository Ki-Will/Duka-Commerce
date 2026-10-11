export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public body: any
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}
): Promise<T> {
  let url = `/api/v1${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.code ?? 'ERROR', data.message ?? res.statusText, res.status, data);
  }
  return data as T;
}

export function rwf(amount: number): string {
  return `${Number(amount ?? 0).toLocaleString('en-US')} RWF`;
}

export const STATE_LABELS: Record<string, string> = {
  PendingPayment: 'Awaiting payment',
  PaymentFailed: 'Payment failed',
  Confirmed: 'Confirmed',
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  Preparing: 'Preparing',
  ReadyForDispatch: 'Ready for dispatch',
  Dispatched: 'Dispatched',
  Delivered: 'Delivered',
  Completed: 'Completed',
  Cancelled: 'Cancelled'
};

export const PAYMENT_LABELS: Record<string, string> = {
  Initiated: 'Initiated',
  Pending: 'Pending',
  Paid: 'Paid',
  Failed: 'Failed',
  Expired: 'Expired',
  RefundPending: 'Refund pending',
  Refunded: 'Refunded',
  RefundFailed: 'Refund failed'
};
