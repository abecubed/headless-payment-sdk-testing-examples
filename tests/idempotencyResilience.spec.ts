import crypto from 'node:crypto';
import { test, expect, TEST_CARDS } from './fixtures/paymentFixtures.ts';

test.describe('L2 Network Resilience & Idempotency', () => {
  test('recovers transparently from transient 502 gateway errors within retry budget', async ({ sdk, middleware }) => {
    // 1. Arrange: Initialize session, tokenize card, and inject 2 transient gateway failures
    const init = await sdk.initializeSession();
    expect(init.ok).toBe(true);

    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    expect(tokenRes.ok).toBe(true);

    middleware.forceTransientFailuresRemaining = 2;

    // 2. Act: Authorize payment (SDK wrapper automatically retries across 502s)
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 4500, 'ORD-1001');

    // 3. Assert: Payment successfully completes once transient failures clear
    expect(authRes.ok).toBe(true);
    expect(authRes.decision).toBe('ACCEPT');
    expect(authRes.reasonCode).toBe('100');
    expect(authRes.data?.authCode).toMatch(/^AUTH\d{6}$/);
  });

  test('returns cached authorization decision when retrying with identical Idempotency-Key', async ({ sdk }) => {
    // 1. Arrange: Initialize session, tokenize card, and generate a client Idempotency-Key
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const idempotencyKey = crypto.randomUUID();

    // 2. Act: Send first authorization followed by an identical retry attempt
    const firstAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 7999, 'ORD-1002', idempotencyKey);
    const retryAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 7999, 'ORD-1002', idempotencyKey);

    // 3. Assert: Both requests succeed and return identical transaction records without double-charging
    expect(firstAttempt.ok).toBe(true);
    expect(retryAttempt.ok).toBe(true);
    expect(retryAttempt.data?.requestId).toBe(firstAttempt.data?.requestId);
    expect(retryAttempt.data?.authCode).toBe(firstAttempt.data?.authCode);
  });

  test('rejects with 409 Conflict when same Idempotency-Key is reused with a different amount', async ({ sdk }) => {
    // 1. Arrange: Tokenize card and generate an Idempotency-Key
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const idempotencyKey = crypto.randomUUID();

    // 2. Act: Send initial authorization for $25.00 followed by altered replay for $99.00
    const firstAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 2500, 'ORD-1003', idempotencyKey);
    const tamperedRetry = await sdk.authorizePayment(tokenRes.data!.token!, 9900, 'ORD-1003', idempotencyKey);

    // 3. Assert: Initial payment succeeds and tampered replay triggers 409 Conflict
    expect(firstAttempt.ok).toBe(true);
    expect(tamperedRetry.ok).toBe(false);
    expect(tamperedRetry.reasonCode).toBe('409');
  });
});
