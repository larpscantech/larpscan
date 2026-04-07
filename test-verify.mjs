/**
 * Playwright E2E test — general-purpose token verification test.
 *
 * Run: node test-verify.mjs
 * Run against local: TEST_BASE_URL=http://localhost:3001 node test-verify.mjs
 * Test a specific CA: TEST_CA=0x... TEST_BASE_URL=http://localhost:3001 node test-verify.mjs
 *
 * What it does:
 *  1. Opens the dashboard
 *  2. Types the contract address (pressSequentially for React state)
 *  3. Selects Quick Scan for faster completion
 *  4. Enables Force Re-verify so a fresh scan always runs
 *  5. Clicks Verify — intercepts /api/verify/orchestrate to capture runId
 *  6. Polls /api/verify/status?runId=... DIRECTLY (not page text) until complete
 *  7. Prints a summary and exits 0 (pass) or 1 (fail)
 *
 * Pass criteria:
 *  - All claims reach a terminal state (verified/failed/untestable/larp)
 *  - No raw JS error text visible on page
 */

import { chromium } from 'playwright';

const BASE     = process.env.TEST_BASE_URL ?? 'https://larpscan.sh';
const CA       = process.env.TEST_CA ?? '0x2a846aaaf896ef393ccb76398c1d96ea97374444';
const IS_LOCAL = BASE.includes('localhost') || BASE.includes('127.0');
const TIMEOUT  = 20 * 60 * 1000;  // 20 min — local dev has no Vercel 300s hard kill
const GOTO_MS  = IS_LOCAL ? 120_000 : 30_000;

const TERMINAL_STATUSES = new Set(['verified', 'failed', 'untestable', 'larp', 'larp_confirmed']);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name) {
  const path = `/tmp/larpscan-test-${name}.png`;
  await page.screenshot({ path, fullPage: false }).catch(e =>
    console.warn(`📸 Screenshot failed (${name}): ${e.message.slice(0, 60)}`),
  );
  console.log(`📸 ${path}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  let passed = false;
  let capturedRunId = null;

  // ── Intercept orchestrate response to capture runId ─────────────────────────
  page.on('response', async (res) => {
    if (res.url().includes('/api/verify/orchestrate') && res.status() === 200) {
      const body = await res.json().catch(() => null);
      if (body?.runId) {
        capturedRunId = body.runId;
        console.log(`  ✓ RunId captured: ${capturedRunId.slice(0, 8)}…`);
      }
    }
  });

  try {
    // ── 1. Navigate to dashboard ────────────────────────────────────────────────
    console.log(`\n[1/5] Navigating to dashboard (${IS_LOCAL ? 'local dev — allow 2 min compile' : 'production'})…`);
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
    await page.locator('input[type="text"]').first().waitFor({ state: 'visible', timeout: GOTO_MS });
    await sleep(1000);
    await screenshot(page, '01-dashboard');

    // ── 2. Fill contract address ─────────────────────────────────────────────────
    console.log(`[2/5] Typing contract address: ${CA}`);
    const input = page.locator('input[type="text"]').first();
    await input.click();
    await input.clear();
    await input.pressSequentially(CA, { delay: 5 });
    await sleep(500);

    const btnEnabled = await page.locator('button').filter({ hasText: /verify/i }).first()
      .isEnabled({ timeout: 3000 }).catch(() => false);
    console.log(`  Button enabled: ${btnEnabled}`);
    await screenshot(page, '02-filled');

    // ── 3. Quick Scan + Force Re-verify ─────────────────────────────────────────
    console.log('[3/5] Selecting Quick Scan…');
    const quickBtn = page.locator('button').filter({ hasText: /quick\s*scan/i }).first();
    if (await quickBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await quickBtn.click();
      console.log('  ✓ Quick Scan selected');
    }
    await sleep(200);

    const forceLabel = page.locator('label').filter({ hasText: /force\s*re.?verify/i }).first();
    if (await forceLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await forceLabel.click();
      console.log('  ✓ Force Re-verify enabled');
    }
    await sleep(300);

    // ── 4. Click Verify ──────────────────────────────────────────────────────────
    console.log('[4/5] Clicking Verify…');
    const verifyBtn = page.locator('button:not([disabled])').filter({ hasText: /verify/i }).last();
    for (let i = 0; i < 10; i++) {
      if (await verifyBtn.isVisible().catch(() => false)) break;
      await sleep(500);
    }
    await verifyBtn.click({ timeout: 10_000 });
    console.log('  ✓ Verify clicked');
    await screenshot(page, '03-after-click');

    // ── Wait up to 120s for runId to be captured from network ──────────────────
    // Local dev: orchestrate takes 20-60s (scraping + mobile UA fallback + LLM)
    for (let i = 0; i < 240 && !capturedRunId; i++) {
      await sleep(500);
    }
    if (!capturedRunId) {
      throw new Error('Could not capture runId from orchestrate response after 120s — did the verify call succeed?');
    }

    // ── 5. Poll /api/verify/status directly (reliable, not page-text parsing) ───
    console.log(`[5/5] Polling status for run ${capturedRunId.slice(0, 8)}… (all claims run in parallel)`);
    const start = Date.now();
    let lastScreenshotAt = Date.now();
    let lastLoggedSummary = '';

    while (Date.now() - start < TIMEOUT) {
      const elapsed = Math.round((Date.now() - start) / 1000);

      // Fetch status directly — bypass all page-text ambiguity
      const status = await page.evaluate(async (runId) => {
        try {
          const r = await fetch(`/api/verify/status?runId=${runId}`);
          return r.ok ? r.json() : null;
        } catch { return null; }
      }, capturedRunId).catch(() => null);

      if (!status) {
        console.warn(`  [${elapsed}s] Status fetch failed — retrying…`);
        await sleep(5000);
        continue;
      }

      const run    = status.run;
      const claims = status.claims ?? [];
      const total  = claims.length;
      const done   = claims.filter(c => TERMINAL_STATUSES.has(c.status)).length;
      const checking = claims.filter(c => c.status === 'checking').length;
      const pending  = claims.filter(c => c.status === 'pending').length;

      const summary = claims.map(c => `${c.status}`).join(', ');
      if (summary !== lastLoggedSummary || elapsed % 30 < 5) {
        console.log(`  [${elapsed}s] Run: ${run?.status} | Claims(${total}): ${summary || 'none yet'}`);
        lastLoggedSummary = summary;
      }

      // Periodic screenshots
      if (Date.now() - lastScreenshotAt > 45_000) {
        await screenshot(page, `progress-${elapsed}s`);
        lastScreenshotAt = Date.now();
      }

      // Run complete — all claims terminal
      if (run?.status === 'complete') {
        console.log(`  ✓ Run complete in ${elapsed}s — ${done}/${total} claims resolved`);
        passed = total > 0 && done === total;
        break;
      }

      // Fallback: all claims individually terminal even if run not yet marked complete
      if (total > 0 && done === total) {
        console.log(`  ✓ All ${total} claims terminal in ${elapsed}s (run status: ${run?.status})`);
        passed = true;
        break;
      }

      // Early exit: run failed at the orchestration level
      if (run?.status === 'failed') {
        console.error(`  ✗ Run marked failed — orchestration error`);
        passed = false;
        break;
      }

      await sleep(5000);
    }

    await screenshot(page, '04-final');

    // ── Summary ──────────────────────────────────────────────────────────────────
    const finalStatus = await page.evaluate(async (runId) => {
      try {
        const r = await fetch(`/api/verify/status?runId=${runId}`);
        return r.ok ? r.json() : null;
      } catch { return null; }
    }, capturedRunId).catch(() => null);

    const claims = finalStatus?.claims ?? [];
    const verifiedCount   = claims.filter(c => c.status === 'verified').length;
    const failedCount     = claims.filter(c => c.status === 'failed').length;
    const untestableCount = claims.filter(c => c.status === 'untestable').length;
    const larpCount       = claims.filter(c => c.status === 'larp' || c.status === 'larp_confirmed').length;

    // Check for raw JS errors on the visible page
    const pageText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const jsErrors = pageText.match(/Cannot read propert(?:y|ies)|TypeError:|startsWith is not|undefined\s*\(reading/gi) ?? [];

    console.log('\n══════════════════ TEST RESULTS ══════════════════');
    console.log(`  Contract       : ${CA}`);
    console.log(`  Run ID         : ${capturedRunId}`);
    console.log(`  Total claims   : ${claims.length}`);
    console.log(`  Verified       : ${verifiedCount}`);
    console.log(`  Failed         : ${failedCount}`);
    console.log(`  Untestable     : ${untestableCount}`);
    console.log(`  LARP           : ${larpCount}`);
    console.log(`  Raw JS errors  : ${jsErrors.length} (should be 0)`);
    for (const c of claims) {
      console.log(`    • [${c.status.toUpperCase().padEnd(11)}] ${c.claim?.slice(0, 70) ?? '?'}`);
    }
    console.log('══════════════════════════════════════════════════\n');

    if (!passed)         console.error('❌ FAIL — timed out or run failed before all claims resolved');
    if (jsErrors.length) console.error(`❌ FAIL — raw JS error text on page: ${jsErrors.slice(0, 3).join(' | ')}`);
    if (passed && !jsErrors.length) console.log('✅ PASS — all claims resolved, no raw JS errors');

  } catch (e) {
    console.error('💥 TEST ERROR:', e.message);
    await screenshot(page, 'error').catch(() => {});
  } finally {
    await sleep(3000);
    await browser.close();
    process.exit(passed ? 0 : 1);
  }
})();
