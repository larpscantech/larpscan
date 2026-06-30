#!/usr/bin/env node
/**
 * Run token-creation verification against bonk.fun, bags.fm, and pump.fun.
 * Token names use generic TestToken{sfx} — never product branding.
 *
 * Usage: npx tsx scripts/test-launchpads.mjs [site...]
 *   site: bonk | bags | pump  (default: all three)
 */
import { readFileSync } from 'node:fs';

try {
  const envPath = new URL('../.env.local', import.meta.url).pathname;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* ignore */ }

const { verifyClaim } = await import('../lib/verifier.ts');

const SITES = {
  bonk: {
    url:     'https://bonk.fun',
    surface: '/create',
    label:   'bonk.fun',
  },
  bags: {
    url:     'https://bags.fm',
    surface: '/launch',
    label:   'bags.fm',
  },
  pump: {
    url:     'https://pump.fun',
    surface: '/create',
    label:   'pump.fun',
  },
};

const requested = process.argv.slice(2).map((s) => s.toLowerCase());
const toRun = requested.length > 0
  ? requested.filter((k) => SITES[k]).map((k) => [k, SITES[k]])
  : Object.entries(SITES);

if (toRun.length === 0) {
  console.error('Unknown site(s). Use: bonk, bags, pump');
  process.exit(1);
}

const summary = [];

for (const [key, site] of toRun) {
  const sfx   = (Date.now() % 10000).toString().padStart(4, '0');
  const name  = `TestToken${sfx}`;
  const sym   = `T${sfx.slice(-3)}`;
  const claim = `The platform allows users to launch a token named ${name} with symbol ${sym} on Solana`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[test] ${site.label} — ${name} / ${sym}`);
  console.log(`${'='.repeat(60)}\n`);

  const t0 = Date.now();
  try {
    const result = await verifyClaim(
      site.url,
      claim,
      'Token creation form submitted and transaction signed',
      `test-${key}-${sfx}`,
      site.surface,
      'ONCHAIN_TOKEN_CREATE',
      'ui+browser',
    );

    const txHash = result.signals?.transactionHash;
    const txs = txHash ? [txHash] : [];
    const row = {
      site:    site.label,
      name,
      symbol:  sym,
      ms:      Date.now() - t0,
      txs,
      txCount: txs.length,
      txReceipt: result.signals?.transactionReceiptStatus ?? 'n/a',
      wallet:  result.walletEvidence?.walletConnected ?? false,
      url:     result.signals?.finalUrl ?? '',
      txSubmitted: result.signals?.transactionSubmitted ?? false,
    };
    summary.push(row);

    console.log(`\n[test] ${site.label} DONE (${(row.ms / 1000).toFixed(0)}s)`);
    console.log(`  wallet:   ${row.wallet}`);
    console.log(`  txs:      ${txs.length}${txs.length ? ` → ${txs.join(', ')}` : ''}`);
    console.log(`  receipt:  ${row.txReceipt}`);
    console.log(`  finalUrl: ${row.url}`);
    if (row.txSubmitted) console.log('  txSubmitted: true');
  } catch (err) {
    summary.push({ site: site.label, name, error: String(err), ms: Date.now() - t0 });
    console.error(`[test] ${site.label} ERROR:`, err);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log('SUMMARY');
console.log(`${'='.repeat(60)}`);
for (const row of summary) {
  if (row.error) {
    console.log(`  ✗ ${row.site}: ERROR — ${row.error.slice(0, 120)}`);
  } else {
    const txOk = row.txCount > 0 ? `✓ ${row.txCount} tx (${row.txReceipt})` : '✗ no tx';
    console.log(`  ${txOk} | ${row.site} | ${row.name} | wallet=${row.wallet} | ${(row.ms / 1000).toFixed(0)}s`);
  }
}
