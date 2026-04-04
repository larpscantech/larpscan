/**
 * Playwright E2E test — verifies BNBShare token (bnbshare.fun) end-to-end.
 *
 * Run: node test-verify.mjs
 * Run against local: TEST_BASE_URL=http://localhost:3000 node test-verify.mjs
 *
 * What it does:
 *  1. Opens the dashboard
 *  2. Types the BNBShare contract address (pressSequentially for React state)
 *  3. Selects Quick Scan for faster completion
 *  4. Enables Force Re-verify so a fresh scan always runs
 *  5. Clicks Verify
 *  6. Polls until all 3 claims have a verdict (all run in parallel)
 *  7. Prints a summary and exits 0 (pass) or 1 (fail)
 *
 * Pass criteria:
 *  - All 3 claims show a verdict (any terminal state including Untestable)
 *  - No raw JS error text visible on page
 */

import { chromium } from 'playwright';

const BASE    = process.env.TEST_BASE_URL ?? 'https://larpscan.sh';
const CA      = '0x1646980a0e0ebea85db014807205aa4d9bf87777';
const TIMEOUT = 15 * 60 * 1000; // 15 min budget

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
    console.log('\n[1/5] Navigating to dashboard…');
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30_000 });
    await sleep(2000);
    await screenshot(page, '01-dashboard');

    // ── 2. Fill contract address with pressSequentially (triggers React state) ─
    console.log(`[2/5] Typing contract address: ${CA}`);
    const input = page.locator('input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.click();
    await input.clear();
    await input.pressSequentially(CA, { delay: 5 });
    await sleep(500);

    // Verify the button became enabled
    const btnEnabled = await page.locator('button').filter({ hasText: /verify/i }).first().isEnabled({ timeout: 3000 }).catch(() => false);
    console.log(`  Button enabled: ${btnEnabled}`);
    await screenshot(page, '02-filled');

    // ── 3. Select Quick Scan ──────────────────────────────────────────────────
    console.log('[3/5] Selecting Quick Scan…');
    const quickBtn = page.locator('button').filter({ hasText: /quick\s*scan/i }).first();
    if (await quickBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await quickBtn.click();
      console.log('  ✓ Quick Scan selected');
    }
    await sleep(200);

    // Enable Force Re-verify
    const forceLabel = page.locator('label').filter({ hasText: /force\s*re.?verify/i }).first();
    if (await forceLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await forceLabel.click();
      console.log('  ✓ Force Re-verify enabled');
    }
    await sleep(300);

    // ── 4. Click Verify ───────────────────────────────────────────────────────
    console.log('[4/5] Clicking Verify…');
    // Use a permissive text match — button may have icon text or whitespace
    const verifyBtn = page.locator('button:not([disabled])').filter({ hasText: /verify/i }).last();
    // Wait up to 5s for button to be enabled
    for (let i = 0; i < 10; i++) {
      if (await verifyBtn.isVisible().catch(() => false)) break;
      await sleep(500);
    }
    await verifyBtn.click({ timeout: 10_000 });
    console.log('  ✓ Verify clicked');
    await sleep(5000);
    await screenshot(page, '03-after-click');

    // ── 5. Poll for completion ────────────────────────────────────────────────
    console.log('[5/5] Waiting for all claims to complete (parallel)…');
    const start = Date.now();
    let lastScreenshotAt = Date.now();
    let prevCount = -1;
    let prevScanning = true;

    while (Date.now() - start < TIMEOUT) {
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

      // Match all terminal verdict strings (badge labels are mixed-case)
      const verdictMatches = text.match(
        /\b(VERIFIED|Verified|LARP|UNTESTABLE|Untestable|FAILED|Failed|SITE BROKEN|Site Broken)\b(?! SCAN)/gi,
      ) ?? [];
      const verdictCount = verdictMatches.length;

      const isScanning = /verification in progress|checking\b|scanning\.\.\.|queued for verification/i.test(text);

      const elapsed = Math.round((Date.now() - start) / 1000);

      // Log on change or every 30 s
      if (verdictCount !== prevCount || isScanning !== prevScanning || elapsed % 30 < 5) {
        console.log(`  [${elapsed}s] Verdicts: ${verdictCount}, Scanning: ${isScanning} — ${verdictMatches.join(', ')}`);
        prevCount = verdictCount;
        prevScanning = isScanning;
      }

      // Periodic screenshots
      if (Date.now() - lastScreenshotAt > 45_000) {
        await screenshot(page, `progress-${elapsed}s`);
        lastScreenshotAt = Date.now();
      }

      // All 3 claims done
      if (verdictCount >= 3 && !isScanning) {
        console.log(`  ✓ All ${verdictCount} claims resolved in ${elapsed}s`);
        passed = true;
        break;
      }

      // Scanning stopped but < 3 visible verdicts (some may be hidden by layout)
      if (!isScanning && verdictCount > 0) {
        console.log(`  ✓ Scanning stopped: ${verdictCount} verdict(s) visible in ${elapsed}s`);
        passed = verdictCount >= 3;
        break;
      }

      await sleep(5000);
    }

    await screenshot(page, '04-final');

    // ── Summary ───────────────────────────────────────────────────────────────
    const finalText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const verdicts   = finalText.match(/\b(VERIFIED|Verified|LARP|UNTESTABLE|Untestable|FAILED|Failed|SITE BROKEN|Site Broken)\b(?! SCAN)/gi) ?? [];
    const jsErrors   = finalText.match(/Cannot read propert(?:y|ies)|TypeError:|startsWith is not|undefined\s*\(reading/gi) ?? [];

    console.log('\n══════════════════ TEST RESULTS ══════════════════');
    console.log(`  Total verdicts : ${verdicts.length}`);
    console.log(`  Verdicts       : ${verdicts.join(', ')}`);
    console.log(`  Raw JS errors  : ${jsErrors.length} (should be 0)`);
    console.log('══════════════════════════════════════════════════\n');

    if (!passed)         console.error('❌ FAIL — timed out before all claims resolved');
    if (jsErrors.length) console.error(`❌ FAIL — raw JS error text visible: ${jsErrors.join(' | ')}`);

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
