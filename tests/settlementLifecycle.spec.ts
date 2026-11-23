import { test, expect, TEST_CARDS } from './fixtures/paymentFixtures.ts';

test.describe('Settlement Lifecycle: Capture & Void (FreeWay ccCaptureService / voidService)', () => {
  test('captures full authorization amount successfully on approved transaction', async ({ sdk }) => {
    // 1. Arrange: Initialize session, tokenize card, and obtain an approved authorization
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 5000, 'ORD-5001');
    expect(authRes.ok).toBe(true);
    const authCode = authRes.data!.authCode!;

    // 2. Act: Capture the full $50.00 authorization
    const captureRes = await sdk.capturePayment(authCode, 5000);

    // 3. Assert: Gateway confirms capture settlement
    expect(captureRes.ok).toBe(true);
    expect(captureRes.decision).toBe('ACCEPT');
    expect(captureRes.reasonCode).toBe('100');
    expect(captureRes.data?.authCode).toBe(authCode);
  });

  test('captures partial authorization amount successfully for adjusted balances', async ({ sdk }) => {
    // 1. Arrange: Authorize hold for $100.00
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 10000, 'ORD-5002');
    expect(authRes.ok).toBe(true);
    const authCode = authRes.data!.authCode!;

    // 2. Act: Settle partial amount of $75.00 (e.g., hospitality lodging adjustment)
    const captureRes = await sdk.capturePayment(authCode, 7500);

    // 3. Assert: Capture succeeds for the partial amount
    expect(captureRes.ok).toBe(true);
    expect(captureRes.decision).toBe('ACCEPT');
    expect(captureRes.reasonCode).toBe('100');
  });

  test('rejects capture attempt when requested amount exceeds authorized hold', async ({ sdk }) => {
    // 1. Arrange: Authorize hold for $40.00
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 4000, 'ORD-5003');
    expect(authRes.ok).toBe(true);
    const authCode = authRes.data!.authCode!;

    // 2. Act: Attempt to capture $60.00 (exceeding $40.00 hold)
    const captureRes = await sdk.capturePayment(authCode, 6000);

    // 3. Assert: Rejected with reason code 102 (invalid amount)
    expect(captureRes.ok).toBe(false);
    expect(captureRes.decision).toBe('REJECT');
    expect(captureRes.reasonCode).toBe('102');
  });

  test('rejects double-capture attempt on already settled transaction', async ({ sdk }) => {
    // 1. Arrange: Authorize and complete initial capture for $30.00
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 3000, 'ORD-5004');
    expect(authRes.ok).toBe(true);
    const authCode = authRes.data!.authCode!;

    const firstCapture = await sdk.capturePayment(authCode, 3000);
    expect(firstCapture.ok).toBe(true);

    // 2. Act: Attempt to capture the same authorization a second time
    const secondCapture = await sdk.capturePayment(authCode, 3000);

    // 3. Assert: Rejected with 241 (already captured)
    expect(secondCapture.ok).toBe(false);
    expect(secondCapture.decision).toBe('REJECT');
    expect(secondCapture.reasonCode).toBe('241');
  });

  test('voids active authorization successfully before capture to release hold', async ({ sdk }) => {
    // 1. Arrange: Authorize transaction hold
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 8500, 'ORD-5005');
    expect(authRes.ok).toBe(true);
    const authCode = authRes.data!.authCode!;

    // 2. Act: Void authorization before batch settlement
    const voidRes = await sdk.voidPayment(authCode);

    // 3. Assert: Void accepted and authorization cancelled
    expect(voidRes.ok).toBe(true);
    expect(voidRes.decision).toBe('ACCEPT');
    expect(voidRes.reasonCode).toBe('100');
  });

  test('rejects capture attempt against an authorization that was previously voided', async ({ sdk }) => {
    // 1. Arrange: Authorize and then void transaction
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 4500, 'ORD-5006');
    expect(authRes.ok).toBe(true);
    const authCode = authRes.data!.authCode!;

    const voidRes = await sdk.voidPayment(authCode);
    expect(voidRes.ok).toBe(true);

    // 2. Act: Attempt to capture the voided transaction
    const captureRes = await sdk.capturePayment(authCode, 4500);

    // 3. Assert: Rejected with 240 (cannot capture voided transaction)
    expect(captureRes.ok).toBe(false);
    expect(captureRes.decision).toBe('REJECT');
    expect(captureRes.reasonCode).toBe('240');
  });
});
