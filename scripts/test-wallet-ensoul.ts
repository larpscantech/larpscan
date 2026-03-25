/**
 * scripts/test-wallet-ensoul.ts
 *
 * Focused test: can our wallet mock connect on ensoul.ac (RainbowKit + wagmi)?
 * Run:  npx tsx scripts/test-wallet-ensoul.ts
 */

import * as path from 'path';
import * as fs   from 'fs';

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)/);
    if (m) {
      const k = m[1].trim();
      if (!process.env[k]) process.env[k] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const walletAddress = '0x1B634B1AeFFf672F9250844D5C5262E7493596B1';

async function main() {
  const { chromium }                                       = await import('playwright');
  const { exposeSigningBridge }                            = await import('../lib/wallet/signer');
  const { handleWalletPopups, injectWalletMockIntoContext } = await import('../lib/browser-agent/executor');
  const { DEFAULT_WALLET_POLICY }                          = await import('../lib/wallet/policy');

  const SHOTS = path.resolve(process.cwd(), 'scripts/ensoul-shots');
  fs.mkdirSync(SHOTS, { recursive: true });
  let sc = 0;
  const snap = async (page: import('playwright').Page, label: string) => {
    const f = path.join(SHOTS, `${String(sc++).padStart(2, '0')}-${label}.png`);
    await page.screenshot({ path: f, fullPage: false });
    console.log(`  📸 ${path.basename(f)}`);
  };

  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport:  { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    recordVideo: { dir: SHOTS, size: { width: 1280, height: 800 } },
  });

  await exposeSigningBridge(context, 'ensoul-test');
  await injectWalletMockIntoContext(context, walletAddress);

  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[mock]') || t.includes('[signer]') || t.includes('[wallet]') || t.includes('chainverify')) {
      console.log(`  PAGE: ${t.slice(0, 200)}`);
    }
  });

  console.log('\n🔍 Ensoul wallet connection test — ensoul.ac/mint');
  console.log(`   Wallet: ${walletAddress}\n`);

  // ── Test 1: /mint page ────────────────────────────────────────────────────
  console.log('▶ Navigating to https://ensoul.ac/mint ...');
  await page.goto('https://ensoul.ac/mint', { waitUntil: 'load', timeout: 20_000 }).catch(() => null);
  await page.waitForTimeout(5_000);  // wait for full React + AppKit hydration
  await snap(page, '01-mint-loaded');

  const pageText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  console.log(`   Page text snippet: "${pageText.slice(0, 200).replace(/\n/g, ' ')}"`);

  // ── Inspect localStorage to see what wagmi actually stored ───────────────
  const lsData = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const result: Record<string, unknown> = {};
    for (const k of keys) {
      try { result[k] = JSON.parse(localStorage.getItem(k) ?? ''); }
      catch { result[k] = localStorage.getItem(k); }
    }
    return result;
  }).catch(() => ({}));
  console.log('\n--- localStorage after page load ---');
  for (const [k, v] of Object.entries(lsData)) {
    console.log(`  ${k}:`, JSON.stringify(v)?.slice(0, 300));
  }
  console.log('---\n');

  const result = await handleWalletPopups(page, walletAddress, DEFAULT_WALLET_POLICY, 'UI_FEATURE', 'test');
  console.log('\n--- Wallet connection log ---');
  result.log.forEach((l) => console.log('  ', l));
  console.log(`--- Connected: ${result.walletConnected} ---\n`);

  await snap(page, '02-after-connect');

  const postText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  console.log(`   Post-connect page text: "${postText.slice(0, 300).replace(/\n/g, ' ')}"`);

  // ── Check DOM for address ─────────────────────────────────────────────────
  const addrShort = walletAddress.slice(0, 6).toLowerCase();
  const hasAddr   = postText.toLowerCase().includes(addrShort);
  const noConnectBtn = !postText.toLowerCase().includes('connect wallet');

  console.log(`\n✅ Address in DOM:     ${hasAddr}`);
  console.log(`✅ "Connect Wallet" gone: ${noConnectBtn}`);
  console.log(`✅ walletConnected flag:  ${result.walletConnected}`);

  if (result.walletConnected || hasAddr || noConnectBtn) {
    console.log('\n🎉 WALLET CONNECTION SUCCESSFUL');
  } else {
    console.log('\n❌ WALLET CONNECTION FAILED');
    process.exitCode = 1;
  }

  await context.close();
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
