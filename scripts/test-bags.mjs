#!/usr/bin/env node
/**
 * Direct test runner for bags.fm token-launch verification.
 * Runs verifyClaim without Supabase / the full API stack.
 * Usage: npx tsx scripts/test-bags.mjs
 */
import { readFileSync } from 'node:fs';

// Load .env.local manually
try {
  const envPath = new URL('../.env.local', import.meta.url).pathname;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* ignore */ }

const { verifyClaim } = await import('../lib/verifier.ts');

const sfx   = (Date.now() % 10000).toString().padStart(4, '0');
const claim = `The platform allows users to launch a token named TestToken${sfx} with symbol T${sfx.slice(-3)} on Solana`;

console.log(`\n[test] bags.fm — claim: ${claim}\n`);

try {
  const result = await verifyClaim(
    'https://bags.fm',
    claim,
    'Token creation form submitted and transaction signed',
    'test-claim-' + sfx,
    '/launch',
    'ONCHAIN_TOKEN_CREATE',
    'ui+browser',
  );

  console.log('\n[test] RESULT:', JSON.stringify(result, null, 2));
} catch (err) {
  console.error('[test] ERROR:', err);
  process.exit(1);
}
