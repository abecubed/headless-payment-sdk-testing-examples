import { test as base, expect } from '@playwright/test';
import { PseudoPaymentMiddleware, DEFAULT_MOCK_ESKEY } from '../../src/middleware/server.ts';
import { MobilePaymentSdkWrapper } from '../../src/mobile-sdk-wrapper/paymentSdkClient.ts';
import type { SdkLogger } from '../../src/mobile-sdk-wrapper/paymentSdkClient.ts';

export const TEST_CARDS = {
  VISA_APPROVE: '4111111111111111',
  VISA_DECLINE_DO_NOT_HONOR: '4000000000000002',
  VISA_DECLINE_INSUFFICIENT_FUNDS: '4800000000000004',
  VISA_DECLINE_EXPIRED: '4700000000000005',
  INVALID_LUHN: '4111111111111112',
  DEFAULT_CVV: '739',
} as const;

export interface LogCollector extends SdkLogger {
  entries: Array<{ level: 'info' | 'error'; message: string }>;
}

export interface PaymentTestFixtures {
  middleware: PseudoPaymentMiddleware;
  baseUrl: string;
  logs: LogCollector;
  sdk: MobilePaymentSdkWrapper;
}

export const test = base.extend<PaymentTestFixtures>({
  middleware: async ({}, use) => {
    const server = new PseudoPaymentMiddleware();
    await use(server);
    await server.stop();
  },

  baseUrl: async ({ middleware }, use) => {
    const url = await middleware.start();
    await use(url);
  },

  logs: async ({}, use) => {
    const collector: LogCollector = {
      entries: [],
      info(message: string) {
        this.entries.push({ level: 'info', message });
      },
      error(message: string) {
        this.entries.push({ level: 'error', message });
      },
    };
    await use(collector);
  },

  sdk: async ({ middleware, baseUrl, logs }, use) => {
    const inMemoryTransport = (path: string, body: Record<string, unknown>, headers: Record<string, string>) => {
      return middleware.dispatch('POST', path, headers, body);
    };
    const wrapper = new MobilePaymentSdkWrapper(
      baseUrl,
      logs,
      2,
      DEFAULT_MOCK_ESKEY,
      'TERM_PLAYWRIGHT_01',
      inMemoryTransport
    );
    await use(wrapper);
  },
});

export { expect };
