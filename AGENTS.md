# AI Agent & Test Authoring Guardrails

This repository enforces strict architectural boundaries and Playwright best practices for AI coding assistants (GitHub Copilot, Claude, MCP agents) generating or modifying code and test suites.

## 1. Repository & File Conventions
* **Consistent Kebab-Case Filenames:** All TypeScript source files, fixtures, and spec files must use lowercase `kebab-case` (e.g., `payment-sdk-client.ts`, `payment-fixtures.ts`) to prevent case-sensitivity failures between local workstations and Linux CI runners.
* **Strict Layer Separation:**
  * `src/middleware/`: Stateless/in-memory gateway simulation only. No test helpers or `expect()` imports.
  * `src/mobile-sdk-wrapper/`: Client wrapper modeling host-app interactions, retries, and log sanitization.
  * `tests/fixtures/`: Playwright `test.extend()` fixtures, server lifecycle management, and synthetic test data.
  * `tests/*.spec.ts`: Behavioral scenarios and assertions only.

## 2. Playwright Architectural Best Practices
* **No Assertions in Wrapper / Page-Object / Fixture Files:** Never place `expect()` calls inside `src/mobile-sdk-wrapper/*`, helper classes, or `tests/fixtures/*`. Wrappers and helpers perform actions and return typed result envelopes (`SdkResult`); all verification lives explicitly inside `*.spec.ts` files.
* **Fixture-Driven Dependency Injection:** Always consume `sdk`, `middleware`, `logs`, and `baseUrl` via `test.extend()` in `tests/fixtures/payment-fixtures.ts`. Never instantiate servers, manage ports, or wire teardown hooks (`beforeEach`/`afterEach`) manually inside individual spec files.
* **Simple, Scannable Tests (AAA Pattern):** Keep every `test(...)` block concise (under ~25 lines) with clear **Arrange → Act → Assert** separation and descriptive business-intent titles (e.g., `"returns cached authorization decision when retrying with identical Idempotency-Key"` rather than `"test authorize retry"`).
* **Deterministic Waiting Only:** `page.waitForTimeout()` and arbitrary `setTimeout` sleeps are strictly banned. Use deterministic polling, event listeners, or controllable fault-injection flags.

## 3. Payment Domain & PCI-DSS Security Rules
* **Zero Raw Card Numbers in Specs:** Never hardcode 13–16 digit PANs inside `*.spec.ts` files. Always import synthetic Luhn-valid fixtures from `tests/fixtures/payment-fixtures.ts`.
* **Mandatory Idempotency Headers:** Every mutating gateway request (`/freeway/authorize`, `/freeway/capture`) must include a unique `Idempotency-Key` unless the test is explicitly verifying a `400 Bad Request` missing-header rejection.
* **Typed Error Boundaries:** SDK wrapper methods exposed to third-party host apps must return structured `{ ok: boolean; decision: Decision; reasonCode: string; errorMessage?: string }` envelopes rather than throwing raw network exceptions.
* **Log Hygiene Assertions:** Any new error-handling path added to `src/mobile-sdk-wrapper/` must have a corresponding assertion in `tests/2-pci-sanitization.spec.ts` verifying PAN/CVV redaction.