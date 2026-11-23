import { test, expect, TEST_CARDS } from './fixtures/paymentFixtures.ts';
import { z } from 'zod';

const GatewayResponseSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(['ACCEPT', 'REJECT', 'ERROR']),
  reasonCode: z.string(),
  authCode: z.string().regex(/^AUTH\d{6}$/).optional(),
  maskedPan: z.string().regex(/^\*{9,12}\d{4}$/).optional(),
  token: z.string().regex(/^tok_[a-f0-9]{20}$/).optional(),
  sessionId: z.string().regex(/^sess_[a-f0-9]{16}$/).optional(),
  gatewayVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  errorMessage: z.string().optional(),
});

const AuthorizeRequestSchema = z.object({
  sessionId: z.string(),
  paymentToken: z.string(),
  amountCents: z.number().int().positive(),
  currency: z.literal('USD'),
  merchantReferenceCode: z.string().min(1),
  sdkVersion: z.string().optional(),
});

test.describe('L1 Contract Governance & Schema Integrity', () => {
  test('validates gateway init-session response adheres strictly to schema', async ({ sdk }) => {
    // 1. Arrange: Prepare client SDK wrapper

    // 2. Act: Request session initialization from gateway
    const res = await sdk.initializeSession();

    // 3. Assert: Operation succeeded and response matches schema bounds
    expect(res.ok).toBe(true);
    const parsed = GatewayResponseSchema.parse(res.data);
    expect(parsed.decision).toBe('ACCEPT');
    expect(parsed.reasonCode).toBe('100');
    expect(parsed.sessionId).toBeDefined();
  });

  test('validates gateway tokenization response matches token and masked PAN schema', async ({ sdk }) => {
    // 1. Arrange: Initialize active session
    await sdk.initializeSession();

    // 2. Act: Tokenize synthetic approved card
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);

    // 3. Assert: Token and masked PAN conform strictly to schema
    expect(tokenRes.ok).toBe(true);
    const parsed = GatewayResponseSchema.parse(tokenRes.data);
    expect(parsed.token).toMatch(/^tok_[a-f0-9]{20}$/);
    expect(parsed.maskedPan).toBe('************1111');
  });

  test('validates approved authorization payload contains valid authCode and schema fields', async ({ sdk }) => {
    // 1. Arrange: Session and tokenized approved card
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);

    // 2. Act: Authorize transaction
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 3500, 'ORD-3001');

    // 3. Assert: Response is approved and satisfies schema
    expect(authRes.ok).toBe(true);
    const parsed = GatewayResponseSchema.parse(authRes.data);
    expect(parsed.decision).toBe('ACCEPT');
    expect(parsed.reasonCode).toBe('100');
    expect(parsed.authCode).toMatch(/^AUTH\d{6}$/);
  });

  test('validates declined authorization payload matches reject schema and reason code 203 (Do Not Honor)', async ({ sdk }) => {
    // 1. Arrange: Tokenize decline card (Do Not Honor)
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_DECLINE_DO_NOT_HONOR, TEST_CARDS.DEFAULT_CVV);

    // 2. Act: Attempt authorization
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 3500, 'ORD-3002');

    // 3. Assert: Envelope matches schema with REJECT decision and 203 reason code
    expect(authRes.ok).toBe(false);
    const parsed = GatewayResponseSchema.parse(authRes.data);
    expect(parsed.decision).toBe('REJECT');
    expect(parsed.reasonCode).toBe('203');
  });

  test('validates declined authorization payload matches reject schema and reason code 204 (Insufficient Funds)', async ({ sdk }) => {
    // 1. Arrange: Tokenize synthetic card configured for insufficient funds
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_DECLINE_INSUFFICIENT_FUNDS, TEST_CARDS.DEFAULT_CVV);

    // 2. Act: Attempt authorization
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 12000, 'ORD-3003');

    // 3. Assert: Envelope returns REJECT with 204 reason code
    expect(authRes.ok).toBe(false);
    const parsed = GatewayResponseSchema.parse(authRes.data);
    expect(parsed.decision).toBe('REJECT');
    expect(parsed.reasonCode).toBe('204');
  });

  test('validates declined authorization payload matches reject schema and reason code 202 (Expired Card)', async ({ sdk }) => {
    // 1. Arrange: Tokenize synthetic card configured for expired card
    await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_DECLINE_EXPIRED, TEST_CARDS.DEFAULT_CVV);

    // 2. Act: Attempt authorization
    const authRes = await sdk.authorizePayment(tokenRes.data!.token!, 5000, 'ORD-3004');

    // 3. Assert: Envelope returns REJECT with 202 reason code
    expect(authRes.ok).toBe(false);
    const parsed = GatewayResponseSchema.parse(authRes.data);
    expect(parsed.decision).toBe('REJECT');
    expect(parsed.reasonCode).toBe('202');
  });

  test('rejects request with 401 and reasonCode 101 when ESKey is missing or invalid', async ({ sdk }) => {
    // 1. Arrange: Tamper with client ESKey to simulate missing or bad credential
    sdk.setEsKey('esk_invalid_or_expired_key');

    // 2. Act: Attempt to initialize session
    const res = await sdk.initializeSession();

    // 3. Assert: Gateway rejects unauthenticated request with reason code 101
    expect(res.ok).toBe(false);
    expect(res.decision).toBe('ERROR');
    expect(res.reasonCode).toBe('101');
    expect(res.errorMessage).toBe('Invalid or missing Enhanced Security Key (ESKey)');
  });

  test('detects breaking contract drift when gateway payload introduces schema violations', () => {
    // 1. Arrange: Fabricate drifted gateway payload (invalid UUID, bad enum, number reason code)
    const driftedPayload = {
      requestId: 'not-a-valid-uuid',
      decision: 'UNKNOWN_DECISION_ENUM',
      reasonCode: 100,
      gatewayVersion: '2.4.0',
    };

    // 2. Act: Parse against contract schema
    const result = GatewayResponseSchema.safeParse(driftedPayload);

    // 3. Assert: Validation fails and flags the exact drifting fields
    expect(result.success).toBe(false);
    const issuePaths = result.error?.issues.map((i) => i.path[0]) ?? [];
    expect(issuePaths).toContain('requestId');
    expect(issuePaths).toContain('decision');
    expect(issuePaths).toContain('reasonCode');
  });

  test('enforces client-side authorization request contract rules', () => {
    // 1. Arrange: Prepare valid client request payload and invalid negative amount payload
    const validPayload = {
      sessionId: 'sess_1234567890abcdef',
      paymentToken: 'tok_1234567890abcdef1234',
      amountCents: 4500,
      currency: 'USD' as const,
      merchantReferenceCode: 'ORD-9999',
      sdkVersion: '1.0.0',
    };
    const invalidAmountPayload = { ...validPayload, amountCents: -50 };

    // 2. Act: Parse payloads through Zod contract schema
    const validResult = AuthorizeRequestSchema.safeParse(validPayload);
    const invalidResult = AuthorizeRequestSchema.safeParse(invalidAmountPayload);

    // 3. Assert: Valid payload succeeds and negative amount is rejected
    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
  });
});
