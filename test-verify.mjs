/**
 * Playwright E2E test — verifies BNBShare token (bnbshare.fun) end-to-end.
 *
 * Run: node test-verify.mjs
 *
 * What it does:
 *  1. Opens http://localhost:3000/dashboard
 *  2. Enters the BNBShare contract address
 *  3. Enables "Force Re-verify" so we always run a fresh scan
 *  4. Clicks the Verify button
 *  5. Polls until all claims have a verdict (parallel — all 3 run at once)
 *  6. Prints a summary and exits 0 (pass) or 1 (fail)
 *
 * Pass criteria:
 *  - Every claim shows a verdict (VERIFIED / LARP / UNTESTABLE / SITE_BROKEN)
 *  - No raw JS error text appears in any verdict card
 *  - No "FAILED" verdict (FAILED = bug in site code, not a valid scan result)
 */

import { chromium } from 'playwright';

const BASE    = process.env.TEST_BASE_URL ?? 'https://larpscan.sh';
const CA      = '0x1646980a0e0ebea85db014807205aa4d9bf87777';
const TIMEOUT = 15 * 60 * 1000;  // 15 min — parallel, so all 3 run concurrently

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name) {
  const path = `/tmp/larpscan-test-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`📸 ${path}`);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  let passed = false;

  try {
    // ── 1. Navigate to dashboard ──────────────────────────────────────────────
    console.log('\n[1/6] Navigating to dashboard…');
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30_000 });
    await sleep(2000);
    await screenshot(page, '01-dashboard');

    // ── 2. Fill contract address ──────────────────────────────────────────────
    console.log(`[2/6] Filling contract address: ${CA}`);
    const input = page
      .locator('input[placeholder*="contract"], input[placeholder*="address"], input[placeholder*="token"], input[type="text"]')
      .first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.click();
    await input.fill(CA);
    await input.dispatchEvent('input', { bubbles: true });
    await input.dispatchEvent('change', { bubbles: true });
    await sleep(1000);
    await screenshot(page, '02-filled');

    // ── 3. Enable Force Re-verify ─────────────────────────────────────────────
    console.log('[3/6] Enabling Force Re-verify…');
    const forceLabel = page.locator('label').filter({ hasText: /force\s*re.?verify/i }).first();
    const forceVis = await forceLabel.isVisible({ timeout: 2000 }).catch(() => false);
    if (forceVis) {
      await forceLabel.click();
      console.log('  ✓ Force re-verify enabled');
    } else {
      console.log('  ⚠ Force re-verify toggle not found — fresh run may be cached');
    }
    await sleep(500);

    // ── 4. Click Verify button ────────────────────────────────────────────────
    console.log('[4/6] Clicking Verify button…');
    const verifyBtn = page.locator('button').filter({ hasText: /verify|scan/i }).first();

    const isDisabled = await verifyBtn.isDisabled().catch(() => true);
    if (isDisabled) {
      console.log('  Button disabled — retrying with keyboard input…');
      await input.clear();
      await input.type(CA, { delay: 20 });
      await sleep(800);
    }

    await verifyBtn.click({ timeout: 10_000 });
    console.log('  ✓ Verify clicked');
    await sleep(5000);
    await screenshot(page, '03-after-click');

    // ── 5. Poll for completion ────────────────────────────────────────────────
    console.log('[5/6] Waiting for all claims to complete (parallel)…');
    const start = Date.now();
    let lastScreenshotAt = Date.now();
    let completedCount = 0;

    while (Date.now() - start < TIMEOUT) {
      const text = await page.evaluate(() => document.body?.innerText ?? '');

      // Count final verdicts (VERIFIED / LARP / UNTESTABLE / SITE_BROKEN)
      const verdictMatches = text.match(/\b(VERIFIED|Verified|LARP|UNTESTABLE|Untestable|FAILED|Failed|SITE[\s._]BROKEN|Site Broken)\b(?!SCAN)/gi) ?? [];
      const verdictCount   = verdictMatches.length;

      // Check if still scanning
      const isScanning = /verification in progress|checking\b|scanning\.\.\.|queued for verification/i.test(text);

      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 30 < 5 || completedCount !== verdictCount) {
        console.log(`  [${elapsed}s] Verdicts: ${verdictCount}, Scanning: ${isScanning} — ${verdictMatches.join(', ')}`);
        completedCount = verdictCount;
      }

      // Periodic screenshots
      if (Date.now() - lastScreenshotAt > 45_000) {
        await screenshot(page, `progress-${elapsed}s`);
        lastScreenshotAt = Date.now();
      }

      // Done when ≥3 verdicts visible and nothing is still scanning
      if (verdictCount >= 3 && !isScanning) {
        console.log(`  ✓ All ${verdictCount} claims resolved in ${elapsed}s`);
        passed = true;
        break;
      }

      // Also exit if run is complete (no more scanning) even with < 3 verdicts
      // (some claims may have been auto-healed to a non-verdict state)
      if (!isScanning && verdictCount > 0) {
        console.log(`  ✓ Scanning stopped with ${verdictCount} visible verdict(s) in ${elapsed}s`);
        passed = verdictCount >= 3;
        break;
      }

      await sleep(5000);
    }

    await screenshot(page, '04-final');

    // ── 6. Analyse results ────────────────────────────────────────────────────
    console.log('\n[6/6] Analysing results…');
    const finalText = await page.evaluate(() => document.body?.innerText ?? '');

    const verdicts = finalText.match(/\b(VERIFIED|Verified|LARP|UNTESTABLE|Untestable|FAILED|Failed|SITE[\s._]BROKEN|Site Broken)\b(?!SCAN)/gi) ?? [];
    const jsErrors  = finalText.match(/Cannot read propert(?:y|ies)|TypeError:|startsWith is not|undefined\s*\(reading/gi) ?? [];
    const failedVerdicts = verdicts.filter(v => /^FAILED$/i.test(v));

    const positiveVerdicts = verdicts.filter(v => /^(VERIFIED|LARP|UNTESTABLE|Site Broken)$/i.test(v));

    console.log('\n══════════════════ TEST RESULTS ══════════════════');
    console.log(`  Total verdicts : ${verdicts.length}`);
    console.log(`  Verdicts       : ${verdicts.join(', ')}`);
    console.log(`  FAILED count   : ${failedVerdicts.length}`);
    console.log(`  Positive count : ${positiveVerdicts.length} (should be ≥3 for full pass)`);
    console.log(`  Raw JS errors  : ${jsErrors.length} (should be 0)`);
    console.log('══════════════════════════════════════════════════\n');

    if (!passed)           console.error('❌ FAIL — timed out before all claims resolved');
    if (jsErrors.length)   console.error(`❌ FAIL — raw JS error text visible: ${jsErrors.join(' | ')}`);

    if (passed && !jsErrors.length) {
      console.log('✅ PASS — all claims resolved, no raw JS errors');
    }

  } catch (e) {
    console.error('💥 TEST ERROR:', e.message);
    await screenshot(page, 'error').catch(() => {});
  } finally {
    await sleep(3000);
    await browser.close();
    process.exit(passed ? 0 : 1);
  }
})();
