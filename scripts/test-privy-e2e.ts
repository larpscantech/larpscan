/**
 * scripts/test-privy-e2e.ts
 *
 * End-to-end test of the updated handleWalletPopups + signing bridge
 * against bnbshare.fun TOKEN_CREATION claim.
 *
 * Exercises the same code path as lib/verifier.ts does during a real scan.
 * Run: npx tsx scripts/test-privy-e2e.ts
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { bsc } from 'viem/chains';

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
const walletClient = createWalletClient({ account, chain: bsc, transport: http(process.env.NODEREAL_RPC) });

const SCREENSHOTS = path.resolve(process.cwd(), 'scripts/privy-e2e-screenshots');
fs.mkdirSync(SCREENSHOTS, { recursive: true });
let step = 0;
async function snap(page: import('playwright').Page, label: string) {
  const file = path.join(SCREENSHOTS, `${String(step++).padStart(2,'0')}-${label.replace(/\W+/g,'-')}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  📸 ${file}`);
}

// ── Signing safety guard ───────────────────────────────────────────────────
const UNSAFE = [/transfer/i, /approve/i, /spend/i, /amount/i, /recipient/i];
function isSafe(raw: string): boolean {
  let decoded = raw;
  if (raw.startsWith('0x')) { try { decoded = Buffer.from(raw.slice(2), 'hex').toString('utf8'); } catch { /* keep */ } }
  return !UNSAFE.some((r) => r.test(decoded));
}

// ── Import and use the SAME functions as lib/verifier.ts does ─────────────
// We replicate the exact context setup so this test reflects production.
async function runE2ETest() {
  console.log('\n🔍 E2E: Testing updated handleWalletPopups with signing bridge');
  console.log(`   Wallet: ${walletAddress}\n`);

  const { handleWalletPopups, injectWalletMockIntoContext } = await import('../lib/browser-agent/executor.js').catch(async () => {
    // fallback: use ts-node path
    return await import('../lib/browser-agent/executor.js');
  });

  const { DEFAULT_WALLET_POLICY } = await import('../lib/wallet/policy.js').catch(async () => {
    return await import('../lib/wallet/policy.js');
  });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // ── Install signing bridge (same as lib/wallet/signer.ts) ────────────────
  await context.exposeFunction('chainverifySign', async (method: string, paramsJson: string) => {
    const params: unknown[] = JSON.parse(paramsJson);
    console.log(`\n  [signer] ${method} — signing...`);
    const msgHex = method === 'personal_sign' ? params[0] as string : params[1] as string;
    if (!isSafe(msgHex)) throw Object.assign(new Error('Unsafe'), { code: 4001 });
    const sig = await walletClient.signMessage({ account, message: { raw: msgHex as `0x${string}` } });
    console.log(`  [signer] ✓ signed → ${sig.slice(0, 20)}...`);
    return sig;
  });

  // ── Inject mock window.ethereum (same as lib/browser-agent/executor.ts) ──
  await injectWalletMockIntoContext(context, walletAddress);

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.text().includes('[mock]') || msg.text().includes('[wallet]')) {
      console.log(`  PAGE: ${msg.text().slice(0, 120)}`);
    }
  });

  // ── Navigate to bnbshare.fun ───────────────────────────────────────────────
  console.log('[1] Loading bnbshare.fun...');
  await page.goto('https://bnbshare.fun/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await snap(page, 'initial');

  // ── Checkpoint: is ethereum available after page load? ────────────────────
  const ethAfterLoad = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const eth = w.ethereum as { isMetaMask?: boolean; request?: unknown } | undefined;
    return {
      present: !!eth,
      isMetaMask: eth?.isMetaMask,
      hasRequest: typeof eth?.request === 'function',
    };
  }).catch(() => ({ present: false, isMetaMask: false, hasRequest: false }));
  console.log(`  ethereum after page load: ${JSON.stringify(ethAfterLoad)}`);

  // ── Manual flow to debug wallet picker ───────────────────────────────────
  console.log('\n[2a] Clicking Connect Wallet manually...');
  const connectBtn = page.locator('button, [role="button"]').filter({ hasText: /^connect wallet$|^connect$/i }).first();
  if (await connectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await connectBtn.click();
    await page.waitForTimeout(1500);
  }

  // Check ethereum right after clicking "Connect Wallet"
  const ethAfterConnect = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const eth = w.ethereum as { isMetaMask?: boolean } | undefined;
    return { present: !!eth, isMetaMask: eth?.isMetaMask };
  }).catch(() => ({ present: false, isMetaMask: false }));
  console.log(`  ethereum after Connect Wallet click: ${JSON.stringify(ethAfterConnect)}`);

  // Click "Continue with a wallet" in Privy social modal
  const continueBtn = page.locator('button').filter({ hasText: /continue with a wallet/i }).first();
  if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await continueBtn.click();
    console.log('[2a] Clicked "Continue with a wallet"');
    await page.waitForTimeout(3000); // extra wait for Privy to detect injected wallet
  }

  // Check ethereum after "Continue with a wallet"
  const ethAfterContinue = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const eth = w.ethereum as { isMetaMask?: boolean } | undefined;
    return { present: !!eth, isMetaMask: eth?.isMetaMask };
  }).catch(() => ({ present: false, isMetaMask: false }));
  console.log(`  ethereum after "Continue with a wallet" click: ${JSON.stringify(ethAfterContinue)}`);

  // Dump ALL buttons in the wallet picker
  const pickerBtns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="button"], [role="option"]'))
      .filter((el) => {
        const s = window.getComputedStyle(el as Element);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })
      .map((el, i) => ({
        i,
        text: ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        cls:  (el as HTMLElement).className?.toString().slice(0, 80),
        id:   (el as HTMLElement).id,
      }));
  });
  console.log('\n── Full wallet picker buttons ──');
  pickerBtns.forEach((b) => console.log(`  ${b.i}: "${b.text}" [${b.cls}]`));
  await snap(page, 'wallet-picker-open');

  // Try clicking buttons that DON'T open QR codes
  // Strategy: skip MetaMask (WalletConnect), look for "Injected" or other EIP-6963 detected options
  // Or try page.evaluate to directly trigger eth_requestAccounts
  console.log('\n[2b] Checking window.ethereum state + triggering directly...');
  const triggerResult = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown> & { ethereum?: { request: (r: { method: string; params?: unknown[] }) => Promise<unknown>; isMetaMask?: boolean } };
    const ethState = {
      present: !!w.ethereum,
      isMetaMask: w.ethereum?.isMetaMask,
      hasRequest: typeof w.ethereum?.request === 'function',
      hasChainverifySign: typeof (w as Record<string, unknown>).chainverifySign === 'function',
    };
    console.log('[test] window.ethereum state:', JSON.stringify(ethState));
    if (!w.ethereum) return `no ethereum (state: ${JSON.stringify(ethState)})`;
    try {
      const accounts = await w.ethereum.request({ method: 'eth_requestAccounts' });
      return `accounts: ${JSON.stringify(accounts)}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  });
  console.log(`  Direct trigger result: ${triggerResult}`);
  await page.waitForTimeout(6000); // wait for Privy to detect and call personal_sign
  await snap(page, 'after-direct-trigger');

  // Check if Privy connected
  const directConnected = await page.evaluate(
    ({ short, end }: { short: string; end: string }) => {
      const text = document.body?.innerText?.toLowerCase() ?? '';
      return text.includes(short) || text.includes(end);
    },
    { short: walletAddress.slice(0, 6).toLowerCase(), end: walletAddress.slice(-4).toLowerCase() },
  ).catch(() => false);
  console.log(`  Direct trigger connected: ${directConnected}`);

  // ── Run handleWalletPopups (same call as verifier.ts) ─────────────────────
  // Also test the updated flow
  console.log('\n[2] Running handleWalletPopups...');
  const result = await handleWalletPopups(
    page,
    walletAddress,
    DEFAULT_WALLET_POLICY,
    'TOKEN_CREATION',
    'execution',
    0,
  );

  console.log(`\n  walletConnected: ${result.walletConnected}`);
  console.log(`  detectedRequests: ${result.detectedRequests.length}`);
  console.log(`  rejectedRequests: ${result.rejectedRequests.length}`);
  console.log('  Wallet log:');
  result.log.forEach((l) => console.log(`    ${l}`));

  await snap(page, 'after-wallet-connect');

  // ── Navigate to /create and verify form is unlocked ───────────────────────
  console.log('\n[3] Navigating to /create...');
  await page.goto('https://bnbshare.fun/create', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(3_000);
  await snap(page, 'create-page');

  const createText = await page.evaluate(() => document.body?.innerText ?? '');
  const inputCount = await page.evaluate(() => document.querySelectorAll('input, textarea').length);
  const isGated = /connect wallet/i.test(createText);

  console.log(`\n  /create form inputs: ${inputCount}`);
  console.log(`  Still gated by "Connect Wallet": ${isGated}`);
  console.log(`  Address in page: ${createText.toLowerCase().includes(walletAddress.slice(0, 6).toLowerCase())}`);
  console.log(`  Text preview: "${createText.slice(0, 300).replace(/\n/g, ' | ')}"`);

  if (inputCount > 0 && !isGated) {
    console.log('\n✅ SUCCESS: Wallet connected, /create form unlocked, TOKEN_CREATION is VERIFIABLE');
  } else if (result.walletConnected) {
    console.log('\n⚠️  Wallet connected but /create still gated — check screenshot');
  } else {
    console.log('\n❌ FAIL: Wallet connection failed');
  }

  await snap(page, 'final');
  await browser.close();
  console.log(`\nScreenshots: ${SCREENSHOTS}\n`);
}

runE2ETest().catch((e) => { console.error(e); process.exit(1); });
