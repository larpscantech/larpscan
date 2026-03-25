/**
 * scripts/test-full-verify.ts
 *
 * End-to-end test using the real verifyClaim() function from lib/verifier.ts.
 * Tests a TOKEN_CREATION claim on bnbshare.fun with wallet support enabled.
 *
 * Run: npx tsx scripts/test-full-verify.ts
 */

import * as path from 'path';
import * as fs from 'fs';

// ── Load .env.local BEFORE any imports that use process.env ──────────────────
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ── Now import modules that rely on env vars ──────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyClaim } = require('../lib/verifier') as typeof import('../lib/verifier');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { determineVerdict } = require('../lib/verdict') as typeof import('../lib/verdict');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluateDeterministicVerdict } = require('../lib/verdict-rules') as typeof import('../lib/verdict-rules');

const WEBSITE      = 'https://bnbshare.fun';
const CLAIM        = 'Users can create a token linked to a Twitter, GitHub, TikTok, or Twitch handle, and a portion of all trading fees for that token is automatically routed to the linked creator.';
const PASS_COND    = 'Navigate to /create and observe the option to link a token to a social media handle, with details on fee routing to the creator.';
const CLAIM_ID     = 'test-001';
const SURFACE      = '/create';
const FEATURE_TYPE = 'TOKEN_CREATION';
const STRATEGY     = 'form+browser';

console.log('🔍 Running full verifier on bnbshare.fun TOKEN_CREATION claim...');
console.log(`   Wallet address from env: ${process.env.INVESTIGATION_WALLET_PRIVATE_KEY ? '✅ set' : '❌ missing'}`);
console.log();

async function main() {
const start = Date.now();
try {
  const verifyResult = await verifyClaim(
    WEBSITE, CLAIM, PASS_COND, CLAIM_ID, SURFACE, FEATURE_TYPE, STRATEGY,
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (verifyResult.signals) {
    const s = verifyResult.signals;
    console.log('\n── Signals ────────────────────────────────────────────────');
    console.log(`  reachedSurface:  ${s.reachedRelevantSurface}`);
    console.log(`  formAppeared:    ${s.formAppeared}`);
    console.log(`  enabledCta:      ${s.enabledCtaPresent}`);
    console.log(`  blockers:        ${s.blockersEncountered.join(', ') || 'none'}`);
    console.log(`  noopCount:       ${s.noopCount}/${s.totalSteps}`);
    console.log(`  ownApiCalls:     ${s.ownDomainApiCalls.length}`);
    if (s.walletEvidence) {
      console.log(`  walletConnected: ${s.walletEvidence.walletConnected}`);
      console.log(`  walletAddress:   ${s.walletEvidence.walletAddress ?? 'n/a'}`);
    }
  }

  // Run Layer 1 deterministic verdict
  const layer1 = verifyResult.signals
    ? evaluateDeterministicVerdict(verifyResult.signals, FEATURE_TYPE)
    : { resolved: false, reasons: ['No signals'] };

  console.log('\n── Layer 1 (Deterministic) ─────────────────────────────────');
  console.log(`  resolved:    ${layer1.resolved}`);
  if (layer1.resolved) {
    console.log(`  verdict:     ${layer1.verdict}`);
    console.log(`  confidence:  ${layer1.confidence}`);
    console.log(`  matchedRule: ${layer1.matchedRule}`);
    layer1.reasons.forEach((r) => console.log(`  reason: ${r}`));
  } else {
    console.log('  → falling through to LLM fallback');
  }

  // Full verdict (including LLM if needed)
  let finalVerdict = '';
  if (layer1.resolved) {
    finalVerdict = layer1.verdict ?? 'unknown';
  } else if (verifyResult.signals) {
    const llmResult = await determineVerdict(
      CLAIM, PASS_COND, verifyResult.evidenceSummary, verifyResult.signals, FEATURE_TYPE,
    );
    console.log('\n── Layer 2 (LLM) ───────────────────────────────────────────');
    console.log(`  verdict:     ${llmResult.verdict}`);
    finalVerdict = llmResult.verdict;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`FINAL VERDICT: ${finalVerdict.toUpperCase()} (${elapsed}s)`);

  if (finalVerdict === 'verified') {
    console.log('\n✅ SUCCESS — TOKEN_CREATION is VERIFIED');
  } else {
    console.log(`\n❌ NOT VERIFIED — verdict: ${finalVerdict}`);
    process.exit(1);
  }
} catch (e) {
  console.error('\n💥 verifyClaim threw:', e);
  process.exit(1);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
