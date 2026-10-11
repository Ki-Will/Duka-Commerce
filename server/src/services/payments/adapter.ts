/**
 * Payment provider adapter boundary (FR-PAY-01, SRS §9.4).
 * Phase 1 ships a sandbox/stub adapter; a production MoMo adapter would
 * implement the same interface (OD-02 remains an open decision).
 */
export type CallbackResult = 'success' | 'failure' | 'timeout';

export interface InitiateInput {
  orderId: string;
  orderNumber: string;
  amount: number; // server-computed; never trusted from client (PAY-008)
  customerPhone: string | null;
}

export interface InitiateResult {
  providerRef: string;
  checkoutUrl: string;
  state: 'Pending';
}

export interface CallbackPayload {
  externalEventId: string;
  providerRef: string;
  result: CallbackResult;
  amount: number;
}

export interface PaymentAdapter {
  provider: string;
  initiate(input: InitiateInput): InitiateResult;
  /** Authenticate an inbound callback; throws when the signature is invalid. */
  verifySignature(rawBody: string, signature: string | undefined): boolean;
  sign(rawBody: string): string;
}
