/**
 * Monetary amounts are stored as exact integers in the currency's smallest
 * unit (RWF has no subdivision in Phase 1, so values are whole francs).
 * All order arithmetic happens server-side (FR-CART-05, Appendix A).
 */
export interface OrderTotalsInput {
  lineSubtotals: number[]; // quantity * unitPriceSnapshot per line
  deliveryFee: number;
  discount: number;
  tax?: number;
}

export function assertAmount(value: number, label = 'amount'): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer amount`);
  }
}

export function lineSubtotal(quantity: number, unitPrice: number): number {
  assertAmount(unitPrice, 'unitPrice');
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('quantity must be a positive integer');
  }
  return quantity * unitPrice;
}

/** orderTotal = orderSubtotal + deliveryFee + applicableTax - discount (Appendix A) */
export function orderTotal(input: OrderTotalsInput): number {
  const subtotal = input.lineSubtotals.reduce((a, b) => a + b, 0);
  const total = subtotal + input.deliveryFee + (input.tax ?? 0) - input.discount;
  if (total < 0) throw new Error('order total cannot be negative');
  return total;
}

export function computeTotals(input: OrderTotalsInput) {
  const subtotal = input.lineSubtotals.reduce((a, b) => a + b, 0);
  const total = orderTotal(input);
  return { subtotal, deliveryFee: input.deliveryFee, discount: input.discount, total };
}

export function formatRwf(amount: number): string {
  return `${amount.toLocaleString('en-US')} RWF`;
}
