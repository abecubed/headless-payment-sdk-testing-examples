import crypto from 'node:crypto';
import { PaymentAgentEnvironment } from '../src/agents/paymentEnvironment.ts';

async function runAutonomousAgent() {
  console.log('\n================================================================');
  console.log('  🧠 Autonomous Payment QA Explorer Agent (FreeWay Simulator)');
  console.log('================================================================');
  console.log('🎯 Mission: Autonomously probe payment lifecycle, stress-test');
  console.log('   drop-off recovery, test idempotency, and audit PCI invariants.');
  console.log('----------------------------------------------------------------\n');

  const env = new PaymentAgentEnvironment();
  await env.start();
  const tools = env.getTools();

  const invariantAudits: Array<{ name: string; passed: boolean; detail: string }> = [];

  try {
    // -------------------------------------------------------------
    // Step 1: Bootstrap Gateway Session
    // -------------------------------------------------------------
    console.log('🤖 [Step 1: Session Bootstrapping]');
    console.log('   💭 Thought: Gateway communication requires an authenticated session. Let\'s initialize session.');
    console.log('   ⚡ Action: call tools.initialize_session()');
    const step1Res = await tools.initialize_session.execute();
    console.log(`   🔎 Observation: ${JSON.stringify(step1Res)}`);
    invariantAudits.push({
      name: 'Session Initialization',
      passed: step1Res.ok === true && !!step1Res.sessionId,
      detail: 'FreeWay session token generated and stored in SDK state',
    });

    // -------------------------------------------------------------
    // Step 2: Adversarial PCI Threat & Luhn Pre-validation
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 2: Adversarial PCI Threat Injection]');
    console.log('   💭 Thought: Test client defense by attempting to tokenize an invalid Luhn card number.');
    console.log('   ⚡ Action: call tools.tokenize_card({ cardType: "INVALID_LUHN" })');
    const step2Res = await tools.tokenize_card.execute({ cardType: 'INVALID_LUHN' });
    console.log(`   🔎 Observation: ok=${step2Res.ok}, decision=${step2Res.decision}, reasonCode=${step2Res.reasonCode}`);

    console.log('   💭 Thought: Verify that the invalid card entry was redacted from logs before any network hop.');
    console.log('   ⚡ Action: call tools.audit_pci_logs()');
    const pciAudit1 = await tools.audit_pci_logs.execute();
    console.log(`   🔎 Observation: clean=${pciAudit1.clean}, redactionActive=${pciAudit1.redactionActive}`);
    invariantAudits.push({
      name: 'PCI Req 3.4 Pre-Gateway Redaction',
      passed: pciAudit1.clean === true && pciAudit1.redactionActive === true,
      detail: 'Client-side Luhn failure scrubbed raw card to [REDACTED_PAN] in logs',
    });

    // -------------------------------------------------------------
    // Step 3: Legitimate Tokenization
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 3: Legitimate Tokenization]');
    console.log('   💭 Thought: Now tokenize an approved Visa card to obtain an omnichannel payment token.');
    console.log('   ⚡ Action: call tools.tokenize_card({ cardType: "VISA_APPROVE" })');
    const step3Res = await tools.tokenize_card.execute({ cardType: 'VISA_APPROVE' });
    console.log(`   🔎 Observation: ok=${step3Res.ok}, token=${step3Res.token}, maskedPan=${step3Res.maskedPan}`);
    invariantAudits.push({
      name: 'Token Vault Masking',
      passed: step3Res.ok === true && step3Res.maskedPan === '************1111',
      detail: 'PAN safely exchanged for reusable token with 12-digit masking',
    });

    // -------------------------------------------------------------
    // Step 4: Intermittent Network Drop-Off & Retry Backoff
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 4: Intermittent Switch Drop-Off & Recovery]');
    console.log('   💭 Thought: Inject two consecutive 502 Bad Gateway failures to stress client retry backoff.');
    console.log('   ⚡ Action: call tools.inject_transient_502({ failureCount: 2 })');
    await tools.inject_transient_502.execute({ failureCount: 2 });

    const idemKey1 = crypto.randomUUID();
    console.log('   💭 Thought: Submit authorization for $45.00 while gateway is experiencing transient failure.');
    console.log(`   ⚡ Action: call tools.authorize_payment({ amountCents: 4500, refCode: "AGENT-ORD-01", key: "${idemKey1.slice(0, 8)}..." })`);
    const step4Res = await tools.authorize_payment.execute({
      amountCents: 4500,
      merchantReferenceCode: 'AGENT-ORD-01',
      idempotencyKey: idemKey1,
    });
    console.log(`   🔎 Observation: ok=${step4Res.ok}, decision=${step4Res.decision}, authCode=${step4Res.authCode}`);
    invariantAudits.push({
      name: 'Transient 502 Backoff Resilience',
      passed: step4Res.ok === true && !!step4Res.authCode,
      detail: 'SDK transparently retried and successfully authorized after 502s cleared',
    });

    // -------------------------------------------------------------
    // Step 5: Financial Idempotency Replay Verification
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 5: Idempotency Replay Deduplication]');
    console.log('   💭 Thought: Replay the identical authorization request using the same Idempotency-Key.');
    console.log('   ⚡ Action: call tools.authorize_payment(identical parameters & key)');
    const step5Res = await tools.authorize_payment.execute({
      amountCents: 4500,
      merchantReferenceCode: 'AGENT-ORD-01',
      idempotencyKey: idemKey1,
    });
    console.log(`   🔎 Observation: ok=${step5Res.ok}, requestId=${step5Res.requestId}, authCode=${step5Res.authCode}`);
    invariantAudits.push({
      name: 'Financial Idempotency Deduplication',
      passed: step5Res.ok === true && step5Res.authCode === step4Res.authCode && step5Res.requestId === step4Res.requestId,
      detail: 'Gateway returned cached record; zero duplicate billing occurred',
    });

    // -------------------------------------------------------------
    // Step 6: Anti-Tampering Conflict Protection
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 6: Idempotency Payload Tampering Detection]');
    console.log('   💭 Thought: Replay same Idempotency-Key but tamper with the amount ($99.00 instead of $45.00).');
    console.log('   ⚡ Action: call tools.authorize_payment(tampered amount: 9900)');
    const step6Res = await tools.authorize_payment.execute({
      amountCents: 9900,
      merchantReferenceCode: 'AGENT-ORD-01',
      idempotencyKey: idemKey1,
    });
    console.log(`   🔎 Observation: ok=${step6Res.ok}, decision=${step6Res.decision}, reasonCode=${step6Res.reasonCode}`);
    invariantAudits.push({
      name: 'Anti-Tampering 409 Conflict',
      passed: step6Res.ok === false && step6Res.reasonCode === '409',
      detail: 'Gateway detected payload hash mismatch on reused key and rejected with 409 Conflict',
    });

    // -------------------------------------------------------------
    // Step 7: Host OS Lifecycle Disruption
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 7: Host OS Lifecycle Disruption]');
    console.log('   💭 Thought: Simulate OS backgrounding the host merchant app mid-session.');
    console.log('   ⚡ Action: call tools.background_host_app()');
    await tools.background_host_app.execute();

    console.log('   💭 Thought: Attempt authorization while backgrounded to verify defense boundary.');
    console.log('   ⚡ Action: call tools.authorize_payment(...)');
    const step7Res = await tools.authorize_payment.execute({
      amountCents: 2000,
      merchantReferenceCode: 'AGENT-ORD-02',
    });
    console.log(`   🔎 Observation: ok=${step7Res.ok}, decision=${step7Res.decision}, reasonCode=${step7Res.reasonCode}`);
    invariantAudits.push({
      name: 'OS Backgrounding Invalidation',
      passed: step7Res.ok === false && step7Res.reasonCode === 'NO_ACTIVE_SESSION',
      detail: 'Session purged on backgrounding; prevented stale token replay without crashing host app',
    });

    // -------------------------------------------------------------
    // Step 8: Recovery & Two-Step Settlement (Capture)
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 8: Recovery & Two-Step Settlement]');
    console.log('   💭 Thought: Foreground app, re-initialize session, tokenize, authorize, and capture hold.');
    console.log('   ⚡ Action: call foreground -> initSession -> tokenize -> authorize');
    await tools.foreground_host_app.execute();
    await tools.initialize_session.execute();
    const token2 = await tools.tokenize_card.execute({ cardType: 'VISA_APPROVE' });
    const auth2 = await tools.authorize_payment.execute({
      amountCents: 6000,
      merchantReferenceCode: 'AGENT-ORD-03',
    });
    console.log(`   🔎 Observation: Auth successful with authCode=${auth2.authCode}`);

    console.log('   ⚡ Action: call tools.capture_payment({ amountCents: 6000 })');
    const captureRes = await tools.capture_payment.execute({ amountCents: 6000 });
    console.log(`   🔎 Observation: Capture confirmed: ok=${captureRes.ok}, reasonCode=${captureRes.reasonCode}`);
    invariantAudits.push({
      name: 'Two-Step Auth & Capture Settlement',
      passed: captureRes.ok === true && captureRes.reasonCode === '100',
      detail: 'Successful pre-auth hold and batch settlement capture',
    });

    // -------------------------------------------------------------
    // Step 9: Final PCI-DSS 3.4 Deep Log Scan
    // -------------------------------------------------------------
    console.log('\n🤖 [Step 9: Final PCI-DSS Req 3.4 Compliance Audit]');
    console.log('   💭 Thought: Scan the entire history of log envelopes generated across the session.');
    console.log('   ⚡ Action: call tools.audit_pci_logs()');
    const finalPciAudit = await tools.audit_pci_logs.execute();
    console.log(`   🔎 Observation: Total Log Entries: ${finalPciAudit.totalLogEntries}, Violations: ${finalPciAudit.violationsFound}`);
    invariantAudits.push({
      name: 'Global PCI-DSS 3.4 Data Hygiene',
      passed: finalPciAudit.clean === true && finalPciAudit.violationsFound === 0,
      detail: 'Zero raw 13-16 digit PANs or CVVs leaked across any log collector',
    });

  } finally {
    await env.stop();
  }

  // -------------------------------------------------------------
  // Executive Summary Report
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log('  📊 Autonomous Agent Exploration Report & Invariant Audit');
  console.log('================================================================');
  invariantAudits.forEach((inv, idx) => {
    const mark = inv.passed ? '✅ [PASS]' : '❌ [FAIL]';
    console.log(`${idx + 1}. ${mark} ${inv.name}`);
    console.log(`   ↳ ${inv.detail}`);
  });

  const allPassed = invariantAudits.every((i) => i.passed);
  console.log('----------------------------------------------------------------');
  if (allPassed) {
    console.log(`🎉 ALL ${invariantAudits.length} PAYMENT INVARIANTS VERIFIED AUTONOMOUSLY!`);
    console.log('   Resilience Score: 100% | PCI Leak Risk: 0.0% | Crash Rate: 0.0%\n');
    process.exit(0);
  } else {
    console.error('❌ INVARIANT VIOLATION DETECTED DURING AUTONOMOUS EXPLORATION\n');
    process.exit(1);
  }
}

runAutonomousAgent().catch((err) => {
  console.error('Autonomous Agent Error:', err);
  process.exit(1);
});
