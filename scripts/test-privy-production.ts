/**
 * scripts/test-privy-production.ts
 *
 * Simulates exactly what lib/verifier.ts does for a TOKEN_CREATION claim
 * on bnbshare.fun — including navigating directly to /create first.
 *
 * Run: npx tsx scripts/test-privy-production.ts
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { bsc } from 'viem/chains';
import { exposeSigningBridge } from '../lib/wallet/signer';
import { handleWalletPopups, injectWalletMockIntoContext } from '../lib/browser-agent/executor';
import { DEFAULT_WALLET_POLICY } from '../lib/wallet/policy';

// ── Load .env.local ────────────────────────────────────────────────────────
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const PK_RAW = process.env.INVESTIGATION_WALLET_PRIVATE_KEY ?? '';
if (!PK_RAW) { console.error('No INVESTIGATION_WALLET_PRIVATE_KEY'); process.exit(1); }
const PK = (PK_RAW.startsWith('0x') ? PK_RAW : `0x${PK_RAW}`) as `0x${string}`;
const account = privateKeyToAccount(PK);
const walletAddress = account.address;

const SCREENSHOTS = path.resolve(process.cwd(), 'scripts/privy-prod-screenshots');
fs.mkdirSync(SCREENSHOTS, { recursive: true });
let step = 0;
async function snap(page: import('playwright').Page, label: string) {
  const file = path.join(SCREENSHOTS, `${String(step++).padStart(2,'0')}-${label.replace(/\W+/g,'-')}.png`);
  await page.screenshot({ path: file });
  console.log(`  📸 ${file}`);
}

async function testFromUrl(startUrl: string, label: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Testing from: ${startUrl} [${label}]`);
  console.log('─'.repeat(60));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    recordVideo: { dir: path.join(SCREENSHOTS, label), size: { width: 1280, height: 800 } },
  });

  // Exact same setup as lib/verifier.ts
  await exposeSigningBridge(context, crypto.randomUUID());
  await injectWalletMockIntoContext(context, walletAddress);

  const page = await context.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[mock]') || t.includes('[signer]') || t.includes('[wallet]')) {
      console.log(`  PAGE: ${t.slice(0, 150)}`);
    }
  });

  // Check ethereum presence
  async function checkEth() {
    return page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const e = w.ethereum as { isMetaMask?: boolean; request?: unknown } | undefined;
      return { present: !!e, isMetaMask: e?.isMetaMask, hasRequest: typeof e?.request === 'function' };
    }).catch(() => ({ present: false, isMetaMask: false, hasRequest: false }));
  }

  // Navigate to startUrl (like verifier does)
  console.log(`\n[1] goto ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_500);
  console.log(`  ethereum: ${JSON.stringify(await checkEth())}`);
  await snap(page, `${label}-01-loaded`);

  // Run handleWalletPopups (exactly like verifier.ts earlyWallet)
  console.log('\n[2] handleWalletPopups...');
  const result = await handleWalletPopups(page, walletAddress, DEFAULT_WALLET_POLICY, 'TOKEN_CREATION', 'recon', 0);
  console.log(`  walletConnected: ${result.walletConnected}`);
  result.log.forEach((l) => console.log(`    ${l}`));
  await snap(page, `${label}-02-after-wallet`);
  console.log(`  ethereum after wallet: ${JSON.stringify(await checkEth())}`);

  // Check form state
  const formInfo = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input, textarea, select').length;
    const connectBtnVisible = /connect wallet/i.test(document.body.innerText ?? '');
    const addrVisible = document.body.innerText?.includes('0x');
    return { inputs, connectBtnVisible, addrVisible };
  });
  console.log(`  Form after wallet attempt: inputs=${formInfo.inputs}, gated=${formInfo.connectBtnVisible}`);

  // If we didn't connect yet, try navigating to homepage first then back
  if (!result.walletConnected && startUrl.includes('/create')) {
    console.log('\n[3] Wallet not connected — trying homepage-first approach...');
    await page.goto('https://bnbshare.fun/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(2_000);
    
    const homeWallet = await handleWalletPopups(page, walletAddress, DEFAULT_WALLET_POLICY, 'TOKEN_CREATION', 'recon', 0);
    console.log(`  Home wallet connected: ${homeWallet.walletConnected}`);
    homeWallet.log.forEach((l) => console.log(`    ${l}`));

    if (homeWallet.walletConnected) {
      // Navigate to /create — session should persist
      await page.goto('https://bnbshare.fun/create', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(3_000);
      await snap(page, `${label}-03-create-after-home`);
      
      const createInfo = await page.evaluate(() => {
        const txt = document.body?.innerText ?? '';
        return {
          inputs: document.querySelectorAll('input, textarea').length,
          gated: /connect wallet/i.test(txt),
          addrInPage: txt.includes('0x1B63') || txt.includes('96B1'),
          textPreview: txt.slice(0, 300).replace(/\n/g, ' | '),
        };
      });
      console.log(`\n  /create after homepage connect:`);
      console.log(`    inputs=${createInfo.inputs}, gated=${createInfo.gated}, addr=${createInfo.addrInPage}`);
      console.log(`    text: "${createInfo.textPreview}"`);

      if (createInfo.inputs > 0 && !createInfo.gated) {
        console.log('\n  ✅ SUCCESS via homepage-first approach');
      } else {
        console.log('\n  ⚠️  Homepage-first did not unlock /create');
      }
    }
  }

  const videoPath = await page.video()?.path().catch(() => null);
  await context.close();
  await browser.close();
  if (videoPath) console.log(`  🎥 Video: ${videoPath}`);
}

(async () => {
  console.log(`\n🔍 Production simulation for bnbshare.fun TOKEN_CREATION`);
  console.log(`   Wallet: ${walletAddress}`);

  // Test 1: Navigate directly to /create (what the real verifier does)
  await testFromUrl('https://bnbshare.fun/create', 'direct-create');

  // Test 2: Navigate to homepage first (what works in our E2E test)
  await testFromUrl('https://bnbshare.fun/', 'homepage-first');

  console.log(`\nScreenshots: ${SCREENSHOTS}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
