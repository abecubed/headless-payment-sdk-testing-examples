# Headless Payment SDK & Middleware QA Scenarios

Reference quality architecture and automated test scenarios modeling a **headless mobile payment SDK wrapper** communicating with a **FreeWay-style commerce middleware gateway**.

Because payment SDK wrappers sit inside third-party merchant apps without owning the consumer UI, quality risks center on **contract drift, network drop-off resilience, idempotency, host-app stability, and PCI-DSS data hygiene**.

## Architecture & Test Pyramid

    +-------------------------------------------------------------------+
    |  Third-Party Merchant Host App (Simulated Lifecycle & Callbacks)  |
    +---------------------------------+---------------------------------+
                                      |  Public SDK Interface
    +---------------------------------v---------------------------------+
    |  Mobile Payment SDK Wrapper (src/mobile-sdk-wrapper/)             |
    |  - Luhn pre-validation & timeout/backoff handling                 |
    |  - PCI-DSS Req 3.4 PAN/CVV sanitization on logs & errors          |
    +---------------------------------+---------------------------------+
                                      |  HTTPS / JSON + Idempotency-Key
    +---------------------------------v---------------------------------+
    |  Commerce Middleware Gateway (src/middleware/)                    |
    |  - /freeway/init-session  |  /freeway/tokenize                    |
    |  - /freeway/authorize     |  Idempotency & Decision State Store   |
    +-------------------------------------------------------------------+

## Scenarios Covered

| Risk Domain | Engineering Pattern Demonstrated | Test Suite |
| :--- | :--- | :--- |
| **Network Drop-Offs & Double-Charges** | `Idempotency-Key` enforcement, retry backoff on `502`/`504`, `409 Conflict` on payload mismatch | `tests/1-idempotency-resilience.spec.ts` |
| **PCI-DSS Log & Error Sanitization** | Regex scanning across stdout, telemetry, and thrown exceptions to block raw PAN/CVV leaks | `tests/2-pci-sanitization.spec.ts` |
| **SDK-to-Middleware Contract Drift** | Strict Zod schema validation ensuring backward compatibility across SDK/middleware versions | `tests/3-contract-governance.spec.ts` |
| **Third-Party Host App Stability** | OS backgrounding, expired session recovery, and typed error boundaries (no uncaught crashes) | `tests/4-host-app-lifecycle.spec.ts` |

## Quickstart

    npm install
    npm run test:ci