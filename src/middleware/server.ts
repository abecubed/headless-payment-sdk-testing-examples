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

export interface GatewayResponse {
  requestId: string;
  decision: Decision;
  reasonCode: string;
  authCode?: string;
  maskedPan?: string;
  token?: string;
  sessionId?: string;
  gatewayVersion: string;
}

interface IdempotencyRecord {
  payloadHash: string;
  statusCode: number;
  body: GatewayResponse;
}

export class PseudoPaymentMiddleware {
  private server: http.Server;
  private sessions = new Set<string>();
  private tokens = new Map<string, { maskedPan: string; shouldDecline: boolean }>();
  private idempotencyStore = new Map<string, IdempotencyRecord>();
  public forceTransientFailuresRemaining = 0;

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
    this.forceTransientFailuresRemaining = 0;
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

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';

    if (this.forceTransientFailuresRemaining > 0) {
      this.forceTransientFailuresRemaining--;
      this.sendJson(res, 502, {
        requestId: crypto.randomUUID(),
        decision: 'ERROR',
        reasonCode: '150', // Gateway / Switch Temporarily Unavailable
        gatewayVersion: '2.4.0',
      });
      return;
    }

    try {
      const body = await this.readJson(req);

      if (req.method === 'POST' && url === '/freeway/init-session') {
        const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
        this.sessions.add(sessionId);
        this.sendJson(res, 200, {
          requestId: crypto.randomUUID(),
          decision: 'ACCEPT',
          reasonCode: '100',
          sessionId,
          gatewayVersion: '2.4.0',
        });
        return;
      }

      if (req.method === 'POST' && url === '/freeway/tokenize') {
        const { sessionId, pan } = body as { sessionId?: string; pan?: string };
        if (!sessionId || !this.sessions.has(sessionId)) {
          this.sendJson(res, 401, {
            requestId: crypto.randomUUID(),
            decision: 'REJECT',
            reasonCode: '401',
            gatewayVersion: '2.4.0',
          });
          return;
        }
        if (!pan || pan.length < 13) {
          this.sendJson(res, 400, {
            requestId: crypto.randomUUID(),
            decision: 'REJECT',
            reasonCode: '201',
            gatewayVersion: '2.4.0',
          });
          return;
        }
        const token = `tok_${crypto.randomBytes(10).toString('hex')}`;
        const maskedPan = `${'*'.repeat(pan.length - 4)}${pan.slice(-4)}`;
        this.tokens.set(token, { maskedPan, shouldDecline: pan.endsWith('0002') });

        this.sendJson(res, 200, {
          requestId: crypto.randomUUID(),
          decision: 'ACCEPT',
          reasonCode: '100',
          token,
          maskedPan,
          gatewayVersion: '2.4.0',
        });
        return;
      }

      if (req.method === 'POST' && url === '/freeway/authorize') {
        const idempotencyKey = req.headers['idempotency-key'];
        if (!idempotencyKey || typeof idempotencyKey !== 'string') {
          this.sendJson(res, 400, {
            requestId: crypto.randomUUID(),
            decision: 'ERROR',
            reasonCode: '102',
            gatewayVersion: '2.4.0',
          });
          return;
        }

        const payloadHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const existing = this.idempotencyStore.get(idempotencyKey);
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            this.sendJson(res, 409, {
              requestId: crypto.randomUUID(),
              decision: 'ERROR',
              reasonCode: '409',
              gatewayVersion: '2.4.0',
            });
            return;
          }
          this.sendJson(res, existing.statusCode, existing.body);
          return;
        }

        const authReq = body as unknown as AuthorizeRequest;
        const tokenData = this.tokens.get(authReq.paymentToken);
        if (!tokenData || !this.sessions.has(authReq.sessionId)) {
          this.sendJson(res, 401, {
            requestId: crypto.randomUUID(),
            decision: 'REJECT',
            reasonCode: '401',
            gatewayVersion: '2.4.0',
          });
          return;
        }

        const responsePayload: GatewayResponse = tokenData.shouldDecline
          ? {
              requestId: crypto.randomUUID(),
              decision: 'REJECT',
              reasonCode: '203', // Do Not Honor
              maskedPan: tokenData.maskedPan,
              gatewayVersion: '2.4.0',
            }
          : {
              requestId: crypto.randomUUID(),
              decision: 'ACCEPT',
              reasonCode: '100',
              authCode: `AUTH${crypto.randomInt(100000, 999999)}`,
              maskedPan: tokenData.maskedPan,
              gatewayVersion: '2.4.0',
            };

        const statusCode = tokenData.shouldDecline ? 402 : 200;
        this.idempotencyStore.set(idempotencyKey, { payloadHash, statusCode, body: responsePayload });
        this.sendJson(res, statusCode, responsePayload);
        return;
      }

      this.sendJson(res, 404, { decision: 'ERROR', reasonCode: '404', gatewayVersion: '2.4.0' });
    } catch {
      this.sendJson(res, 400, { decision: 'ERROR', reasonCode: '101', gatewayVersion: '2.4.0' });
    }
  }
}