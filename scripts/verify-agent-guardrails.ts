import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Violation {
  file: string;
  rule: string;
  message: string;
  line?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT_DIR, 'tests');
const SRC_DIR = path.join(ROOT_DIR, 'src');

const violations: Violation[] = [];

// Helper to list files
function getFiles(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getFiles(fullPath, pattern));
    } else if (pattern.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

console.log('\n============================================================');
console.log('  🤖 AGENTS.md Architectural Governance & Quality Linter');
console.log('============================================================\n');

const specFiles = getFiles(TESTS_DIR, /\.spec\.ts$/);
const srcFiles = getFiles(SRC_DIR, /\.ts$/);

let totalTestsAudited = 0;

// Rule 1: Zero Raw PANs in specs (PCI-DSS Req 3.4)
const RAW_PAN_REGEX = /\b[0-9]{13,16}\b/;
for (const file of specFiles) {
  const relPath = path.relative(ROOT_DIR, file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (RAW_PAN_REGEX.test(line)) {
      violations.push({
        file: relPath,
        line: idx + 1,
        rule: 'PCI-DSS Req 3.4 Zero Raw PANs',
        message: `Hardcoded credit card number detected: "${line.trim()}". Import from paymentFixtures.ts instead.`,
      });
    }
  });
}

// Rule 2, 3, 4: Junior Readability, AAA Pattern & Line Budget per test(...) block
for (const file of specFiles) {
  const relPath = path.relative(ROOT_DIR, file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  let inTest = false;
  let testStartLine = 0;
  let testLines: string[] = [];
  let testTitle = '';
  let braceDepth = 0;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!inTest && /^\s*test(\.only|\.skip)?\s*\(/.test(line)) {
      inTest = true;
      testStartLine = idx + 1;
      testLines = [line];
      testTitle = trimmed;
      braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      totalTestsAudited++;
      return;
    }

    if (inTest) {
      testLines.push(line);
      braceDepth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;

      // When test block closes
      if (braceDepth <= 0 && trimmed.endsWith('});')) {
        inTest = false;
        const testBlock = testLines.join('\n');
        const lineCount = testLines.length;

        // Rule 3: Scannability ceiling (< 35 lines)
        if (lineCount > 35) {
          violations.push({
            file: relPath,
            line: testStartLine,
            rule: 'Junior Readability: Max Test Line Budget (<35 lines)',
            message: `Test "${testTitle.slice(0, 50)}..." is ${lineCount} lines long. Target under 25 lines.`,
          });
        }

        // Rule 2: Linear Flow (No control flow keywords in test code)
        testLines.forEach((tLine, tIdx) => {
          const stripped = tLine.trim();
          // Skip comments
          if (stripped.startsWith('//') || stripped.startsWith('/*')) return;
          if (/\b(if|else|for|while|switch|try|catch)\b\s*(\(|\{)/.test(stripped)) {
            violations.push({
              file: relPath,
              line: testStartLine + tIdx,
              rule: 'Junior Readability: Linear Branch-Free Flow',
              message: `Forbidden control flow statement "${stripped}" detected inside test block. Tests must be linear.`,
            });
          }
        });

        // Rule 4: Mandatory AAA comments
        const hasArrange = /\/\/\s*1?\s*\.?\s*Arrange/i.test(testBlock);
        const hasAct = /\/\/\s*2?\s*\.?\s*Act/i.test(testBlock);
        const hasAssert = /\/\/\s*3?\s*\.?\s*Assert/i.test(testBlock);

        if (!hasArrange || !hasAct || !hasAssert) {
          violations.push({
            file: relPath,
            line: testStartLine,
            rule: 'Junior Readability: Explicit AAA Structure',
            message: `Test missing explicit AAA comments (Arrange: ${hasArrange}, Act: ${hasAct}, Assert: ${hasAssert}) in "${testTitle.slice(0, 40)}...".`,
          });
        }
      }
    }
  });
}

// Rule 5: Layer Isolation (No assertions inside src/ wrapper or middleware)
for (const file of srcFiles) {
  const relPath = path.relative(ROOT_DIR, file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (/\bexpect\s*\(/.test(line)) {
      violations.push({
        file: relPath,
        line: idx + 1,
        rule: 'Layer Isolation: Zero Assertions in Source',
        message: `expect() call detected in source file "${relPath}". Assertions belong exclusively in tests/*.spec.ts.`,
      });
    }
  });
}

// Output summary
console.log(`📁 Files Audited: ${specFiles.length} spec files, ${srcFiles.length} source files`);
console.log(`🧪 Test Scenarios Audited: ${totalTestsAudited} total scenarios\n`);

if (violations.length === 0) {
  console.log('✅ [PASS] Rule 1 (PCI-DSS 3.4): Zero raw PANs detected in test specs.');
  console.log('✅ [PASS] Rule 2 (Linear Flow): Zero loops or branching statements in test blocks.');
  console.log('✅ [PASS] Rule 3 (Scannability): All test blocks strictly within <= 35 line ceiling.');
  console.log('✅ [PASS] Rule 4 (AAA Pattern): All scenarios follow explicit Arrange -> Act -> Assert.');
  console.log('✅ [PASS] Rule 5 (Layer Isolation): Zero assertions in SDK wrapper or middleware simulation.\n');
  console.log('🎉 100% COMPLIANT: All test suites adhere to AGENTS.md architectural standards!\n');
  process.exit(0);
} else {
  console.error(`❌ FAILED: ${violations.length} architectural violation(s) detected:\n`);
  violations.forEach((v, idx) => {
    console.error(`  ${idx + 1}. [${v.rule}] in ${v.file}:${v.line || '?'}`);
    console.error(`     ↳ ${v.message}\n`);
  });
  process.exit(1);
}
