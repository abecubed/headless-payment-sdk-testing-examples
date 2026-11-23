# AI Agent & Test Authoring Guardrails

This repository enforces strict architectural boundaries, Playwright best practices, and **Junior Developer Readability Standards** for AI coding assistants (GitHub Copilot, Claude, MCP agents) and human engineers contributing to the test suites and SDK codebase.

---

## 1. Repository Structure & Test Suite Directory

All code and test authoring must strictly adhere to the designated layer boundaries:

| Path | Purpose & Rules |
| :--- | :--- |
| `src/middleware/server.ts` | **Gateway Simulation:** In-memory, pseudo-FreeWay commerce middleware. Stateless request handling, idempotency store, and simulated upstream switch decisions. **No test assertions or test runner imports.** |
| `src/mobile-sdk-wrapper/paymentSdkClient.ts` | **Client SDK Wrapper:** Models merchant host-app integration, client-side Luhn checks, log redaction, exponential retry backoff, and backgrounding state. |
| `src/agents/paymentEnvironment.ts` | **Autonomous Agent Environment:** Exposes middleware and SDK capabilities as callable tools for AI agents. |
| `scripts/verify-agent-guardrails.ts` | **Automated Governance Linter:** Enforces `AGENTS.md` architectural standards and PCI checks programmatically in CI (`npm run test:governance`). |
| `scripts/autonomous-payment-agent.ts` | **Autonomous QA Explorer:** Goal-seeking agent executing dynamic state explorations and invariant audits (`npm run agent:explore`). |
| `tests/fixtures/paymentFixtures.ts` | **Test Fixtures & DI:** Playwright `test.extend()` dependency injection. Houses `TEST_CARDS`, `LogCollector`, and lifecycle teardown hooks. |
| `tests/contractGovernance.spec.ts` | **L1 Contract Governance:** Runtime Zod schema validation, API envelope bounds, and backward-compatibility drift detection. |
| `tests/idempotencyResilience.spec.ts` | **L2 Network Resilience:** Transient `502` error injection, retry loop verification, idempotency replay deduplication, and `409 Conflict` detection. |
| `tests/pciSanitization.spec.ts` | **L3 PCI-DSS Req 3.4 Hygiene:** Regex scanning across logs, console output, and errors to prevent raw PAN/CVV leaks. |
| `tests/settlementLifecycle.spec.ts` | **L3.5 Settlement Lifecycle:** Two-step settlement flows (`/freeway/capture` and `/freeway/void`), partial captures, and double-settlement guardrails. |
| `tests/hostAppLifecycle.spec.ts` | **L4 Host App Stability:** Host OS backgrounding/foregrounding transitions, expired session invalidation, and typed error envelope boundaries. |

---

## 2. Junior Developer Readability Standard (Strict Enforcement)

Every automated scenario must be immediately understandable by a junior developer without requiring deep internal knowledge of the test harness.

### 2.1 Explicit AAA (Arrange → Act → Assert) Pattern
Every `test(...)` block must follow a clear, visually separated 3-phase structure:
* **Arrange:** Set up preconditions, test data, and configuration.
* **Act:** Execute the single SDK or gateway operation under test.
* **Assert:** Perform concrete, domain-specific verifications.

```typescript
// ✅ RECOMMENDED: Clear, scannable AAA structure
test('returns cached authorization decision when retrying with identical Idempotency-Key', async ({ sdk }) => {
  // 1. Arrange: Initialize session and tokenize approved test card
  await sdk.initializeSession();
  const tokenRes = await sdk.tokenizeCard(TEST_CARDS.VISA_APPROVE, TEST_CARDS.DEFAULT_CVV);
  const idempotencyKey = crypto.randomUUID();

  // 2. Act: Submit initial authorization and subsequent retry with identical key
  const firstAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 7999, 'ORD-1002', idempotencyKey);
  const retryAttempt = await sdk.authorizePayment(tokenRes.data!.token!, 7999, 'ORD-1002', idempotencyKey);

  // 3. Assert: Both calls succeed and return the identical cached transaction record
  expect(firstAttempt.ok).toBe(true);
  expect(retryAttempt.ok).toBe(true);
  expect(retryAttempt.data?.requestId).toBe(firstAttempt.data?.requestId);
  expect(retryAttempt.data?.authCode).toBe(firstAttempt.data?.authCode);
});
```

### 2.2 Plain-English, Business-Intent Test Names
* **Formula:** `[action/precondition] + [behavior under test] + [expected outcome]`
* ❌ **Bad:** `"test auth retry"`, `"test2"`, `"check background"`
* ✅ **Good:** `"returns cached authorization decision when retrying with identical Idempotency-Key"`
* ✅ **Good:** `"safely rejects payment requests when host app is in background state"`
* ✅ **Good:** `"rejects with 409 Conflict when same Idempotency-Key is reused with a different amount"`

### 2.3 Linear, Branch-Free Test Flow
* **No Control-Flow Logic in Tests:** Strictly forbid `if-else` branching, `for`/`while` loops, or `try-catch` statements inside `test(...)` blocks.
* If a test fails, a junior engineer must be able to identify the exact failing line in the stack trace without unwinding loops or conditional branches.
* Keep each test block concise: **target under 25 lines per scenario**.

### 2.4 Explicit Domain Assertions Over Vague Matchers
* Prefer asserting exact business reason codes and decision enums over general truthiness:
  * ❌ **Avoid:** `expect(res).toBeTruthy();` or `expect(res.ok).toBeDefined();`
  * ✅ **Require:** `expect(res.decision).toBe('ACCEPT');` and `expect(res.reasonCode).toBe('100');`
* For failures, always verify the specific error code (e.g., `expect(res.reasonCode).toBe('NO_ACTIVE_SESSION')`).

### 2.5 Self-Documenting Synthetic Fixtures
* Never invent arbitrary or magic strings for payment data inside test specs.
* Always consume semantic constants from `TEST_CARDS`:
  * `TEST_CARDS.VISA_APPROVE` (simulates successful cardholder authorization)
  * `TEST_CARDS.VISA_DECLINE_DO_NOT_HONOR` (simulates issuing bank decline)
  * `TEST_CARDS.INVALID_LUHN` (simulates malformed card entry failing client pre-validation)

---

## 3. Playwright Architectural Boundaries

1. **No Assertions in Helpers or Wrappers:**
   * Never place `expect()` calls inside `src/mobile-sdk-wrapper/*`, helper classes, or `tests/fixtures/*`.
   * Wrappers perform actions and return typed result envelopes (`SdkResult`); all verification lives explicitly in `tests/*.spec.ts`.
2. **Fixture-Driven Dependency Injection:**
   * Always inject `sdk`, `middleware`, `logs`, and `baseUrl` via `test.extend()` in [`tests/fixtures/paymentFixtures.ts`](tests/fixtures/paymentFixtures.ts).
   * Spec files must never manually spawn HTTP servers, manage local network ports, or write manual `beforeEach`/`afterEach` teardown hooks.
3. **Deterministic Waiting Only:**
   * `page.waitForTimeout()` and arbitrary `setTimeout` sleeps are strictly banned.
   * Coordinate asynchronous behavior through deterministic promises, controlled fault injection flags (e.g., `middleware.forceTransientFailuresRemaining`), or state-change polling.

---

## 4. Payment Domain & PCI-DSS Security Guardrails

1. **Zero Raw Card Numbers in Specs (PCI-DSS Req 3.4):**
   * Never hardcode 13–16 digit PANs in test specs. The CI gate executes a static grep check (`grep -rnE '\b[0-9]{13,16}\b' tests/*.spec.ts`) that immediately blocks commits with raw card numbers.
2. **Mandatory Idempotency Headers:**
   * Every mutating gateway call (`/freeway/authorize`, `/freeway/tokenize`) must provide an `Idempotency-Key` header unless the test is specifically validating missing-header rejection.
3. **Typed Error Envelopes (No Uncaught Exceptions):**
   * The SDK wrapper must catch network and gateway exceptions internally and return structured `SdkResult` envelopes:
     ```typescript
     export interface SdkResult<T = GatewayResponse> {
       ok: boolean;
       decision: Decision; // 'ACCEPT' | 'REJECT' | 'ERROR'
       reasonCode: string;
       data?: T;
       errorMessage?: string;
     }
     ```
   * An SDK method exposed to a third-party host app must never throw unhandled exceptions or crash the parent process.
4. **Log Hygiene Assertions:**
   * Any new error path or log statement added to `paymentSdkClient.ts` must have a corresponding test in [`tests/pciSanitization.spec.ts`](tests/pciSanitization.spec.ts) asserting that raw PANs and CVVs are sanitized to `[REDACTED_PAN]` and `[REDACTED_CVV]`.

---

## 5. Automated Governance & Autonomous QA Agent Integration

This repository shifts quality assurance from passive documentation to **executable agentic governance**:

1. **Automated Architectural Linter (`npm run test:governance`):**
   * Programmatically parses test specs to enforce:
     * Zero raw PANs (PCI-DSS 3.4).
     * Linear, branch-free test blocks (zero `if`, `for`, `while`, `switch`, `try`).
     * Line budget ceiling ($\le$ 35 lines per test).
     * Explicit AAA structure (`Arrange` $\rightarrow$ `Act` $\rightarrow$ `Assert`).
     * Layer boundary isolation (zero assertions in `src/`).
   * Executed automatically in CI prior to test execution.
2. **Autonomous Payment Explorer (`npm run agent:explore`):**
   * An autonomous agent that consumes [`src/agents/paymentEnvironment.ts`](src/agents/paymentEnvironment.ts) as a formal tool environment.
   * Dynamically traverses payment state transitions, injects switch faults, challenges idempotency, and audits PCI log hygiene invariants in a continuous feedback loop.
