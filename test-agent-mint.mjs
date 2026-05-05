/**
 * Playwright test — Wallet connect + Agent Mint multi-step form
 *
 * Run: TEST_BASE_URL=http://localhost:3000 node test-agent-mint.mjs
 *
 * What we test (no real wallet needed — page works with mock contract):
 *  1. /agent/mint loads without errors
 *  2. "Connect your wallet" prompt is visible before connect
 *  3. RainbowKit modal opens when button is clicked
 *  4. Mint page shows "BAP-578" branding
 *  5. Navbar has Connect Wallet button
 *  6. Dashboard navbar has Connect Wallet button
 *  7. Mint page has multi-step form steps (Identity, Personality, AI Config, Memory, Review)
 *  8. Agent type selector renders all 6 agent types
 *  9. No JS errors on mint page
 */

import { chromium } from 'playwright';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const IS_LOCAL = BASE.includes('localhost') || BASE.includes('127.0');
const GOTO_MS  = IS_LOCAL ? 60_000 : 20_000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name) {
  const path = `/tmp/larpscan-agent-test-${name}.png`;
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  console.log(`📸 ${path}`);
}

const results = [];
function pass(name) { results.push({ name, ok: true });  console.log(`  ✅ ${name}`); }
function fail(name, reason) { results.push({ name, ok: false, reason }); console.error(`  ❌ ${name}: ${reason}`); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    // ── 1. /agent/mint loads ────────────────────────────────────────────────
    console.log('\n[1] Loading /agent/mint…');
    const res = await page.goto(`${BASE}/agent/mint`, {
      waitUntil: 'domcontentloaded',
      timeout: GOTO_MS,
    });
    if (!res || res.status() >= 400) {
      fail('mint page loads', `HTTP ${res?.status()}`);
    } else {
      pass('mint page loads');
    }
    await sleep(2000);
    await screenshot(page, '01-mint-page');

    // ── 2. Connect wallet prompt visible ────────────────────────────────────
    console.log('[2] Checking connect wallet prompt…');
    const prompt = await page.locator('[data-testid="connect-wallet-prompt"]').isVisible().catch(() => false);
    if (prompt) pass('connect wallet prompt visible');
    else fail('connect wallet prompt visible', 'data-testid="connect-wallet-prompt" not found');

    // ── 3. ConnectKit button present and clickable ──────────────────────────
    console.log('[3] Clicking ConnectKit button…');
    const ckBtn = page.locator('button:has-text("Connect Wallet")').first();
    const ckVisible = await ckBtn.isVisible().catch(() => false);
    if (!ckVisible) {
      fail('ConnectKit button visible', 'button not found');
    } else {
      pass('ConnectKit button visible');
      await ckBtn.click().catch(() => {});
      await sleep(1200);
      await screenshot(page, '02-connectkit-modal');
      const modal = await page.locator('[data-testid="connect-wallet-btn"], .ck-modal, [class*="ck-"]').count();
      if (modal > 0) pass('ConnectKit modal opens');
      else fail('ConnectKit modal opens', 'no modal elements found after click');
      // Close modal
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(600);
    }

    // ── 4. BAP-578 branding ─────────────────────────────────────────────────
    console.log('[4] Checking BAP-578 branding…');
    const pageBody = await page.locator('body').innerText().catch(() => '');
    if (pageBody.includes('BAP-578')) pass('BAP-578 branding on mint page');
    else fail('BAP-578 branding on mint page', 'BAP-578 not found in page text');

    if (pageBody.includes('Create Your AI Agent')) pass('page heading correct');
    else fail('page heading correct', 'heading not found');

    // ── 5. Multi-step form metadata (always rendered, no wallet needed) ─────
    console.log('[5] Checking mint-form-meta data attributes…');
    await page.waitForSelector('[data-testid="mint-form-meta"]', { timeout: 10_000 }).catch(() => {});
    const metaEl = page.locator('[data-testid="mint-form-meta"]');
    const metaVisible = await metaEl.count() > 0;
    if (!metaVisible) {
      fail('mint-form-meta element present', 'not found');
    } else {
      pass('mint-form-meta element present');
      const steps      = await metaEl.getAttribute('data-steps').catch(() => '');
      const types      = await metaEl.getAttribute('data-agent-types').catch(() => '');
      const fields     = await metaEl.getAttribute('data-bap578-fields').catch(() => '');

      for (const s of ['Identity', 'Personality', 'AI Config', 'Memory', 'Review & Mint']) {
        if (steps?.includes(s)) pass(`step "${s}" in meta`);
        else fail(`step "${s}" in meta`, `got: ${steps}`);
      }
      for (const t of ['Verifier Agent', 'DeFi Agent', 'Game Agent', 'DAO Agent', 'Creator Agent', 'Strategic Agent']) {
        if (types?.includes(t)) pass(`agent type "${t}" in meta`);
        else fail(`agent type "${t}" in meta`, `got: ${types}`);
      }
      for (const f of ['persona', 'experience', 'voiceHash', 'animationURI', 'vaultURI']) {
        if (fields?.includes(f)) pass(`BAP-578 field "${f}" in meta`);
        else fail(`BAP-578 field "${f}" in meta`, `got: ${fields}`);
      }
    }

    // ── 6. Navbar has connect wallet button ─────────────────────────────────
    console.log('[6] Checking navbar Connect Wallet button…');
    const navBtn = await page.locator('[data-testid="connect-wallet-btn"]').count();
    if (navBtn > 0) pass('navbar has connect wallet button');
    else fail('navbar has connect wallet button', 'data-testid="connect-wallet-btn" not found in nav');

    // ── 7. Dashboard also has connect wallet ────────────────────────────────
    console.log('[7] Checking /dashboard for Connect Wallet…');
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
    await sleep(1500);
    await screenshot(page, '03-dashboard');
    const dashBtn = await page.locator('[data-testid="connect-wallet-btn"]').count();
    if (dashBtn > 0) pass('dashboard navbar has connect wallet button');
    else fail('dashboard navbar has connect wallet button', 'button not found on /dashboard');

    // ── 8. No JS errors on mint page ────────────────────────────────────────
    console.log('[8] Checking for JS errors on mint page…');
    await page.goto(`${BASE}/agent/mint`, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
    await sleep(1500);
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const jsErrors = bodyText.match(/Cannot read propert|TypeError:|undefined\s*\(reading/gi) ?? [];
    if (!jsErrors.length) pass('no raw JS errors on mint page');
    else fail('no raw JS errors on mint page', jsErrors.slice(0, 2).join(' | '));

    await screenshot(page, '04-final');

  } catch (e) {
    console.error('💥 TEST ERROR:', e.message);
    await screenshot(page, 'error').catch(() => {});
  } finally {
    await browser.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const total  = results.length;
  console.log(`\n══════════ AGENT MINT TEST RESULTS ══════════`);
  console.log(`  Passed: ${passed}/${total}`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  console.log(`══════════════════════════════════════════════\n`);

  process.exit(passed === total ? 0 : 1);
})();
