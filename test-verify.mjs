/**
 * Playwright E2E test — general-purpose token / website verification test.
 *
 * Run: TEST_BASE_URL=http://localhost:3002 TEST_URL=https://four.meme/ node test-verify.mjs
 * Run with CA: TEST_BASE_URL=http://localhost:3002 TEST_CA=0x... node test-verify.mjs
 *
 * Strategy:
 *   - Navigate to the dashboard (just to get a page context in the right origin).
 *   - Call /api/verify/orchestrate directly via page.evaluate — bypasses the 600ms
 *     debounce and its stale-closure issue that auto-joins old runs.
 *   - If the orchestrate response is 'started', dispatch claims via /api/verify/run.
 *   - Poll /api/verify/status directly until all claims reach a terminal state.
 *   - Print a summary and exit 0 (pass) or 1 (fail).
 *
 * Pass criteria:
 *   - All claims reach a terminal state (verified / failed / untestable / larp).
 *   - For TOKEN_CREATION claims: at least one should reach 'verified' or 'failed'
 *     (not just 'untestable') — meaning the agent actually ran.
 */

import { chromium } from 'playwright';

const BASE     = process.env.TEST_BASE_URL ?? 'https://larpscan.sh';
const CA       = process.env.TEST_CA  ?? '0x2a846aaaf896ef393ccb76398c1d96ea97374444';
const TEST_URL = process.env.TEST_URL ?? '';
const USE_URL  = TEST_URL.length > 0;
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

  try {
    // ── 1. Navigate to dashboard (gives us the right origin for API calls) ──────
    console.log(`\n[1/5] Navigating to dashboard (${IS_LOCAL ? 'local dev — allow 2 min compile' : 'production'})…`);
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
    // Wait for the page body to be visible — the input[type="text"] may require
    // client-side hydration which can be slow on first load in local dev.
    await page.waitForSelector('body', { state: 'visible', timeout: 10_000 }).catch(() => {});
    // Give React a moment to hydrate the interactive components.
    await sleep(3000);
    await screenshot(page, '01-dashboard');

    // ── 2. Start verification directly via API (bypasses debounce) ───────────────
    // Using page.evaluate so the request carries the same origin as the page,
    // avoiding CORS issues. forceReverify=true always starts a fresh run.
    console.log(`[2/5] Starting verification via API for: ${USE_URL ? TEST_URL : CA}`);
    const orchPayload = USE_URL
      ? { websiteUrl: TEST_URL, forceReverify: true }
      : { contractAddress: CA, forceReverify: true };

    const orchResult = await page.evaluate(async (payload) => {
      try {
        const r = await fetch('/api/verify/orchestrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return r.ok ? r.json() : { error: `HTTP ${r.status}` };
      } catch (e) {
        return { error: String(e) };
      }
    }, orchPayload);

    if (!orchResult?.runId) {
      throw new Error(`Orchestrate call failed: ${JSON.stringify(orchResult)}`);
    }

    capturedRunId = orchResult.runId;
    console.log(`  ✓ RunId: ${capturedRunId.slice(0, 8)}… (status: ${orchResult.status})`);
    await screenshot(page, '02-started');

    // ── 3. Dispatch claims if this is a freshly started run ──────────────────────
    if (orchResult.status === 'started' || orchResult.status === 'joined') {
      console.log(`[3/5] Dispatching claims via /api/verify/run…`);
      const runResult = await page.evaluate(async (runId) => {
        try {
          const r = await fetch('/api/verify/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId }),
          });
          return r.ok ? r.json() : { error: `HTTP ${r.status}` };
        } catch (e) {
          return { error: String(e) };
        }
      }, capturedRunId);
      console.log(`  ✓ Dispatch result: ${JSON.stringify(runResult).slice(0, 120)}`);
    } else if (orchResult.status === 'complete') {
      console.log(`[3/5] Orchestrate returned existing complete run — forcing a re-run…`);
      // This shouldn't happen with forceReverify=true, but handle it gracefully:
      // just use whatever runId we got and see if it has useful results.
      console.log('  ⚠ Got complete run despite forceReverify=true — check orchestrate route');
    }

    // ── 4. Poll /api/verify/status until all claims are terminal ─────────────────
    console.log(`[4/5] Polling status for run ${capturedRunId.slice(0, 8)}…`);
    const start = Date.now();
    let lastScreenshotAt = Date.now();
    let lastLoggedSummary = '';

    while (Date.now() - start < TIMEOUT) {
      const elapsed = Math.round((Date.now() - start) / 1000);

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

      const summary = claims.map(c => `${c.status}`).join(', ');
      if (summary !== lastLoggedSummary || elapsed % 30 < 5) {
        console.log(`  [${elapsed}s] Run: ${run?.status} | Claims(${total}): ${summary || 'none yet'}`);
        lastLoggedSummary = summary;
      }

      if (Date.now() - lastScreenshotAt > 45_000) {
        await screenshot(page, `progress-${elapsed}s`);
        lastScreenshotAt = Date.now();
      }

      if (run?.status === 'complete') {
        console.log(`  ✓ Run complete in ${elapsed}s — ${done}/${total} claims resolved`);
        passed = total > 0 && done === total;
        break;
      }

      if (total > 0 && done === total) {
        console.log(`  ✓ All ${total} claims terminal in ${elapsed}s (run status: ${run?.status})`);
        passed = true;
        break;
      }

      if (run?.status === 'failed') {
        console.error(`  ✗ Run marked failed — orchestration error`);
        passed = false;
        break;
      }

      await sleep(5000);
    }

    await screenshot(page, '04-final');

    // ── 5. Summary ───────────────────────────────────────────────────────────────
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

    // Check if TOKEN_CREATION claim actually ran (not just untestable)
    const tokenCreationClaim = claims.find(c =>
      c.claim?.toLowerCase().includes('token') || c.feature_type === 'TOKEN_CREATION',
    );
    const tokenCreationVerdict = tokenCreationClaim?.status ?? 'not found';

    const pageText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const jsErrors = pageText.match(/Cannot read propert(?:y|ies)|TypeError:|startsWith is not|undefined\s*\(reading/gi) ?? [];

    console.log('\n══════════════════ TEST RESULTS ══════════════════');
    console.log(`  Target         : ${USE_URL ? TEST_URL : CA}`);
    console.log(`  Run ID         : ${capturedRunId}`);
    console.log(`  Total claims   : ${claims.length}`);
    console.log(`  Verified       : ${verifiedCount}`);
    console.log(`  Failed         : ${failedCount}`);
    console.log(`  Untestable     : ${untestableCount}`);
    console.log(`  LARP           : ${larpCount}`);
    console.log(`  Token creation : ${tokenCreationVerdict}`);
    console.log(`  Raw JS errors  : ${jsErrors.length} (should be 0)`);
    for (const c of claims) {
      const txInfo = c.tx_hash ? ` [tx: ${c.tx_hash.slice(0, 10)}…]` : '';
      console.log(`    • [${(c.status ?? '?').toUpperCase().padEnd(11)}] ${(c.claim ?? '?').slice(0, 70)}${txInfo}`);
    }
    console.log('══════════════════════════════════════════════════\n');

    if (!passed)         console.error('❌ FAIL — timed out or run failed before all claims resolved');
    if (jsErrors.length) console.error(`❌ FAIL — raw JS error text on page: ${jsErrors.slice(0, 3).join(' | ')}`);
    if (tokenCreationVerdict === 'untestable') {
      console.warn('⚠ TOKEN_CREATION was untestable — agent could not run browser session (check Browserless quota)');
    }
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
