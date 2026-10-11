/**
 * Order state machine (SRS §11.1). Every order transition goes through
 * transitionOrder(); illegal transitions are rejected (FR-ORD-09/10).
 */
export const ORDER_STATES = [
  'PendingPayment',
  'PaymentFailed',
  'Confirmed',
  'Accepted',
  'Rejected',
  'Preparing',
  'ReadyForDispatch',
  'Dispatched',
  'Delivered',
  'Completed',
  'Cancelled'
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

type Actor = 'system' | 'customer' | 'merchant' | 'admin';

const ALLOWED: Record<OrderState, Partial<Record<OrderState, Actor[]>>> = {
  PendingPayment: {
    Confirmed: ['system'], // payment confirmed or COD accepted (BR-04)
    PaymentFailed: ['system'],
    Cancelled: ['customer', 'system', 'admin']
  },
  PaymentFailed: {
    PendingPayment: ['customer', 'system'], // retry allowed
    Cancelled: ['customer', 'system', 'admin']
  },
  Confirmed: {
    Accepted: ['merchant'],
    Rejected: ['merchant', 'admin'],
    Cancelled: ['customer', 'merchant', 'admin'] // policy: before preparation
  },
  Accepted: {
    Preparing: ['merchant'],
    Cancelled: ['customer', 'merchant', 'admin'] // policy: before preparation
  },
  Preparing: {
    ReadyForDispatch: ['merchant'],
    Cancelled: ['merchant', 'admin'] // exceptional policy only
  },
  ReadyForDispatch: {
    Dispatched: ['merchant'],
    Cancelled: ['merchant', 'admin']
  },
  Dispatched: {
    Delivered: ['merchant']
  },
  Delivered: {
    Completed: ['merchant']
  },
  Completed: {},
  Rejected: {},
  Cancelled: {}
};

/** Customer cancellation is permitted only from configured states (FR-ORD-11, FR-REF-01). */
export function customerCanCancel(state: OrderState): boolean {
  return state === 'PendingPayment' || state === 'PaymentFailed' || state === 'Confirmed' || state === 'Accepted';
}

export function canTransition(from: OrderState, to: OrderState, actor: Actor): boolean {
  const map = ALLOWED[from];
  if (!map) return false;
  const actors = map[to];
  if (!actors) return false;
  return actor === 'admin' ? true : actors.includes(actor);
}

/** States after which stock has already been consumed (stock release policy). */
export const STOCK_CONSUMING_STATES: OrderState[] = [
  'PendingPayment',
  'PaymentFailed',
  'Confirmed',
  'Accepted',
  'Preparing',
  'ReadyForDispatch',
  'Dispatched',
  'Delivered',
  'Completed'
];

export function releasesStock(from: OrderState, to: OrderState): boolean {
  const terminalCancellations: OrderState[] = ['Cancelled', 'Rejected'];
  return terminalCancellations.includes(to) && STOCK_CONSUMING_STATES.includes(from);
}

export class IllegalTransitionError extends Error {
  constructor(
    public from: OrderState,
    public to: OrderState
  ) {
    super(`Illegal order transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function transitionOrder(from: OrderState, to: OrderState, actor: Actor): OrderState {
  if (!canTransition(from, to, actor)) throw new IllegalTransitionError(from, to);
  return to;
}
