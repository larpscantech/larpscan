#!/usr/bin/env node
/**
 * Fast Privy auth smoke test — bags.fm / bonk.fun / any URL.
 * Usage: npx tsx scripts/test-privy-auth.mjs [url]
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

try {
  const envPath = new URL('../.env.local', import.meta.url).pathname;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* ignore */ }

const { installPrivyMockOnContext } = await import('../lib/privy-mock.ts');
const { injectWalletMockIntoContext, ensurePrivyAuthenticated, hasPrivySessionToken } =
  await import('../lib/browser-agent/wallet-connect-flow.ts');
const { exposeSigningBridge } = await import('../lib/wallet/signer.ts');
const { investigationWalletAddress } = await import('../lib/wallet/client.ts');
const { TOKEN_CREATION_POLICY } = await import('../lib/wallet/policy.ts');

const targetUrl = process.argv[2] || 'https://bags.fm/launch';
const walletAddress = investigationWalletAddress;

if (!walletAddress) {
  console.error('[test] INVESTIGATION_WALLET_PRIVATE_KEY not configured in .env.local');
  process.exit(1);
}

console.log(`\n[test] Privy auth smoke test`);
console.log(`[test] URL: ${targetUrl}`);
console.log(`[test] Wallet: ${walletAddress}\n`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

const sessionId = `test-${Date.now()}`;
await exposeSigningBridge(context, sessionId);
await injectWalletMockIntoContext(context, walletAddress);
await installPrivyMockOnContext(context, walletAddress);

const page = await context.newPage();
page.on('console', (msg) => {
  const t = msg.text();
  if (/privy|mock|siws|larpscan/i.test(t)) console.log(`  [browser] ${t.slice(0, 200)}`);
});

console.log('[test] Navigating...');
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(5_000);

const bodyBefore = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? '');
console.log('[test] Page before auth:', bodyBefore.replace(/\s+/g, ' ').slice(0, 150));

const start = Date.now();
const result = await ensurePrivyAuthenticated(page, walletAddress, TOKEN_CREATION_POLICY, 'TOKEN_CREATION');
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\n[test] Auth completed in ${elapsed}s — connected=${result.connected}`);
for (const line of result.log) console.log(`  ${line}`);

const tokenInfo = await page.evaluate(() => {
  const tok = localStorage.getItem('privy:token');
  if (!tok) return null;
  try {
    const parts = tok.split('.');
    const pad = '='.repeat((4 - parts[1].length % 4) % 4);
    const pl = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad));
    return { aud: pl.aud, expIn: pl.exp - Math.floor(Date.now() / 1000) };
  } catch { return { raw: tok.slice(0, 40) }; }
});
console.log('[test] Token:', tokenInfo);
console.log('[test] hasPrivySessionToken:', await hasPrivySessionToken(page));

const bodyAfter = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
const short = walletAddress.slice(0, 6).toLowerCase();
const walletVisible = bodyAfter.toLowerCase().includes(short);
const launchBtn = await page.locator('button').filter({ hasText: /^launch$/i }).first();
const launchEnabled = launchBtn ? await launchBtn.isEnabled().catch(() => false) : false;
const loginGated = /log in to start|verify your profile|verify with x|welcome to bags/i.test(bodyAfter);
console.log('[test] Wallet visible in UI:', walletVisible);
console.log('[test] Launch button enabled:', launchEnabled);
console.log('[test] Blocking login gate:', loginGated);
console.log('[test] Page after auth:', bodyAfter.replace(/\s+/g, ' ').slice(0, 200));

await page.screenshot({ path: '/tmp/privy-auth-test.png', fullPage: false }).catch(() => {});

const launchAvailable = await page.locator('button').filter({ hasText: /^launch$/i }).count().catch(() => 0) > 0;
const loginToStartGone = !(await page.locator('button').filter({ hasText: /log in to start/i }).isVisible().catch(() => false));
console.log('[test] Launch button present:', launchAvailable);
console.log('[test] Log in to start gone:', loginToStartGone);

await browser.close();

const ok = result.connected && (walletVisible || launchEnabled || !loginGated);
const finalOk = ok || launchAvailable || (result.connected && loginToStartGone);
console.log(`\n[test] ${finalOk ? 'PASS' : 'FAIL'}\n`);
process.exit(finalOk ? 0 : 1);
