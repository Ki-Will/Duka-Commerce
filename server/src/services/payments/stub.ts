import { createHmac, randomUUID } from 'node:crypto';
import type { AppCtx } from '../../context.js';
import type { CallbackPayload, InitiateInput, InitiateResult, PaymentAdapter } from './adapter.js';

/** Sandbox mobile-money adapter (Inception §2.3: sandbox/stub first). */
export class StubMomoAdapter implements PaymentAdapter {
  provider = 'momo';

  constructor(private secret: string) {}

  initiate(input: InitiateInput): InitiateResult {
    const providerRef = `MOMO-STUB-${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      providerRef,
      checkoutUrl: `https://sandbox.momo.example/pay/${providerRef}?amount=${input.amount}`,
      state: 'Pending'
    };
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  verifySignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = this.sign(rawBody);
    if (signature.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < signature.length; i++) mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    return mismatch === 0;
  }

  /** Build the callback payload the provider would POST (used by the sandbox simulator). */
  buildCallback(paymentId: string, providerRef: string, amount: number, result: CallbackResult2): CallbackPayload {
    return {
      externalEventId: `EVT-${randomUUID()}`,
      providerRef,
      result,
      amount
    };
  }
}

type CallbackResult2 = 'success' | 'failure' | 'timeout';

export function getAdapter(ctx: AppCtx): PaymentAdapter {
  return new StubMomoAdapter(ctx.config.webhookSecret);
}
