import { test, expect, TEST_CARDS } from './fixtures/paymentFixtures.ts';

test.describe('L4 Host App Lifecycle & Stability', () => {
  test('safely rejects payment requests when host app is in background state', async ({ sdk }) => {
    // 1. Arrange: Host app enters background state (e.g., user switches apps)
    sdk.onHostAppBackgrounded();

    // 2. Act: Attempt to initialize session while backgrounded
    const initRes = await sdk.initializeSession();

    // 3. Assert: Request rejected with typed error envelope without crashing host app
    expect(initRes.ok).toBe(false);
    expect(initRes.decision).toBe('ERROR');
    expect(initRes.reasonCode).toBe('SDK_BACKGROUNDED');
    expect(initRes.errorMessage).toBe('Cannot initialize while host app is backgrounded');
  });

  test('resumes normal operation after host app returns to foreground', async ({ sdk }) => {
    // 1. Arrange: Transition host app through background and back to foreground
    sdk.onHostAppBackgrounded();
    sdk.onHostAppForegrounded();

    // 2. Act: Initialize fresh session and tokenize card
    const initRes = await sdk.initializeSession();
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);

    // 3. Assert: Both operations succeed normally
    expect(initRes.ok).toBe(true);
    expect(initRes.decision).toBe('ACCEPT');
    expect(initRes.data?.sessionId).toBeDefined();
    expect(tokenRes.ok).toBe(true);
  });

  test('returns typed error envelopes without uncaught exceptions on missing session', async ({ sdk }) => {
    // 1. Arrange: No session initialized

    // 2. Act: Attempt tokenization directly
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);

    // 3. Assert: Returns typed error boundary rejection instead of throwing unhandled exception
    expect(tokenRes.ok).toBe(false);
    expect(tokenRes.decision).toBe('REJECT');
    expect(tokenRes.reasonCode).toBe('NO_ACTIVE_SESSION');
    expect(tokenRes.errorMessage).toBe('Session not initialized');
  });

  test('clears active session token on backgrounding to prevent stale token reuse', async ({ sdk }) => {
    // 1. Arrange: Initialize an active session
    const initRes = await sdk.initializeSession();
    expect(initRes.ok).toBe(true);

    // 2. Act: OS backgrounds the host app
    sdk.onHostAppBackgrounded();

    // 3. Assert: Stored session is invalidated; subsequent tokenization fails
    const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
    expect(tokenRes.ok).toBe(false);
    expect(tokenRes.reasonCode).toBe('NO_ACTIVE_SESSION');
  });
});
