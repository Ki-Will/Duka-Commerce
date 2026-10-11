import { describe, it, expect } from 'vitest';
import {
  canTransition,
  transitionOrder,
  customerCanCancel,
  releasesStock,
  IllegalTransitionError,
  ORDER_STATES
} from '../src/domain/orderState.js';
import {
  transitionPayment,
  canPaymentTransition,
  isFinalPaymentState,
  IllegalPaymentTransitionError
} from '../src/domain/paymentState.js';
import { canProductTransition, isOrderable } from '../src/domain/productState.js';
import { lineSubtotal, orderTotal, computeTotals } from '../src/domain/money.js';

describe('Order state machine (SRS §11.1)', () => {
  it('allows the fulfillment happy path', () => {
    expect(canTransition('PendingPayment', 'Confirmed', 'system')).toBe(true);
    const merchantPath = [
      ['Confirmed', 'Accepted'],
      ['Accepted', 'Preparing'],
      ['Preparing', 'ReadyForDispatch'],
      ['ReadyForDispatch', 'Dispatched'],
      ['Dispatched', 'Delivered'],
      ['Delivered', 'Completed']
    ] as const;
    for (const [from, to] of merchantPath) {
      expect(canTransition(from, to, 'merchant'), `${from}->${to}`).toBe(true);
    }
  });

  it('rejects illegal transitions (ORD-009)', () => {
    expect(() => transitionOrder('Confirmed', 'Completed', 'merchant')).toThrow(IllegalTransitionError);
    expect(() => transitionOrder('PendingPayment', 'Delivered', 'system')).toThrow(IllegalTransitionError);
    expect(() => transitionOrder('Completed', 'Cancelled', 'customer')).toThrow(IllegalTransitionError);
    expect(() => transitionOrder('Cancelled', 'Confirmed', 'admin')).toThrow(IllegalTransitionError);
    expect(canTransition('Dispatched', 'Completed', 'merchant')).toBe(false);
  });

  it('restricts actors: customers cannot accept orders, merchants cannot confirm payments', () => {
    expect(canTransition('Confirmed', 'Accepted', 'customer')).toBe(false);
    expect(canTransition('PendingPayment', 'Confirmed', 'merchant')).toBe(false);
    expect(canTransition('PendingPayment', 'Confirmed', 'system')).toBe(true);
    expect(canTransition('Confirmed', 'Rejected', 'merchant')).toBe(true);
  });

  it('allows customer cancellation only from configured states (REF-001/002)', () => {
    expect(customerCanCancel('PendingPayment')).toBe(true);
    expect(customerCanCancel('Confirmed')).toBe(true);
    expect(customerCanCancel('Accepted')).toBe(true);
    expect(customerCanCancel('Preparing')).toBe(false); // merchant/admin policy only from here
    expect(customerCanCancel('Dispatched')).toBe(false);
    expect(customerCanCancel('Delivered')).toBe(false);
    expect(customerCanCancel('Completed')).toBe(false);
    expect(customerCanCancel('Cancelled')).toBe(false);
  });

  it('releases stock only on terminal cancellation/rejection (INV-005)', () => {
    expect(releasesStock('Confirmed', 'Cancelled')).toBe(true);
    expect(releasesStock('PendingPayment', 'Cancelled')).toBe(true);
    expect(releasesStock('Accepted', 'Rejected')).toBe(true);
    expect(releasesStock('Confirmed', 'Accepted')).toBe(false);
    expect(releasesStock('Delivered', 'Completed')).toBe(false);
  });

  it('defines every state exactly once', () => {
    expect(new Set(ORDER_STATES).size).toBe(ORDER_STATES.length);
  });
});

describe('Payment state machine (SRS §11.2)', () => {
  it('Pending never silently becomes Paid without provider confirmation', () => {
    expect(canPaymentTransition('Pending', 'Paid')).toBe(true);
    expect(canPaymentTransition('Initiated', 'Paid')).toBe(false);
    expect(canPaymentTransition('Expired', 'Paid')).toBe(false);
    expect(canPaymentTransition('Failed', 'Paid')).toBe(false);
  });

  it('supports failure, expiry and refund paths', () => {
    expect(transitionPayment('Pending', 'Failed')).toBe('Failed');
    expect(transitionPayment('Pending', 'Expired')).toBe('Expired');
    expect(transitionPayment('Paid', 'RefundPending')).toBe('RefundPending');
    expect(transitionPayment('RefundPending', 'Refunded')).toBe('Refunded');
    expect(() => transitionPayment('Paid', 'Failed')).toThrow(IllegalPaymentTransitionError);
    expect(() => transitionPayment('Refunded', 'Paid')).toThrow(IllegalPaymentTransitionError);
    expect(isFinalPaymentState('Paid')).toBe(true);
    expect(isFinalPaymentState('Pending')).toBe(false);
  });
});

describe('Product publication state machine (SRS §11.3)', () => {
  it('follows publish/unpublish/suspend/archive rules', () => {
    expect(canProductTransition('draft', 'published')).toBe(true);
    expect(canProductTransition('published', 'unpublished')).toBe(true);
    expect(canProductTransition('published', 'suspended')).toBe(true);
    expect(canProductTransition('suspended', 'published')).toBe(true);
    expect(canProductTransition('draft', 'suspended')).toBe(false);
    expect(canProductTransition('archived', 'published')).toBe(false);
    expect(canProductTransition('published', 'archived')).toBe(false); // must unpublish first
    expect(canProductTransition('unpublished', 'archived')).toBe(true);
  });

  it('only published products are orderable (BR-08)', () => {
    expect(isOrderable('published')).toBe(true);
    expect(isOrderable('draft')).toBe(false);
    expect(isOrderable('unpublished')).toBe(false);
    expect(isOrderable('suspended')).toBe(false);
    expect(isOrderable('archived')).toBe(false);
  });
});

describe('Order money arithmetic (SRS Appendix A)', () => {
  it('computes line subtotals', () => {
    expect(lineSubtotal(3, 15000)).toBe(45000);
    expect(() => lineSubtotal(0, 100)).toThrow();
    expect(() => lineSubtotal(1, -5)).toThrow();
    expect(() => lineSubtotal(1.5, 100)).toThrow();
  });

  it('computes order totals: subtotal + delivery - discount', () => {
    const totals = computeTotals({ lineSubtotals: [15000, 8500], deliveryFee: 2000, discount: 500 });
    expect(totals.subtotal).toBe(23500);
    expect(totals.total).toBe(25000);
    expect(orderTotal({ lineSubtotals: [100], deliveryFee: 0, discount: 0 })).toBe(100);
    expect(() => orderTotal({ lineSubtotals: [100], deliveryFee: 0, discount: 500 })).toThrow();
  });
});
