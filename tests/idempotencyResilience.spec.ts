import crypto from 'node:crypto';
import { test, expect, TEST_CARDS } from './fixtures/paymentFixtures.js';

test.describe('Idempotency & Mobile Network Drop-Off Resilience', () => {
  test('recovers transparently from transient 502 gateway errors within retry budget', async ({ sdk, middleware }) => {
    const init = await sdk.initializeSession();
    expect(init.ok).toBe(true);

    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    expect(tokenRes.ok).toBe(true);

    middleware.forceTransientFailuresRemaining = 2;

    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 4500, 'ORD-1001');
    expect(authRes.ok).toBe(true);
    expect(authRes.decision).toBe('ACCEPT');
    expect(authRes.reasonCode).toBe('100');
    expect(authRes.data?.authCode).toMatch(/^AUTH\d{6}$/);
  });

  test('returns cached authorization decision when retrying with identical Idempotency-Key', async ({ sdk }) => {
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const idempotencyKey = crypto.randomUUID();

    const firstAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 7999, 'ORD-1002', idempotencyKey);
    const retryAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 7999, 'ORD-1002', idempotencyKey);

    expect(firstAttempt.ok).toBe(true);
    expect(retryAttempt.ok).toBe(true);
    expect(retryAttempt.data?.requestId).toBe(firstAttempt.data?.requestId);
    expect(retryAttempt.data?.authCode).toBe(firstAttempt.data?.authCode);
  });

  test('rejects with 409 Conflict when same Idempotency-Key is reused with a different amount', async ({ sdk }) => {
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const idempotencyKey = crypto.randomUUID();

    const firstAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 2500, 'ORD-1003', idempotencyKey);
    expect(firstAttempt.ok).toBe(true);

    const tamperedRetry = await sdk.authorizePayment(tokenRes.data!.token!, 9900, 'ORD-1003', idempotencyKey);
    expect(tamperedRetry.ok).toBe(false);
    expect(tamperedRetry.reasonCode).toBe('409');
  });
});