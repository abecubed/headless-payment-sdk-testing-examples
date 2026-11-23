import crypto from 'node:crypto';
import { PseudoPaymentMiddleware, DEFAULT_MOCK_ESKEY } from '../middleware/server.ts';
import { MobilePaymentSdkWrapper } from '../mobile-sdk-wrapper/paymentSdkClient.ts';
import type { SdkLogger } from '../mobile-sdk-wrapper/paymentSdkClient.ts';
import { TEST_CARDS } from '../../tests/fixtures/paymentFixtures.ts';

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, string>;
  execute: (args?: any) => Promise<Record<string, unknown>>;
}

export class PaymentAgentEnvironment {
  private middleware: PseudoPaymentMiddleware;
  private sdk!: MobilePaymentSdkWrapper;
  private logs: Array<{ level: 'info' | 'error'; message: string }> = [];
  private baseUrl = '';
  public activeSessionId: string | null = null;
  public lastToken: string | null = null;
  public lastAuthCode: string | null = null;

  constructor() {
    this.middleware = new PseudoPaymentMiddleware();
  }

  public async start(): Promise<void> {
    this.baseUrl = await this.middleware.start();
    const logger: SdkLogger = {
      info: (msg: string) => this.logs.push({ level: 'info', message: msg }),
      error: (msg: string) => this.logs.push({ level: 'error', message: msg }),
    };
    const inMemoryTransport = (path: string, body: Record<string, unknown>, headers: Record<string, string>) => {
      return this.middleware.dispatch('POST', path, headers, body);
    };
    this.sdk = new MobilePaymentSdkWrapper(
      this.baseUrl,
      logger,
      2,
      DEFAULT_MOCK_ESKEY,
      'TERM_AGENTIC_01',
      inMemoryTransport
    );
  }

  public async stop(): Promise<void> {
    await this.middleware.stop();
  }

  public getTools(): Record<string, AgentTool> {
    return {
      initialize_session: {
        name: 'initialize_session',
        description: 'Requests a new session token from the FreeWay gateway',
        parameters: {},
        execute: async () => {
          const res = await this.sdk.initializeSession();
          if (res.ok && res.data?.sessionId) {
            this.activeSessionId = res.data.sessionId;
          }
          return {
            ok: res.ok,
            decision: res.decision,
            reasonCode: res.reasonCode,
            sessionId: this.activeSessionId,
            errorMessage: res.errorMessage,
          };
        },
      },

      tokenize_card: {
        name: 'tokenize_card',
        description: 'Tokenizes a synthetic card through FreeWay token vault',
        parameters: { cardType: 'VISA_APPROVE | VISA_DECLINE_DO_NOT_HONOR | VISA_DECLINE_INSUFFICIENT_FUNDS | VISA_DECLINE_EXPIRED | INVALID_LUHN' },
        execute: async (args: { cardType: keyof typeof TEST_CARDS }) => {
          const cardNum = TEST_CARDS[args.cardType] || TEST_CARDS.VISA_APPROVE;
          const res = await this.sdk.tokenizeCard(cardNum, TEST_CARDS.DEFAULT_CVV);
          if (res.ok && res.data?.token) {
            this.lastToken = res.data.token;
          }
          return {
            ok: res.ok,
            decision: res.decision,
            reasonCode: res.reasonCode,
            token: this.lastToken,
            maskedPan: res.data?.maskedPan,
            errorMessage: res.errorMessage,
          };
        },
      },

      authorize_payment: {
        name: 'authorize_payment',
        description: 'Submits payment authorization with Idempotency-Key tracking',
        parameters: { amountCents: 'number', merchantReferenceCode: 'string', idempotencyKey: 'string (optional)' },
        execute: async (args: { amountCents: number; merchantReferenceCode: string; idempotencyKey?: string }) => {
          if (!this.lastToken) {
            return { ok: false, error: 'Cannot authorize without a prior tokenized card' };
          }
          const key = args.idempotencyKey || crypto.randomUUID();
          const res = await this.sdk.authorizePayment(this.lastToken, args.amountCents, args.merchantReferenceCode, key);
          if (res.ok && res.data?.authCode) {
            this.lastAuthCode = res.data.authCode;
          }
          return {
            ok: res.ok,
            decision: res.decision,
            reasonCode: res.reasonCode,
            authCode: this.lastAuthCode,
            requestId: res.data?.requestId,
            idempotencyKey: key,
          };
        },
      },

      capture_payment: {
        name: 'capture_payment',
        description: 'Captures and settles an authorized hold in the gateway ledger',
        parameters: { amountCents: 'number', authCode: 'string (optional, defaults to last authorized)', idempotencyKey: 'string (optional)' },
        execute: async (args: { amountCents: number; authCode?: string; idempotencyKey?: string }) => {
          const code = args.authCode || this.lastAuthCode;
          if (!code) return { ok: false, error: 'No active authCode available to capture' };
          const res = await this.sdk.capturePayment(code, args.amountCents, args.idempotencyKey);
          return { ok: res.ok, decision: res.decision, reasonCode: res.reasonCode, authCode: code };
        },
      },

      void_payment: {
        name: 'void_payment',
        description: 'Voids an unsettled authorization hold before batch close',
        parameters: { authCode: 'string (optional, defaults to last authorized)', idempotencyKey: 'string (optional)' },
        execute: async (args?: { authCode?: string; idempotencyKey?: string }) => {
          const code = args?.authCode || this.lastAuthCode;
          if (!code) return { ok: false, error: 'No active authCode available to void' };
          const res = await this.sdk.voidPayment(code, args?.idempotencyKey);
          return { ok: res.ok, decision: res.decision, reasonCode: res.reasonCode, authCode: code };
        },
      },

      inject_transient_502: {
        name: 'inject_transient_502',
        description: 'Injects simulated upstream switch drop-off (502 Bad Gateway) errors',
        parameters: { failureCount: 'number (e.g., 1 or 2)' },
        execute: async (args: { failureCount: number }) => {
          this.middleware.forceTransientFailuresRemaining = args.failureCount;
          return { status: 'injected', transientFailuresRemaining: args.failureCount };
        },
      },

      background_host_app: {
        name: 'background_host_app',
        description: 'Simulates host operating system moving app to background, invalidating session',
        parameters: {},
        execute: async () => {
          this.sdk.onHostAppBackgrounded();
          this.activeSessionId = null;
          return { state: 'backgrounded', activeSessionId: null };
        },
      },

      foreground_host_app: {
        name: 'foreground_host_app',
        description: 'Simulates host OS restoring app to foreground',
        parameters: {},
        execute: async () => {
          this.sdk.onHostAppForegrounded();
          return { state: 'foregrounded' };
        },
      },

      tamper_eskey: {
        name: 'tamper_eskey',
        description: 'Simulates an invalid or revoked tenant ESKey credential',
        parameters: { invalidKey: 'string' },
        execute: async (args: { invalidKey: string }) => {
          this.sdk.setEsKey(args.invalidKey);
          return { currentEsKey: args.invalidKey };
        },
      },

      restore_eskey: {
        name: 'restore_eskey',
        description: 'Restores the valid tenant ESKey credential',
        parameters: {},
        execute: async () => {
          this.sdk.setEsKey(DEFAULT_MOCK_ESKEY);
          return { currentEsKey: DEFAULT_MOCK_ESKEY };
        },
      },

      audit_pci_logs: {
        name: 'audit_pci_logs',
        description: 'Scans all internal logger streams for raw 13-16 digit PAN or CVV leaks',
        parameters: {},
        execute: async () => {
          const rawText = JSON.stringify(this.logs);
          const panMatches = rawText.match(/\b(?:\d[ -]*?){13,16}\b/g) || [];
          const hasRedactedPan = rawText.includes('[REDACTED_PAN]');
          return {
            clean: panMatches.length === 0,
            violationsFound: panMatches.length,
            totalLogEntries: this.logs.length,
            redactionActive: hasRedactedPan,
          };
        },
      },
    };
  }
}
