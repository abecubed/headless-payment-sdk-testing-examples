import crypto from 'node:crypto';
import type { Decision, GatewayResponse } from '../middleware/server.js';

export interface SdkResult<T = GatewayResponse> {
  ok: boolean;
  decision: Decision;
  reasonCode: string;
  data?: T;
  errorMessage?: string;
}

export interface SdkLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

export function sanitizeSensitiveData(input: string): string {
  // Masks 13-16 digit card numbers (PANs) and 3-4 digit CVV fields
  return input
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED_PAN]')
    .replace(/("cvv"\s*:\s*")\d{3,4}(")/gi, '$1[REDACTED_CVV]$2');
}

export function isValidLuhn(pan: string): boolean {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 16) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export class MobilePaymentSdkWrapper {
  private sessionId: string | null = null;
  private isBackgrounded = false;

  constructor(
    private readonly baseUrl: string,
    private readonly logger: SdkLogger,
    private readonly maxRetries = 2
  ) {}

  public onHostAppBackgrounded(): void {
    this.isBackgrounded = true;
    this.sessionId = null;
    this.log('info', 'Host app backgrounded; active payment session cleared.');
  }

  public onHostAppForegrounded(): void {
    this.isBackgrounded = false;
    this.log('info', 'Host app foregrounded; ready for session initialization.');
  }

  private log(level: 'info' | 'error', rawMessage: string): void {
    this.logger[level](sanitizeSensitiveData(rawMessage));
  }

  private async postWithRetry(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<{ status: number; payload: GatewayResponse }> {
    let attempt = 0;
    while (true) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

        const response = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        const payload = (await response.json()) as GatewayResponse;
        if (response.status >= 500 && attempt < this.maxRetries) {
          attempt++;
          this.log('info', `Transient gateway status ${response.status} on ${path}; retrying (${attempt}/${this.maxRetries})`);
          continue;
        }
        return { status: response.status, payload };
      } catch (err) {
        if (attempt < this.maxRetries) {
          attempt++;
          this.log('info', `Network exception on ${path}; retrying (${attempt}/${this.maxRetries})`);
          continue;
        }
        throw err;
      }
    }
  }

  public async initializeSession(): Promise<SdkResult> {
    if (this.isBackgrounded) {
      return {
        ok: false,
        decision: 'ERROR',
        reasonCode: 'SDK_BACKGROUNDED',
        errorMessage: 'Cannot initialize while host app is backgrounded',
      };
    }
    try {
      const { status, payload } = await this.postWithRetry('/freeway/init-session', { sdkVersion: '1.0.0' });
      if (status === 200 && payload.sessionId) {
        this.sessionId = payload.sessionId;
        return { ok: true, decision: payload.decision, reasonCode: payload.reasonCode, data: payload };
      }
      return { ok: false, decision: payload.decision, reasonCode: payload.reasonCode };
    } catch (err) {
      const msg = sanitizeSensitiveData(err instanceof Error ? err.message : String(err));
      this.log('error', `Session initialization failed: ${msg}`);
      return { ok: false, decision: 'ERROR', reasonCode: 'NETWORK_ERROR', errorMessage: msg };
    }
  }

  public async tokenizeCard(pan: string, cvv: string): Promise<SdkResult> {
    if (!this.sessionId) {
      return { ok: false, decision: 'REJECT', reasonCode: 'NO_ACTIVE_SESSION', errorMessage: 'Session not initialized' };
    }
    if (!isValidLuhn(pan)) {
      this.log('error', `Rejected invalid card input for payload ${JSON.stringify({ pan, cvv })}`);
      return { ok: false, decision: 'REJECT', reasonCode: 'INVALID_LUHN', errorMessage: 'Card failed client-side Luhn check' };
    }
    try {
      const { status, payload } = await this.postWithRetry('/freeway/tokenize', {
        sessionId: this.sessionId,
        pan,
        cvv,
      });
      return { ok: status === 200, decision: payload.decision, reasonCode: payload.reasonCode, data: payload };
    } catch (err) {
      const msg = sanitizeSensitiveData(err instanceof Error ? err.message : String(err));
      this.log('error', `Tokenization failed for ${JSON.stringify({ pan, cvv })}: ${msg}`);
      return { ok: false, decision: 'ERROR', reasonCode: 'NETWORK_ERROR', errorMessage: msg };
    }
  }

  public async authorizePayment(
    paymentToken: string,
    amountCents: number,
    merchantReferenceCode: string,
    idempotencyKey = crypto.randomUUID()
  ): Promise<SdkResult> {
    if (!this.sessionId) {
      return { ok: false, decision: 'REJECT', reasonCode: 'NO_ACTIVE_SESSION', errorMessage: 'Session not initialized' };
    }
    try {
      const { status, payload } = await this.postWithRetry(
        '/freeway/authorize',
        {
          sessionId: this.sessionId,
          paymentToken,
          amountCents,
          currency: 'USD',
          merchantReferenceCode,
          sdkVersion: '1.0.0',
        },
        idempotencyKey
      );
      return { ok: status === 200, decision: payload.decision, reasonCode: payload.reasonCode, data: payload };
    } catch (err) {
      const msg = sanitizeSensitiveData(err instanceof Error ? err.message : String(err));
      this.log('error', `Authorization failed: ${msg}`);
      return { ok: false, decision: 'ERROR', reasonCode: 'NETWORK_ERROR', errorMessage: msg };
    }
  }
}