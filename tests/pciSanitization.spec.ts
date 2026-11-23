import { test, expect, TEST_CARDS } from './fixtures/paymentFixtures.js';

const RAW_PAN_REGEX = /\b(?:\d[ -]*?){13,16}\b/;

test.describe('PCI-DSS Req 3.4 Log & Error Hygiene', () => {
  test('redacts raw PAN and CVV from SDK error logs when client-side Luhn check fails', async ({ sdk, logs }) => {
    await sdk.initializeSession();

    const result = await sdk.tokenizeCard(TEST_CARDS.INVALID_LUHN, TEST_CARDS.DEFAULT_CVV);
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
    await sdk.initializeSession();

    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    expect(tokenRes.ok).toBe(true);
    expect(tokenRes.data?.maskedPan).toBe('************1111');
    expect(JSON.stringify(tokenRes)).not.toContain(TEST_CARDS.VISA_APPROVE);

    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 1250, 'ORD-2001');
    expect(authRes.ok).toBe(true);
    expect(authRes.data?.maskedPan).toBe('************1111');
    expect(JSON.stringify(authRes)).not.toContain(TEST_CARDS.VISA_APPROVE);
  });
});