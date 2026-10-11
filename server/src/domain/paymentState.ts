/** Payment state machine (SRS §11.2). Pending never silently becomes Paid (BR-05). */
export const PAYMENT_STATES = [
  'Initiated',
  'Pending',
  'Paid',
  'Failed',
  'Expired',
  'RefundPending',
  'Refunded',
  'RefundFailed'
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

const ALLOWED: Record<PaymentState, PaymentState[]> = {
  Initiated: ['Pending', 'Failed', 'Expired'],
  Pending: ['Paid', 'Failed', 'Expired'],
  Paid: ['RefundPending'],
  Failed: [],
  Expired: [],
  RefundPending: ['Refunded', 'RefundFailed'],
  Refunded: [],
  RefundFailed: ['RefundPending']
};

export class IllegalPaymentTransitionError extends Error {
  constructor(
    public from: PaymentState,
    public to: PaymentState
  ) {
    super(`Illegal payment transition ${from} -> ${to}`);
    this.name = 'IllegalPaymentTransitionError';
  }
}

export function canPaymentTransition(from: PaymentState, to: PaymentState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function transitionPayment(from: PaymentState, to: PaymentState): PaymentState {
  if (!canPaymentTransition(from, to)) throw new IllegalPaymentTransitionError(from, to);
  return to;
}

/** Authoritative final states. */
export function isFinalPaymentState(state: PaymentState): boolean {
  return state === 'Paid' || state === 'Failed' || state === 'Expired' || state === 'Refunded';
}
