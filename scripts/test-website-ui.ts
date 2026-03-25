/**
 * scripts/test-website-ui.ts
 *
 * Playwright test that drives the actual ChainVerify WEBSITE UI:
 *   - Opens http://localhost:3000
 *   - Uses window.__chainverifySetAddress to set the React state directly
 *   - Clicks VERIFY
 *   - Polls until the run completes
 *   - Takes screenshots and captures verdicts
 *
 * Run: npx tsx scripts/test-website-ui.ts
 */

import * as path from 'path';
import * as fs   from 'fs';

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) {
      const k = m[1].trim();
      if (!process.env[k]) process.env[k] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

import { chromium } from 'playwright';

const BASE        = process.env.NEXT_DEV_URL ?? 'http://localhost:3000';
const CONTRACT    = '0x1646980a0e0ebea85db014807205aa4d9bf87777';
const SHOTS_DIR   = path.resolve(process.cwd(), 'scripts/ui-test-shots');
const MAX_WAIT_MS = 600_000; // 10 minutes

fs.mkdirSync(SHOTS_DIR, { recursive: true });

let sc = 0;
async function snap(page: import('playwright').Page, label: string) {
  const f = path.join(SHOTS_DIR, `${String(sc++).padStart(2,'0')}-${label}.png`);
  await page.screenshot({ path: f, fullPage: true });
  console.log(`  📸 ${path.basename(f)}`);
}

async function main() {
  console.log('\n🖥️  ChainVerify UI Test (Playwright)\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: SHOTS_DIR, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  page.on('pageerror', (e) => console.error('  PAGE:', e.message.slice(0, 100)));

  // Capture run ID by intercepting verify/start response
  let runId: string | null = null;
  page.on('response', async (resp) => {
    if (resp.url().includes('/api/verify/start') && resp.status() === 200) {
      try {
        const json = await resp.json().catch(() => ({})) as { runId?: string };
        if (json.runId) {
          runId = json.runId;
          console.log(`    🆔 Run ID captured: ${runId}`);
        }
      } catch { /* ignore */ }
    }
  });

  // ── 1. Load page ────────────────────────────────────────────────────────────
  console.log('[1] Loading website...');
  // Must use networkidle so React 18 fully hydrates before we interact
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await snap(page, 'loaded');
  console.log(`    URL: ${page.url()}  Title: "${await page.title()}"`);

  // ── 2. Set address via React test hook ─────────────────────────────────────
  console.log('\n[2] Setting contract address via test hook...');

  // Wait for the hook to be available (React must hydrate first)
  await page.waitForFunction(
    () => typeof (window as unknown as { __chainverifySetAddress?: unknown }).__chainverifySetAddress === 'function',
    { timeout: 15_000 },
  ).catch(() => console.warn('    ⚠️  Test hook not found — will try native fill fallback'));

  await page.evaluate((addr: string) => {
    const w = window as unknown as { __chainverifySetAddress?: (a: string) => void };
    if (w.__chainverifySetAddress) {
      w.__chainverifySetAddress(addr);
      console.log('[test] Set address via hook');
    } else {
      console.warn('[test] Hook not available');
    }
  }, CONTRACT);
  // Wait for React to re-render (state update is async in concurrent mode)
  await page.waitForTimeout(1_500);

  await snap(page, 'address-set');

  // ── 3. Click Verify ──────────────────────────────────────────────────────────
  console.log('\n[3] Clicking Verify...');

  // Find the enabled Verify button (it contains "Verify" + an ArrowRight icon)
  // Wait up to 5s polling for a non-disabled button that contains "Verify"
  let clicked = false;
  for (let i = 0; i < 10 && !clicked; i++) {
    // Find any non-disabled button whose text includes "Verify"
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map((b, idx) => ({
        idx,
        text: (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
        disabled: (b as HTMLButtonElement).disabled,
      })),
    );
    const verifyBtnInfo = btns.find((b) => /verify/i.test(b.text) && !b.disabled);
    console.log(`    Buttons[${i}]:`, JSON.stringify(btns.slice(0, 5)));
    if (verifyBtnInfo) {
      // Click by index
      await page.evaluate((idx) => {
        (document.querySelectorAll('button')[idx] as HTMLButtonElement).click();
      }, verifyBtnInfo.idx);
      console.log(`    ✅ Clicked Verify button (idx ${verifyBtnInfo.idx})`);
      clicked = true;
    } else {
      await page.waitForTimeout(600);
    }
  }
  if (!clicked) {
    console.warn('    ⚠️  No enabled Verify button found after 6s — pressing Enter');
    await page.locator('input').first().press('Enter');
  }
  await page.waitForTimeout(2_000);
  await snap(page, 'verification-started');

  // ── 4. Watch for pipeline progress ──────────────────────────────────────────
  console.log('\n[4] Waiting for verification to complete...\n');
  const startMs = Date.now();

  // Poll status until done
  let done = false;
  let lastLogCount = 0;
  while (!done && Date.now() - startMs < MAX_WAIT_MS) {
    await page.waitForTimeout(4_000);

    if (runId) {
      try {
        const r = await fetch(`${BASE}/api/verify/status?runId=${runId}`).then((r) => r.json()) as {
          run?: { status?: string };
          logs?: Array<{ message: string }>;
          claims?: Array<{ claim: string; status: string; evidence_items?: Array<{ data?: { verdict?: string; transactionHash?: string; transactionExplorerUrl?: string } }> }>;
        };
        const logs = r.logs ?? [];
        for (const log of logs.slice(lastLogCount)) {
          const m = log.message;
          const isTx = /bscscan|0x[0-9a-f]{60}/i.test(m);
          const isVerdict = /verdict/i.test(m);
          console.log(`  ${isTx ? '🔗' : isVerdict ? '📋' : '→'} ${m}`);
        }
        lastLogCount = logs.length;
        if (r.run?.status === 'complete' || r.run?.status === 'failed') {
          done = true;
          console.log(`\n  ✅ Run ${r.run.status.toUpperCase()}\n`);
          for (const c of r.claims ?? []) {
            const ev = c.evidence_items?.[0]?.data;
            const v = ev?.verdict ?? c.status;
            const color = v === 'verified' ? '\x1b[32m' : v === 'larp' ? '\x1b[31m' : '\x1b[2m';
            console.log(`  ${color}${v.toUpperCase()}\x1b[0m  "${c.claim.slice(0,70)}"`);
            if (ev?.transactionHash) {
              console.log(`  🔗 TX: ${ev.transactionHash}`);
              console.log(`  🔗 ${ev.transactionExplorerUrl}`);
            }
          }
        }
      } catch { /* continue */ }
    }

    // Also check page for VERIFIED/LARP text as fallback
    if (!done) {
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (/verification run complete|run complete/i.test(text)) {
        done = true;
        await snap(page, 'complete');
      } else {
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        process.stdout.write(`\r  ⏳ ${elapsed}s...`);
      }
    }
  }

  // ── 5. Final screenshot ──────────────────────────────────────────────────────
  console.log('\n\n[5] Final screenshot...');
  await snap(page, 'final');

  const vid = await page.video()?.path().catch(() => null);
  await context.close();
  await browser.close();

  console.log(`\n📸 Screenshots: ${SHOTS_DIR}`);
  if (vid) console.log(`🎥 Video: ${vid}`);
}

main().catch((e) => {
  console.error('\n❌ UI Test failed:', e.message);
  process.exit(1);
});
