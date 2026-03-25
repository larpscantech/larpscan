/**
 * scripts/test-privy-flow.ts
 *
 * Investigates the exact Privy wallet-connect flow on bnbshare.fun.
 * Run: npx tsx scripts/test-privy-flow.ts
 *
 * This script:
 * 1. Launches a headed browser
 * 2. Injects our mock window.ethereum + signing bridge
 * 3. Clicks through every step of the Privy flow
 * 4. Captures a screenshot after every click
 * 5. Logs exactly what buttons appear at each step
 * 6. Reports whether personal_sign was called and responded to
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { bsc } from 'viem/chains';

// Load .env.local manually
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const PK_RAW = process.env.INVESTIGATION_WALLET_PRIVATE_KEY ?? '';
if (!PK_RAW) { console.error('No INVESTIGATION_WALLET_PRIVATE_KEY in .env.local'); process.exit(1); }
// Ensure 0x prefix
const PK = (PK_RAW.startsWith('0x') ? PK_RAW : `0x${PK_RAW}`) as `0x${string}`;

const account = privateKeyToAccount(PK);
const walletAddress = account.address;
const walletClient = createWalletClient({ account, chain: bsc, transport: http(process.env.NODEREAL_RPC) });

const SCREENSHOTS = path.resolve(process.cwd(), 'scripts/privy-screenshots');
fs.mkdirSync(SCREENSHOTS, { recursive: true });

let step = 0;
async function snap(page: import('playwright').Page, label: string) {
  const file = path.join(SCREENSHOTS, `${String(step++).padStart(2,'0')}-${label.replace(/\W+/g,'-')}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  📸 ${file}`);
}

async function dumpButtons(page: import('playwright').Page, context: string) {
  const btns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="button"], [role="option"]'))
      .filter((el) => {
        const s = window.getComputedStyle(el as Element);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })
      .map((el) => ({
        tag:  el.tagName.toLowerCase(),
        text: ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        cls:  (el as HTMLElement).className?.toString().slice(0, 60),
      }))
      .filter((b) => b.text.length > 0)
      .slice(0, 30);
  });
  console.log(`\n── Buttons visible [${context}] ──`);
  btns.forEach((b, i) => console.log(`  ${i}: <${b.tag}> "${b.text}" [${b.cls}]`));
  return btns;
}

async function dumpModals(page: import('playwright').Page) {
  const modals = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('dialog, [role="dialog"], [data-privy-dialog], [class*="privy"], [class*="modal"], [class*="Modal"]'))
      .filter((el) => {
        const s = window.getComputedStyle(el as Element);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })
      .map((el) => ({
        tag:  el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? '',
        cls:  (el as HTMLElement).className?.toString().slice(0, 80),
        text: ((el as HTMLElement).innerText ?? '').slice(0, 200),
      }));
  });
  console.log(`\n── Modals visible [${modals.length}] ──`);
  modals.forEach((m, i) => console.log(`  ${i}: <${m.tag}> role="${m.role}" cls="${m.cls}"\n     text: "${m.text.slice(0,100)}"`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Signing bridge (same safety guard as lib/wallet/signer.ts)
// ─────────────────────────────────────────────────────────────────────────────
const UNSAFE = [/transfer/i, /approve/i, /spend/i, /amount/i, /recipient/i];
function isSafe(raw: string): boolean {
  let decoded = raw;
  if (raw.startsWith('0x')) { try { decoded = Buffer.from(raw.slice(2), 'hex').toString('utf8'); } catch { /* keep */ } }
  return !UNSAFE.some((r) => r.test(decoded));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock window.ethereum (mirrors lib/browser-agent/executor.ts addInitScript)
// ─────────────────────────────────────────────────────────────────────────────
function getMockScript(addr: string): string {
  return `
(function() {
  if (window.__chainverifyInjected) return;
  window.__chainverifyInjected = true;
  const addr = "${addr}";
  const listeners = {};
  const mock = {
    isMetaMask: true,
    selectedAddress: addr,
    chainId: '0x38',
    networkVersion: '56',
    isConnected: () => true,
    on(evt, cb) { listeners[evt] = listeners[evt] || []; listeners[evt].push(cb); return this; },
    removeListener(evt, cb) { if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== cb); return this; },
    request: async function(req) {
      const m = req.method; const p = req.params || [];
      console.log('[mock] request:', m, JSON.stringify(p).slice(0,120));
      if (m === 'eth_accounts' || m === 'eth_requestAccounts') {
        setTimeout(() => {
          (listeners['accountsChanged']||[]).forEach(cb => cb([addr]));
          (listeners['connect']||[]).forEach(cb => cb({ chainId: '0x38' }));
        }, 50);
        return [addr];
      }
      if (m === 'eth_chainId')     return '0x38';
      if (m === 'net_version')     return '56';
      if (m === 'eth_blockNumber') return '0x1000000';
      if (m === 'eth_getBalance')  return '0x38D7EA4C68000';
      if (m === 'eth_gasPrice')    return '0x3B9ACA00';
      if (m === 'eth_estimateGas') return '0x5208';
      if (m === 'eth_getCode')     return '0x';
      if (m === 'eth_call')        return '0x';
      if (m === 'wallet_switchEthereumChain') return null;
      if (m === 'wallet_addEthereumChain')    return null;
      if (m === 'personal_sign' || m === 'eth_sign') {
        console.log('[mock] personal_sign requested — calling window.chainverifySign');
        if (typeof window.chainverifySign !== 'function') {
          console.error('[mock] window.chainverifySign NOT available!');
          throw Object.assign(new Error('No signing bridge'), { code: 4001 });
        }
        try {
          const sig = await window.chainverifySign(m, JSON.stringify(p));
          console.log('[mock] personal_sign SUCCESS →', sig.slice(0,20) + '...');
          return sig;
        } catch(e) {
          console.error('[mock] personal_sign ERROR:', e.message);
          throw Object.assign(new Error(e.message), { code: 4001 });
        }
      }
      if (m === 'eth_sendTransaction') throw Object.assign(new Error('Transactions disabled'), { code: 4001 });
      return null;
    },
    enable: async function() { return this.request({ method: 'eth_requestAccounts' }); },
  };
  Object.defineProperty(window, 'ethereum', { value: mock, writable: true, configurable: true });
  // EIP-6963
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: { info: { uuid: 'chainverify-mock', name: 'ChainVerify', icon: '', rdns: 'io.chainverify' }, provider: mock }
  }));
  console.log('[mock] window.ethereum injected for', addr);
})();
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n🔍 Testing Privy flow on bnbshare.fun`);
  console.log(`   Wallet: ${walletAddress}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Expose signing bridge BEFORE any page is created
  await context.exposeFunction('chainverifySign', async (method: string, paramsJson: string) => {
    const params: unknown[] = JSON.parse(paramsJson);
    console.log(`\n[signer] ${method} called — params:`, JSON.stringify(params).slice(0, 200));
    if (method === 'personal_sign' || method === 'eth_sign') {
      const msgHex = method === 'personal_sign' ? params[0] as string : params[1] as string;
      if (!isSafe(msgHex)) { throw Object.assign(new Error('Unsafe message refused'), { code: 4001 }); }
      const sig = await walletClient.signMessage({ account, message: { raw: msgHex as `0x${string}` } });
      console.log(`[signer] Signed → ${sig.slice(0, 20)}...`);
      return sig;
    }
    throw Object.assign(new Error(`Method ${method} not supported`), { code: 4200 });
  });

  await context.addInitScript(getMockScript(walletAddress));

  // Intercept console logs from page
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.text().includes('[mock]') || msg.text().includes('[signer]')) {
      console.log(`  PAGE: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => console.log(`  PAGE ERROR: ${err.message}`));

  // ── Step 0: Load homepage ──────────────────────────────────────────────────
  console.log('\n[1] Navigating to bnbshare.fun...');
  await page.goto('https://bnbshare.fun/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await snap(page, 'homepage');
  await dumpButtons(page, 'homepage');

  // ── Step 1: Find and click "Connect Wallet" ────────────────────────────────
  console.log('\n[2] Looking for Connect Wallet button...');
  
  // Try multiple selectors
  const connectSelectors = [
    'button:has-text("Connect Wallet")',
    'button:has-text("Connect")',
    '[role="button"]:has-text("Connect Wallet")',
    '[role="button"]:has-text("Connect")',
    'button:text-is("Connect Wallet")',
    'button:text-is("Connect")',
  ];

  let clicked = false;
  for (const sel of connectSelectors) {
    const el = page.locator(sel).first();
    const vis = await el.isVisible({ timeout: 1_000 }).catch(() => false);
    if (vis) {
      const t = await el.textContent().catch(() => '');
      console.log(`  Found: "${t?.trim()}" via selector "${sel}"`);
      await el.click().catch((e) => console.log(`  Click error: ${e.message}`));
      clicked = true;
      break;
    }
  }
  
  if (!clicked) {
    console.log('  ⚠️  No "Connect Wallet" button found — trying all buttons');
    await dumpButtons(page, 'no-connect-btn');
  } else {
    console.log('  ✓ Clicked Connect Wallet');
  }

  await page.waitForTimeout(2_000);
  await snap(page, 'after-connect-click');
  await dumpModals(page);
  await dumpButtons(page, 'after-connect-click');

  // ── Step 2: Look for "Continue with a wallet" in Privy modal ──────────────
  console.log('\n[3] Looking for "Continue with a wallet" / wallet option in Privy modal...');

  const privyWalletSelectors = [
    'button:has-text("Continue with a wallet")',
    'button:has-text("Continue with wallet")',
    '[role="button"]:has-text("Continue with a wallet")',
    'button:has-text("Wallet")',
    '[data-privy-dialog] button:last-child',
    '[class*="privy"] button:last-child',
  ];

  let step2Clicked = false;
  for (const sel of privyWalletSelectors) {
    const el = page.locator(sel).first();
    const vis = await el.isVisible({ timeout: 1_000 }).catch(() => false);
    if (vis) {
      const t = await el.textContent().catch(() => '');
      console.log(`  Found Privy wallet option: "${t?.trim()}" via "${sel}"`);
      await el.click().catch((e) => console.log(`  Click error: ${e.message}`));
      step2Clicked = true;
      break;
    }
  }

  if (!step2Clicked) {
    console.log('  ⚠️  No "Continue with a wallet" found — check screenshot');
    // Try getting the text of all visible buttons to see what Privy shows
    await dumpButtons(page, 'privy-modal-options');
  }

  await page.waitForTimeout(2_000);
  await snap(page, 'after-privy-wallet-option');
  await dumpModals(page);
  await dumpButtons(page, 'after-privy-wallet-option');

  // ── Step 3: Look for MetaMask / Injected in wallet picker ─────────────────
  console.log('\n[4] Looking for MetaMask/Injected wallet picker...');

  const walletPickerSelectors = [
    'button:has-text("MetaMask")',
    '[role="button"]:has-text("MetaMask")',
    'button:has-text("Injected")',
    'button:has-text("Browser Wallet")',
    'button:has-text("Detected")',
    '[role="option"]:has-text("MetaMask")',
  ];

  let step3Clicked = false;
  for (const sel of walletPickerSelectors) {
    const el = page.locator(sel).first();
    const vis = await el.isVisible({ timeout: 1_000 }).catch(() => false);
    if (vis) {
      const t = await el.textContent().catch(() => '');
      console.log(`  Found wallet picker: "${t?.trim()}" via "${sel}"`);
      await el.click().catch((e) => console.log(`  Click error: ${e.message}`));
      step3Clicked = true;
      break;
    }
  }

  if (!step3Clicked) {
    console.log('  ⚠️  No MetaMask/Injected option found');
    await dumpButtons(page, 'wallet-picker');
  }

  // Wait for personal_sign and Privy auth
  console.log('\n[5] Waiting for Privy backend to validate signature...');
  await page.waitForTimeout(5_000);
  await snap(page, 'after-wallet-pick');
  await dumpButtons(page, 'after-wallet-pick');

  // ── Check final state ──────────────────────────────────────────────────────
  console.log('\n[6] Checking connection state...');
  const short = walletAddress.slice(0, 6).toLowerCase();
  const end   = walletAddress.slice(-4).toLowerCase();
  const pageText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  
  const addrVisible = pageText.toLowerCase().includes(short) || pageText.toLowerCase().includes(end);
  const noConnectBtn = !pageText.toLowerCase().includes('connect wallet');

  console.log(`  Address fragment visible: ${addrVisible}`);
  console.log(`  "Connect Wallet" gone:    ${noConnectBtn}`);
  console.log(`  → Wallet connected: ${addrVisible || noConnectBtn}`);

  // ── Navigate to /create and check for unlocked form ────────────────────────
  console.log('\n[7] Navigating to /create...');
  await page.goto('https://bnbshare.fun/create', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(3_000);
  await snap(page, 'create-page');
  await dumpButtons(page, 'create-page');

  const createText = await page.evaluate(() => document.body?.innerText ?? '');
  console.log(`\n  Create page text preview: "${createText.slice(0, 300).replace(/\n/g, '|')}"`);

  const hasForm = await page.evaluate(() => document.querySelectorAll('input, textarea').length > 0);
  const hasConnectWalletOnCreate = /connect wallet/i.test(createText);
  console.log(`  Form inputs: ${hasForm}, Still gated: ${hasConnectWalletOnCreate}`);

  await snap(page, 'final-state');
  await browser.close();

  console.log('\n─────────────────────────────────────────────');
  console.log(`Screenshots saved to: ${SCREENSHOTS}`);
  console.log('─────────────────────────────────────────────\n');
})();
