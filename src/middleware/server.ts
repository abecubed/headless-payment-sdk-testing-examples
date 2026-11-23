import http, { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';

export type Decision = 'ACCEPT' | 'REJECT' | 'ERROR';

export interface AuthorizeRequest {
  sessionId: string;
  paymentToken: string;
  amountCents: number;
  currency: string;
  merchantReferenceCode: string;
  sdkVersion?: string;
}

export interface CaptureRequest {
  authCode: string;
  amountCents: number;
  currency?: string;
  merchantReferenceCode?: string;
}

export interface VoidRequest {
  authCode: string;
  merchantReferenceCode?: string;
}

export interface GatewayResponse {
  requestId: string;
  decision: Decision;
  reasonCode: string;
  authCode?: string;
  maskedPan?: string;
  token?: string;
  sessionId?: string;
  gatewayVersion: string;
  errorMessage?: string;
}

interface IdempotencyRecord {
  payloadHash: string;
  statusCode: number;
  body: GatewayResponse;
}

interface TransactionRecord {
  authCode: string;
  amountCents: number;
  currency: string;
  maskedPan: string;
  isCaptured: boolean;
  isVoided: boolean;
  capturedAmountCents?: number;
}

export const DEFAULT_MOCK_ESKEY = 'esk_test_mock_key_01';

export class PseudoPaymentMiddleware {
  private server: http.Server;
  private sessions = new Set<string>();
  private tokens = new Map<string, { maskedPan: string; declineReason?: string }>();
  private idempotencyStore = new Map<string, IdempotencyRecord>();
  private authorizedTransactions = new Map<string, TransactionRecord>();
  public forceTransientFailuresRemaining = 0;
  public expectedEsKey = DEFAULT_MOCK_ESKEY;

  constructor() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  public async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  public resetState(): void {
    this.sessions.clear();
    this.tokens.clear();
    this.idempotencyStore.clear();
    this.authorizedTransactions.clear();
    this.forceTransientFailuresRemaining = 0;
    this.expectedEsKey = DEFAULT_MOCK_ESKEY;
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  /**
   * Unified in-memory dispatcher.
   * Can be invoked directly by tests/agents without TCP overhead, or by handleRequest for live HTTP.
   */
  public async dispatch(
    method: string,
    url: string,
    headers: Record<string, string | string[] | undefined>,
    body: Record<string, unknown> = {}
  ): Promise<{ status: number; payload: GatewayResponse }> {
    // 1. Transient failure injection (502 Bad Gateway)
    if (this.forceTransientFailuresRemaining > 0) {
      this.forceTransientFailuresRemaining--;
      return {
        status: 502,
        payload: {
          requestId: crypto.randomUUID(),
          decision: 'ERROR',
          reasonCode: '150', // Gateway / Switch Temporarily Unavailable
          gatewayVersion: '2.4.0',
        },
      };
    }

    // 2. Normalize headers
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') normalizedHeaders[k.toLowerCase()] = v;
      else if (Array.isArray(v) && v[0]) normalizedHeaders[k.toLowerCase()] = v[0];
    }

    // 3. FreedomPay ESKey authentication validation
    const incomingEsKey = normalizedHeaders['x-eskey'];
    if (!incomingEsKey || incomingEsKey !== this.expectedEsKey) {
      return {
        status: 401,
        payload: {
          requestId: crypto.randomUUID(),
          decision: 'ERROR',
          reasonCode: '101', // Missing/Invalid Security Credential
          errorMessage: 'Invalid or missing Enhanced Security Key (ESKey)',
          gatewayVersion: '2.4.0',
        },
      };
    }

    try {
      // Endpoint: /freeway/init-session
      if (method === 'POST' && url === '/freeway/init-session') {
        const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
        this.sessions.add(sessionId);
        return {
          status: 200,
          payload: {
            requestId: crypto.randomUUID(),
            decision: 'ACCEPT',
            reasonCode: '100',
            sessionId,
            gatewayVersion: '2.4.0',
          },
        };
      }

      // Endpoint: /freeway/tokenize
      if (method === 'POST' && url === '/freeway/tokenize') {
        const { sessionId, pan } = body as { sessionId?: string; pan?: string };
        if (!sessionId || !this.sessions.has(sessionId)) {
          return {
            status: 401,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '401',
              errorMessage: 'Active session not found or expired',
              gatewayVersion: '2.4.0',
            },
          };
        }
        if (!pan || pan.length < 13) {
          return {
            status: 400,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '201',
              errorMessage: 'Malformed card number',
              gatewayVersion: '2.4.0',
            },
          };
        }

        let declineReason: string | undefined;
        if (pan.endsWith('0002')) declineReason = '203'; // Do Not Honor
        else if (pan.endsWith('0004')) declineReason = '204'; // Insufficient Funds
        else if (pan.endsWith('0005')) declineReason = '202'; // Expired Card

        const token = `tok_${crypto.randomBytes(10).toString('hex')}`;
        const maskedPan = `${'*'.repeat(pan.length - 4)}${pan.slice(-4)}`;
        this.tokens.set(token, { maskedPan, declineReason });

        return {
          status: 200,
          payload: {
            requestId: crypto.randomUUID(),
            decision: 'ACCEPT',
            reasonCode: '100',
            token,
            maskedPan,
            gatewayVersion: '2.4.0',
          },
        };
      }

      // Endpoint: /freeway/authorize
      if (method === 'POST' && url === '/freeway/authorize') {
        const idempotencyKey = normalizedHeaders['idempotency-key'];
        if (!idempotencyKey) {
          return {
            status: 400,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'ERROR',
              reasonCode: '102',
              errorMessage: 'Missing required Idempotency-Key header',
              gatewayVersion: '2.4.0',
            },
          };
        }

        const payloadHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const existing = this.idempotencyStore.get(idempotencyKey);
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            return {
              status: 409,
              payload: {
                requestId: crypto.randomUUID(),
                decision: 'ERROR',
                reasonCode: '409',
                errorMessage: 'Idempotency conflict: payload mismatch for existing key',
                gatewayVersion: '2.4.0',
              },
            };
          }
          return { status: existing.statusCode, payload: existing.body };
        }

        const authReq = body as unknown as AuthorizeRequest;
        const tokenData = this.tokens.get(authReq.paymentToken);
        if (!tokenData || !this.sessions.has(authReq.sessionId)) {
          return {
            status: 401,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '401',
              gatewayVersion: '2.4.0',
            },
          };
        }

        if (tokenData.declineReason) {
          const declinePayload: GatewayResponse = {
            requestId: crypto.randomUUID(),
            decision: 'REJECT',
            reasonCode: tokenData.declineReason,
            maskedPan: tokenData.maskedPan,
            gatewayVersion: '2.4.0',
          };
          this.idempotencyStore.set(idempotencyKey, {
            payloadHash,
            statusCode: 402,
            body: declinePayload,
          });
          return { status: 402, payload: declinePayload };
        }

        const authCode = `AUTH${crypto.randomInt(100000, 999999)}`;
        const approvePayload: GatewayResponse = {
          requestId: crypto.randomUUID(),
          decision: 'ACCEPT',
          reasonCode: '100',
          authCode,
          maskedPan: tokenData.maskedPan,
          gatewayVersion: '2.4.0',
        };

        this.authorizedTransactions.set(authCode, {
          authCode,
          amountCents: authReq.amountCents,
          currency: authReq.currency,
          maskedPan: tokenData.maskedPan,
          isCaptured: false,
          isVoided: false,
        });

        this.idempotencyStore.set(idempotencyKey, {
          payloadHash,
          statusCode: 200,
          body: approvePayload,
        });
        return { status: 200, payload: approvePayload };
      }

      // Endpoint: /freeway/capture
      if (method === 'POST' && url === '/freeway/capture') {
        const idempotencyKey = normalizedHeaders['idempotency-key'];
        if (!idempotencyKey) {
          return {
            status: 400,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'ERROR',
              reasonCode: '102',
              errorMessage: 'Missing required Idempotency-Key header',
              gatewayVersion: '2.4.0',
            },
          };
        }

        const payloadHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const existing = this.idempotencyStore.get(idempotencyKey);
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            return {
              status: 409,
              payload: {
                requestId: crypto.randomUUID(),
                decision: 'ERROR',
                reasonCode: '409',
                errorMessage: 'Idempotency conflict: payload mismatch for existing key',
                gatewayVersion: '2.4.0',
              },
            };
          }
          return { status: existing.statusCode, payload: existing.body };
        }

        const captureReq = body as unknown as CaptureRequest;
        const record = this.authorizedTransactions.get(captureReq.authCode);

        if (!record) {
          return {
            status: 404,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'ERROR',
              reasonCode: '102',
              errorMessage: 'Authorization record not found',
              gatewayVersion: '2.4.0',
            },
          };
        }

        if (record.isVoided) {
          return {
            status: 409,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '240',
              errorMessage: 'Transaction has been voided and cannot be captured',
              gatewayVersion: '2.4.0',
            },
          };
        }

        if (record.isCaptured) {
          return {
            status: 409,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '241',
              errorMessage: 'Transaction has already been captured and settled',
              gatewayVersion: '2.4.0',
            },
          };
        }

        if (captureReq.amountCents > record.amountCents) {
          return {
            status: 400,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '102',
              errorMessage: 'Capture amount exceeds authorized hold amount',
              gatewayVersion: '2.4.0',
            },
          };
        }

        record.isCaptured = true;
        record.capturedAmountCents = captureReq.amountCents;

        const capturePayload: GatewayResponse = {
          requestId: crypto.randomUUID(),
          decision: 'ACCEPT',
          reasonCode: '100',
          authCode: record.authCode,
          maskedPan: record.maskedPan,
          gatewayVersion: '2.4.0',
        };

        this.idempotencyStore.set(idempotencyKey, {
          payloadHash,
          statusCode: 200,
          body: capturePayload,
        });
        return { status: 200, payload: capturePayload };
      }

      // Endpoint: /freeway/void
      if (method === 'POST' && url === '/freeway/void') {
        const idempotencyKey = normalizedHeaders['idempotency-key'];
        if (!idempotencyKey) {
          return {
            status: 400,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'ERROR',
              reasonCode: '102',
              errorMessage: 'Missing required Idempotency-Key header',
              gatewayVersion: '2.4.0',
            },
          };
        }

        const payloadHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const existing = this.idempotencyStore.get(idempotencyKey);
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            return {
              status: 409,
              payload: {
                requestId: crypto.randomUUID(),
                decision: 'ERROR',
                reasonCode: '409',
                errorMessage: 'Idempotency conflict: payload mismatch for existing key',
                gatewayVersion: '2.4.0',
              },
            };
          }
          return { status: existing.statusCode, payload: existing.body };
        }

        const voidReq = body as unknown as VoidRequest;
        const record = this.authorizedTransactions.get(voidReq.authCode);

        if (!record) {
          return {
            status: 404,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'ERROR',
              reasonCode: '102',
              errorMessage: 'Authorization record not found',
              gatewayVersion: '2.4.0',
            },
          };
        }

        if (record.isCaptured) {
          return {
            status: 409,
            payload: {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '242',
              errorMessage: 'Transaction has already been captured; use refund/credit service',
              gatewayVersion: '2.4.0',
            },
          };
        }

        record.isVoided = true;

        const voidPayload: GatewayResponse = {
          requestId: crypto.randomUUID(),
          decision: 'ACCEPT',
          reasonCode: '100',
          authCode: record.authCode,
          maskedPan: record.maskedPan,
          gatewayVersion: '2.4.0',
        };

        this.idempotencyStore.set(idempotencyKey, {
          payloadHash,
          statusCode: 200,
          body: voidPayload,
        });
        return { status: 200, payload: voidPayload };
      }

      return {
        status: 404,
        payload: { requestId: crypto.randomUUID(), decision: 'ERROR', reasonCode: '404', gatewayVersion: '2.4.0' },
      };
    } catch {
      return {
        status: 400,
        payload: { requestId: crypto.randomUUID(), decision: 'ERROR', reasonCode: '101', gatewayVersion: '2.4.0' },
      };
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const result = await this.dispatch(
      req.method ?? 'POST',
      req.url ?? '',
      req.headers,
      body
    );
    this.sendJson(res, result.status, result.payload);
  }
}
