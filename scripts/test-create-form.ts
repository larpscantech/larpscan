/**
 * scripts/test-create-form.ts
 *
 * Inspect the actual input structure on the /create page after wallet connection
 * so we know what selectors/placeholders to use.
 *
 * Run: npx tsx scripts/test-create-form.ts
 */

import * as path from 'path';
import * as fs from 'fs';

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) { const k = m[1].trim(); if (!process.env[k]) process.env[k] = m[2].trim().replace(/^['"]|['"]$/g, ''); }
  }
}

import { chromium } from 'playwright';
import { exposeSigningBridge } from '../lib/wallet/signer';
import { handleWalletPopups, injectWalletMockIntoContext } from '../lib/browser-agent/executor';
import { DEFAULT_WALLET_POLICY } from '../lib/wallet/policy';

const PK_RAW = process.env.INVESTIGATION_WALLET_PRIVATE_KEY ?? '';
if (!PK_RAW) { console.error('No private key'); process.exit(1); }
const walletAddress = process.env.INVESTIGATION_WALLET_ADDRESS || '0x1B634B1AeFFf672F9250844D5C5262E7493596B1';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await exposeSigningBridge(context, crypto.randomUUID());
  await injectWalletMockIntoContext(context, walletAddress);

  const page = await context.newPage();
  page.on('console', (m) => { if (m.text().includes('[mock]') || m.text().includes('[signer]')) console.log('  PAGE:', m.text().slice(0, 120)); });

  await page.goto('https://bnbshare.fun/create', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_500);

  const r = await handleWalletPopups(page, walletAddress, DEFAULT_WALLET_POLICY, 'TOKEN_CREATION', 'recon', 0);
  console.log(`walletConnected: ${r.walletConnected}`);

  if (r.walletConnected) {
    await page.waitForTimeout(2_000);

    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, textarea, select')).map((el) => {
        const e = el as HTMLInputElement;
        return {
          tag:         el.tagName.toLowerCase(),
          type:        e.type || '',
          name:        e.name || '',
          id:          e.id || '',
          placeholder: e.placeholder || '',
          ariaLabel:   e.getAttribute('aria-label') || '',
          value:       e.value || '',
          disabled:    e.disabled,
          visible:     (el as HTMLElement).offsetParent !== null,
        };
      });
    });

    console.log('\n── Inputs after wallet connect ─────────────────────────────');
    inputs.filter(i => i.visible && i.type !== 'hidden').forEach((inp, idx) => {
      console.log(`  [${idx}] ${inp.tag}[type=${inp.type}] name="${inp.name}" id="${inp.id}" placeholder="${inp.placeholder}" aria="${inp.ariaLabel}"`);
    });

    // Try filling the first text input
    console.log('\n── Attempting to fill form ─────────────────────────────────');
    const visibleInputs = inputs.filter(i => i.visible && i.type !== 'hidden' && i.type !== 'submit' && i.type !== 'checkbox' && i.type !== 'radio');
    
    for (const inp of visibleInputs.slice(0, 5)) {
      try {
        const sel = inp.id ? `#${inp.id}` : inp.name ? `[name="${inp.name}"]` : inp.placeholder ? `[placeholder="${inp.placeholder}"]` : null;
        if (!sel) continue;
        const testVal = inp.placeholder.includes('ymbol') ? 'TST' : inp.placeholder.includes('ame') ? 'TestToken' : 'testvalue';
        await page.fill(sel, testVal);
        console.log(`  ✅ Filled ${sel} = "${testVal}"`);
      } catch (e: unknown) {
        console.log(`  ❌ Could not fill: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
      }
    }

    const screenshot = path.resolve(process.cwd(), 'scripts/privy-prod-screenshots/create-form-filled.png');
    await page.screenshot({ path: screenshot });
    console.log(`\n📸 ${screenshot}`);
  }

  await context.close();
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
