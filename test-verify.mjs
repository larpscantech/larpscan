import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const CA = '0x1646980a0e0ebea85db014807205aa4d9bf87777';
const TIMEOUT = 480_000; // 8 min total budget (claims can take 5min each)

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name) {
  const path = `/tmp/cv-test-${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`Screenshot: ${path}`);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    // 1. Navigate to dashboard
    console.log('=== Navigating to dashboard ===');
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30_000 });
    await sleep(2000);
    await screenshot(page, '01-dashboard');

    // 2. Enter the CA
    console.log(`=== Entering CA: ${CA} ===`);
    const input = page.locator('input[placeholder*="contract"], input[placeholder*="address"], input[placeholder*="token"]').first();
    await input.click();
    await input.fill(CA);
    // Dispatch input event to trigger React state update
    await input.dispatchEvent('input', { bubbles: true });
    await input.dispatchEvent('change', { bubbles: true });
    await sleep(1000);
    await screenshot(page, '01b-after-fill');

    // 3. Enable Force Reverify checkbox
    console.log('=== Enabling Force Reverify ===');
    const forceLabel = page.locator('label').filter({ hasText: /force re-?verify/i }).first();
    const forceVis = await forceLabel.isVisible({ timeout: 2000 }).catch(() => false);
    if (forceVis) {
      await forceLabel.click();
      console.log('Force reverify toggled');
    } else {
      console.log('Force reverify not found — skipping');
    }
    await sleep(500);

    // 4. Click Verify / Scan button
    console.log('=== Clicking Verify ===');
    // Check if button is enabled
    const verifyBtn = page.locator('button').filter({ hasText: /verify/i }).first();
    const disabled = await verifyBtn.isDisabled().catch(() => true);
    console.log(`Verify button disabled: ${disabled}`);
    if (disabled) {
      // Try typing the CA instead
      console.log('Button disabled — trying keyboard input');
      await input.clear();
      await input.type(CA, { delay: 10 });
      await sleep(500);
      const stillDisabled = await verifyBtn.isDisabled().catch(() => true);
      console.log(`After type: disabled=${stillDisabled}`);
    }
    await verifyBtn.click({ timeout: 5000 });
    console.log('Verify button clicked');
    await sleep(5000);
    await screenshot(page, '02-after-click');

    // 5. Poll for completion
    console.log('=== Waiting for verification to complete ===');
    const start = Date.now();
    let lastScreenshot = Date.now();
    let completed = false;

    while (Date.now() - start < TIMEOUT) {
      const text = await page.evaluate(() => document.body?.innerText ?? '');

      // Check for completion signals
      const hasVerdict = /\b(VERIFIED|LARP|UNTESTABLE|SITE[\s.]BROKEN)\b(?!SCAN)/i.test(text);
      const hasProgress = /verification in progress|checking|queued for verification|scanning\.\.\./i.test(text);
      const claimCount = (text.match(/\b(VERIFIED|LARP|UNTESTABLE|SITE[\s.]BROKEN)\b(?!SCAN)/gi) || []).length;

      // Take periodic screenshots
      if (Date.now() - lastScreenshot > 30_000) {
        await screenshot(page, `03-progress-${Math.round((Date.now() - start) / 1000)}s`);
        lastScreenshot = Date.now();
      }

      console.log(`  [${Math.round((Date.now() - start) / 1000)}s] Verdicts: ${claimCount}, InProgress: ${hasProgress}`);

      // If we see 3+ verdicts and no more "in progress", we're done
      if (claimCount >= 3 && !hasProgress) {
        completed = true;
        console.log(`=== All claims resolved (${claimCount} verdicts) ===`);
        break;
      }

      // If we see verdicts but still in progress, keep waiting
      if (hasVerdict && hasProgress) {
        await sleep(5000);
        continue;
      }

      await sleep(5000);
    }

    await screenshot(page, '04-final');

    // 6. Extract results
    const finalText = await page.evaluate(() => document.body?.innerText ?? '');
    const verdicts = finalText.match(/\b(VERIFIED|LARP|FAILED|UNTESTABLE|SITE[\s.]BROKEN)\b(?!SCAN)/gi) || [];
    console.log('\n=== RESULTS ===');
    console.log(`Total verdicts: ${verdicts.length}`);
    console.log(`Verdicts: ${verdicts.join(', ')}`);

    if (!completed) {
      console.log('WARNING: Timed out before all claims resolved');
    }

    // 7. Check for evidence sections
    const hasVideo = finalText.toLowerCase().includes('agent recording');
    const hasEvidence = finalText.toLowerCase().includes('evidence');
    console.log(`Has video: ${hasVideo}`);
    console.log(`Has evidence: ${hasEvidence}`);

    // 8. Check for blocker reasons (new feature)
    const blockerReasonVisible = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      return spans
        .filter(s => s.className.includes('font-mono') && s.textContent && s.textContent.length > 10 && s.textContent.length < 100)
        .map(s => s.textContent?.trim())
        .filter(t => t && /wallet|auth|blocked|gated|route|crash|transaction/i.test(t));
    });
    if (blockerReasonVisible.length > 0) {
      console.log(`Blocker reasons visible: ${blockerReasonVisible.join(' | ')}`);
    }

    console.log('\n=== TEST COMPLETE ===');

  } catch (e) {
    console.error('TEST ERROR:', e.message);
    await screenshot(page, 'error');
  } finally {
    await sleep(3000);
    await browser.close();
  }
})();
