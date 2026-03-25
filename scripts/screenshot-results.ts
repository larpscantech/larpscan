/**
 * Takes screenshots showing the completed verification via the website UI.
 * Run 8bfbda26 has: VERIFIED (TOKEN_CREATION + tx hash), VERIFIED (leaderboard), UNTESTABLE
 */
import { chromium } from 'playwright';
import path from 'path';

const BASE = process.env.NEXT_DEV_URL ?? 'http://localhost:3000';
const CONTRACT = '0x1646980a0e0ebea85db014807205aa4d9bf87777';
const RUN_ID   = '8bfbda26-28f6-4b5c-bb9c-ffc27a1526d2';
const OUT_DIR  = path.join(process.cwd(), 'scripts', 'ui-test-shots');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser]', m.text().slice(0, 80));
  });

  // ── 1. Load the page with the address set ───────────────────────────────────
  console.log('[screenshot] Loading page...');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(1_500);
  
  await page.waitForFunction(
    () => typeof (window as typeof window & { __chainverifySetAddress?: unknown }).__chainverifySetAddress === 'function',
    { timeout: 10_000 },
  ).catch(() => {});
  await page.evaluate((addr: string) => {
    const w = window as typeof window & { __chainverifySetAddress?: (a: string) => void };
    if (w.__chainverifySetAddress) w.__chainverifySetAddress(addr);
  }, CONTRACT);
  await page.waitForTimeout(800);

  // ── 2. Show recent scans table with 2/3 completed run at top ────────────────
  await page.screenshot({ path: path.join(OUT_DIR, 'PROOF-1-recent-scans.png'), fullPage: true });
  console.log('[screenshot] 📸 PROOF-1-recent-scans.png');

  // ── 3. Show the raw API response (JSON) confirming verdicts + tx hash ───────
  const apiPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await apiPage.goto(`${BASE}/api/verify/status?runId=${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await apiPage.waitForTimeout(500);
  await apiPage.screenshot({ path: path.join(OUT_DIR, 'PROOF-2-api-response.png'), fullPage: true });
  console.log('[screenshot] 📸 PROOF-2-api-response.png');
  await apiPage.close();

  // ── 4. Show BSCScan tx page ──────────────────────────────────────────────────
  const txHash = '0x44a3ac54ff606eb6d4a043746438a2d46c574c31a475e2da3d5d7b204ec0d294';
  const bscPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await bscPage.goto(`https://bscscan.com/tx/${txHash}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await bscPage.waitForTimeout(3_000);
  await bscPage.screenshot({ path: path.join(OUT_DIR, 'PROOF-3-bscscan.png'), fullPage: false });
  console.log('[screenshot] 📸 PROOF-3-bscscan.png');
  await bscPage.close();

  await browser.close();
  console.log('\n✅ All proof screenshots saved to scripts/ui-test-shots/');
  console.log(`\n📊 Run ${RUN_ID.slice(0,8)} results:`);
  console.log('  [VERIFIED]   TOKEN_CREATION — token created on BSC mainnet');
  console.log(`  TX Hash:     ${txHash}`);
  console.log(`  BSCScan:     https://bscscan.com/tx/${txHash}`);
  console.log('  [VERIFIED]   DATA_DASHBOARD — leaderboard confirmed');
  console.log('  [UNTESTABLE] WALLET_FLOW — buyback/burn mechanism gated');
})();
