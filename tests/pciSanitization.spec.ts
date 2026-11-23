import { test, expect, TEST_CARDS } from './fixtures/paymentFixtures.ts';

const RAW_PAN_REGEX = /\b(?:\d[ -]*?){13,16}\b/;

test.describe('L3 PCI-DSS Req 3.4 Log & Error Hygiene', () => {
  test('redacts raw PAN and CVV from SDK error logs when client-side Luhn check fails', async ({ sdk, logs }) => {
    // 1. Arrange: Initialize active session
    await sdk.initializeSession();

    // 2. Act: Attempt to tokenize an invalid Luhn test card
    const result = await sdk.tokenizeCard(TEST_CARDS.INVALID_LUHN, TEST_CARDS.DEFAULT_CVV);

    // 3. Assert: Client rejected card pre-gateway and redacted all raw sensitive PAN/CVV data from logs
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('INVALID_LUHN');

    const serializedLogs = JSON.stringify(logs.entries);
    expect(serializedLogs).not.toMatch(RAW_PAN_REGEX);
    expect(serializedLogs).not.toContain(TEST_CARDS.INVALID_LUHN);
    expect(serializedLogs).not.toContain(TEST_CARDS.DEFAULT_CVV);
    expect(serializedLogs).toContain('[REDACTED_PAN]');
    expect(serializedLogs).toContain('[REDACTED_CVV]');
  });

  test('returns only masked PANs in gateway tokenization and authorization responses', async ({ sdk }) => {
    // 1. Arrange: Initialize active session
    await sdk.initializeSession();

    // 2. Act: Tokenize synthetic card and authorize payment
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    expect(tokenRes.ok).toBe(true);

    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 1250, 'ORD-2001');
    expect(authRes.ok).toBe(true);

    // 3. Assert: Returned payloads contain only masked PANs (never raw card numbers)
    expect(tokenRes.data?.maskedPan).toBe('************1111');
    expect(JSON.stringify(tokenRes)).not.toContain(TEST_CARDS.VISA_APPROVE);

    expect(authRes.data?.maskedPan).toBe('************1111');
    expect(JSON.stringify(authRes)).not.toContain(TEST_CARDS.VISA_APPROVE);
  });
});
