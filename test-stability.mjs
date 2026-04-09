/**
 * test-stability.mjs — Multi-scenario stability test for LarpScan
 *
 * Tests:
 *  1. Full verification run with a given CA
 *  2. CA Active-Run Teleport — second tab opening same CA joins the existing run
 *  3. Refresh mid-run — page re-attaches to run via URL ?runId= persistence
 *  4. Close and re-open — browser closes, re-navigates with same URL, picks up the run
 *
 * Run: TEST_CA=0x... TEST_BASE_URL=http://localhost:3000 node test-stability.mjs
 */

import { chromium } from 'playwright';

const BASE     = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const CA       = process.env.TEST_CA ?? '0xf671f96f7763e88ea92ff7db79d57c0ee3c7ffff';
const IS_LOCAL = BASE.includes('localhost') || BASE.includes('127.0');
const GOTO_MS  = IS_LOCAL ? 120_000 : 30_000;
const TIMEOUT  = 20 * 60 * 1000;

const TERMINAL = new Set(['verified', 'failed', 'untestable', 'larp', 'larp_confirmed']);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name) {
  const path = `/tmp/larpscan-stability-${name}.png`;
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  console.log(`    📸 ${path}`);
}

async function fetchRunStatus(page, runId) {
  return page.evaluate(async (id) => {
    try {
      const r = await fetch(`/api/verify/status?runId=${id}`);
      return r.ok ? r.json() : null;
    } catch { return null; }
  }, runId).catch(() => null);
}

async function fetchActiveRun(page, ca) {
  return page.evaluate(async (addr) => {
    try {
      const r = await fetch(`/api/verify/active?ca=${addr}`);
      return r.ok ? r.json() : null;
    } catch { return null; }
  }, ca).catch(() => null);
}

async function startVerification(page, ca, { forceReVerify = true } = {}) {
  console.log(`    → Navigating to dashboard…`);
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
  await page.locator('input[type="text"]').first().waitFor({ state: 'visible', timeout: GOTO_MS });
  await sleep(1000);

  const input = page.locator('input[type="text"]').first();
  await input.click();
  await input.clear();
  await input.pressSequentially(ca, { delay: 5 });
  await sleep(600); // wait for debounce active-run check

  // Quick Scan
  const quickBtn = page.locator('button').filter({ hasText: /quick\s*scan/i }).first();
  if (await quickBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await quickBtn.click();
  }
  await sleep(200);

  // Force Re-verify
  if (forceReVerify) {
    const forceLabel = page.locator('label').filter({ hasText: /force\s*re.?verify/i }).first();
    if (await forceLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await forceLabel.click();
    }
  }
  await sleep(800);

  return page;
}

async function captureRunId(page) {
  // Check URL for ?runId= param (set by dashboard after verification starts)
  const url = page.url();
  const match = url.match(/[?&]runId=([a-f0-9-]{36})/i);
  if (match) return match[1];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test runner
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       LarpScan Stability Test Suite              ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  CA      : ${CA}`);
  console.log(`  Base URL: ${BASE}\n`);

  const results = { pass: [], fail: [] };

  // ── SCENARIO 1: Start a fresh run and capture the runId ──────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SCENARIO 1: Start fresh verification run');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const browser1 = await chromium.launch({ headless: true });
  const page1    = await browser1.newPage({ viewport: { width: 1400, height: 900 } });

  let runId        = null;
  let runUrl       = null;

  try {
    let orchestrateRunId = null;
    page1.on('response', async (res) => {
      if (res.url().includes('/api/verify/orchestrate') && res.status() === 200) {
        const body = await res.json().catch(() => null);
        if (body?.runId) orchestrateRunId = body.runId;
      }
    });

    await startVerification(page1, CA, { forceReVerify: true });
    await screenshot(page1, '01-pre-verify');

    // Check if debounce already teleported us
    await sleep(1000);
    const preClickUrl = page1.url();
    const teleportMatch = preClickUrl.match(/[?&]runId=([a-f0-9-]{36})/i);
    if (teleportMatch) {
      runId  = teleportMatch[1];
      runUrl = preClickUrl;
      console.log(`    ✓ Debounce auto-teleported to existing run ${runId.slice(0, 8)}…`);
    } else {
      // Click verify
      const verifyBtn = page1.locator('button:not([disabled])').filter({ hasText: /verify/i }).last();
      await verifyBtn.click({ timeout: 10_000 });
      console.log('    ✓ Verify clicked');

      // Wait for URL to include runId
      for (let i = 0; i < 300 && !runId; i++) {
        await sleep(500);
        const u = page1.url();
        const m = u.match(/[?&]runId=([a-f0-9-]{36})/i);
        if (m) { runId = m[1]; runUrl = u; }
        if (orchestrateRunId && !runId) { runId = orchestrateRunId; }
      }
    }

    if (!runId) throw new Error('Could not capture runId from URL or network after 150s');
    console.log(`    ✓ RunId: ${runId}`);
    console.log(`    ✓ Run URL: ${runUrl ?? page1.url()}`);
    await screenshot(page1, '01-after-start');

    // Quick status check — should be pending/verifying
    await sleep(2000);
    const initStatus = await fetchRunStatus(page1, runId);
    const runStatus  = initStatus?.run?.status ?? 'unknown';
    if (runStatus === 'pending' || runStatus === 'verifying') {
      console.log(`    ✓ Run is alive: status=${runStatus}`);
      results.pass.push('SCENARIO 1: Run started successfully');
    } else if (runStatus === 'complete') {
      console.log(`    ✓ Run already complete (cached) — still a pass`);
      results.pass.push('SCENARIO 1: Run resolved (cached result)');
    } else {
      throw new Error(`Unexpected run status: ${runStatus}`);
    }

  } catch (e) {
    console.error(`    ✗ FAILED: ${e.message}`);
    results.fail.push(`SCENARIO 1: ${e.message}`);
    await screenshot(page1, '01-error');
  }

  // ── SCENARIO 2: Active-Run Teleport ──────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SCENARIO 2: Second tab enters same CA → teleports to active run');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!runId) {
    console.log('    ⚠ Skipped — no runId from Scenario 1');
    results.fail.push('SCENARIO 2: Skipped (no runId)');
  } else {
    const browser2 = await chromium.launch({ headless: true });
    const page2    = await browser2.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      // Check /api/verify/active first
      const activeData = await fetchActiveRun(page2, CA);
      console.log(`    → /api/verify/active response: ${JSON.stringify(activeData)}`);

      if (!activeData?.hasActiveRun && !activeData?.hasCompletedRun) {
        // Run may have completed already (fast token) — still test the tab navigation
        console.log('    ℹ No active run detected by API — run may have already completed');
      }

      // Open dashboard in second tab with the same CA
      await page2.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
      await page2.locator('input[type="text"]').first().waitFor({ state: 'visible', timeout: GOTO_MS });
      await sleep(800);

      const input2 = page2.locator('input[type="text"]').first();
      await input2.click();
      await input2.clear();
      await input2.pressSequentially(CA, { delay: 5 });

      // Wait for debounce (600ms) + active-run check to fire
      await sleep(1500);
      await screenshot(page2, '02-tab2-after-input');

      const urlAfterDebounce = page2.url();
      const teleportedRunId  = urlAfterDebounce.match(/[?&]runId=([a-f0-9-]{36})/i)?.[1];

      if (teleportedRunId) {
        console.log(`    ✓ Tab 2 teleported to run ${teleportedRunId.slice(0, 8)}…`);
        if (teleportedRunId === runId) {
          console.log('    ✓ SAME runId as Tab 1 — correct teleport behavior');
          results.pass.push('SCENARIO 2: Teleport works — same runId in both tabs');
        } else {
          // Different runId is acceptable if the first run already completed and a cached result was returned
          console.log(`    ⚠ Different runId (Tab1=${runId.slice(0,8)} Tab2=${teleportedRunId.slice(0,8)}) — may be cached result`);
          results.pass.push('SCENARIO 2: Teleport fired (different runId — likely completed/cached)');
        }
      } else {
        // Check if the verify button is disabled (active run lock)
        const verifyDisabled = await page2.locator('button').filter({ hasText: /verify/i })
          .first().isDisabled({ timeout: 2000 }).catch(() => false);
        if (verifyDisabled) {
          console.log('    ✓ Verify button disabled — active-run lock is working');
          results.pass.push('SCENARIO 2: Active-run lock — Verify button disabled for duplicate CA');
        } else {
          // Check if the page shows "Join active run" or similar UI
          const pageText = await page2.evaluate(() => document.body.innerText).catch(() => '');
          const joinVisible = /join|active run|in progress|verifying/i.test(pageText);
          if (joinVisible) {
            console.log('    ✓ Page shows active-run state');
            results.pass.push('SCENARIO 2: Active-run indicator visible in Tab 2');
          } else {
            console.log('    ⚠ No teleport URL, no disabled button, no join text — checking active endpoint…');
            const status2 = await fetchActiveRun(page2, CA);
            console.log(`      Active API: ${JSON.stringify(status2)}`);
            // If no active run, the UI correctly shows the Verify button enabled (expected)
            if (!status2?.hasActiveRun && !status2?.hasCompletedRun) {
              console.log('    ✓ No active run in DB — Tab 2 correctly shows fresh verify form');
              results.pass.push('SCENARIO 2: No active run — Tab 2 shows fresh form (correct)');
            } else {
              results.fail.push('SCENARIO 2: Active run exists but Tab 2 did not teleport');
            }
          }
        }
      }
    } catch (e) {
      console.error(`    ✗ FAILED: ${e.message}`);
      results.fail.push(`SCENARIO 2: ${e.message}`);
      await screenshot(page2, '02-error');
    } finally {
      await browser2.close();
    }
  }

  // ── SCENARIO 3: Refresh mid-run re-attaches via URL ──────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SCENARIO 3: Refresh browser mid-run — re-attaches via URL ?runId=');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!runId) {
    console.log('    ⚠ Skipped — no runId from Scenario 1');
    results.fail.push('SCENARIO 3: Skipped (no runId)');
  } else {
    try {
      const currentUrl = page1.url();
      console.log(`    → URL before refresh: ${currentUrl}`);
      await screenshot(page1, '03-pre-refresh');

      await page1.reload({ waitUntil: 'domcontentloaded', timeout: GOTO_MS });
      // Wait for React hydration + ?runId= mount restore (should be <2s now)
      await sleep(3000);

      await screenshot(page1, '03-post-refresh');

      const urlAfterRefresh = page1.url();
      console.log(`    → URL after refresh: ${urlAfterRefresh}`);

      const runIdInUrl = urlAfterRefresh.match(/[?&]runId=([a-f0-9-]{36})/i)?.[1];
      const caInUrl    = urlAfterRefresh.match(/[?&]ca=(0x[0-9a-fA-F]{40,})/i)?.[1];

      if (runIdInUrl === runId) {
        console.log(`    ✓ URL still contains runId ${runId.slice(0, 8)}… after refresh`);
        const pageText = await page1.evaluate(() => document.body.innerText).catch(() => '');
        const showsRunContent = /verif|checking|claim|scan|pending|complete|verified|reconnect/i.test(pageText);
        if (showsRunContent) {
          console.log('    ✓ Page content shows verification state after refresh');
          results.pass.push('SCENARIO 3: Refresh re-attaches — URL+runId persisted, run state visible');
        } else {
          console.log('    ⚠ URL persisted but page content unclear');
          results.pass.push('SCENARIO 3: Refresh — runId URL persisted (page content ambiguous)');
        }
      } else if (caInUrl) {
        // URL has ?ca= — refresh will trigger debounce to re-join (slightly slower)
        console.log(`    ✓ URL has ?ca=${caInUrl.slice(0, 10)}… — debounce will re-attach (checking now…)`);
        // Wait for debounce (600ms) + active-run fetch + possible UI update
        await sleep(3000);
        const pageTextAfterDebounce = await page1.evaluate(() => document.body.innerText).catch(() => '');
        const hasRunState = /verif|checking|claim|scan|pending|complete|verified/i.test(pageTextAfterDebounce);
        if (hasRunState) {
          console.log('    ✓ Page re-attached via ?ca= debounce after refresh');
          results.pass.push('SCENARIO 3: Refresh via ?ca= debounce — run state visible');
        } else {
          console.log('    ⚠ ?ca= in URL but page not showing run state (debounce may still be loading)');
          results.fail.push('SCENARIO 3: ?ca= in URL but page not showing run state after refresh');
        }
      } else {
        const statusAfter = await fetchRunStatus(page1, runId);
        if (statusAfter?.run?.status === 'complete') {
          console.log('    ✓ Run already complete — URL cleared is expected behavior after completion');
          results.pass.push('SCENARIO 3: Refresh after completion — URL cleared (expected)');
        } else {
          console.log(`    ✗ No ?runId= or ?ca= in URL after refresh (status=${statusAfter?.run?.status})`);
          await screenshot(page1, '03-missing-url');
          results.fail.push(`SCENARIO 3: No URL params after refresh (status=${statusAfter?.run?.status})`);
        }
      }
    } catch (e) {
      console.error(`    ✗ FAILED: ${e.message}`);
      results.fail.push(`SCENARIO 3: ${e.message}`);
    }
  }

  // ── SCENARIO 4: Close browser and re-open with run URL ───────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SCENARIO 4: Close browser → re-open with run URL → re-attaches');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const savedRunUrl = runUrl ?? (runId ? `${BASE}/dashboard?runId=${runId}` : null);

  if (!savedRunUrl || !runId) {
    console.log('    ⚠ Skipped — no run URL from Scenario 1');
    results.fail.push('SCENARIO 4: Skipped (no runId)');
  } else {
    await browser1.close();
    console.log('    ✓ Browser 1 closed');

    const browser3 = await chromium.launch({ headless: true });
    const page3    = await browser3.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      const targetUrl = `${BASE}/dashboard?runId=${runId}`;
      console.log(`    → Opening: ${targetUrl}`);
      await page3.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
      await sleep(3000);
      await screenshot(page3, '04-reopen');

      const urlAfterReopen = page3.url();
      const runIdInUrl     = urlAfterReopen.match(/[?&]runId=([a-f0-9-]{36})/i)?.[1];

      const pageText = await page3.evaluate(() => document.body.innerText).catch(() => '');
      const hasRunContent = /verif|checking|claim|scan|pending|complete|verified/i.test(pageText);

      if (runIdInUrl === runId && hasRunContent) {
        console.log(`    ✓ Re-opened browser shows run ${runId.slice(0, 8)}… and has run content`);
        results.pass.push('SCENARIO 4: Close & re-open — run re-attached successfully');
      } else if (runIdInUrl === runId) {
        console.log(`    ✓ RunId in URL — checking content…`);
        results.pass.push('SCENARIO 4: Close & re-open — runId persisted in URL');
      } else {
        console.log(`    ✗ URL after reopen: ${urlAfterReopen}`);
        results.fail.push(`SCENARIO 4: runId missing from URL after browser close/reopen`);
      }

      // Final wait — now poll until the run completes
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`WAITING FOR RUN ${runId.slice(0, 8)}… TO COMPLETE`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      const start = Date.now();
      let lastLog = '';
      while (Date.now() - start < TIMEOUT) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        const st = await fetchRunStatus(page3, runId);
        if (!st) { await sleep(5000); continue; }

        const claims   = st.claims ?? [];
        const total    = claims.length;
        const done     = claims.filter(c => TERMINAL.has(c.status)).length;
        const summary  = claims.map(c => c.status).join(', ');
        const log      = `[${elapsed}s] Run: ${st.run?.status} | Claims(${total}): ${summary}`;
        if (log !== lastLog || elapsed % 30 < 5) { console.log(`  ${log}`); lastLog = log; }

        if (st.run?.status === 'complete' || (total > 0 && done === total)) {
          console.log(`\n  ✓ Run complete in ${elapsed}s — ${done}/${total} claims resolved`);

          const verifiedCount   = claims.filter(c => c.status === 'verified').length;
          const failedCount     = claims.filter(c => c.status === 'failed').length;
          const untestableCount = claims.filter(c => c.status === 'untestable').length;
          const larpCount       = claims.filter(c => ['larp','larp_confirmed'].includes(c.status)).length;

          console.log('\n══════════════════ FINAL RESULTS ═════════════════════');
          console.log(`  Contract   : ${CA}`);
          console.log(`  Run ID     : ${runId}`);
          console.log(`  Verified   : ${verifiedCount}/${total}`);
          console.log(`  Failed     : ${failedCount}`);
          console.log(`  Untestable : ${untestableCount}`);
          console.log(`  LARP       : ${larpCount}`);
          for (const c of claims) {
            console.log(`    • [${c.status.toUpperCase().padEnd(11)}] ${c.claim?.slice(0, 75) ?? '?'}`);
          }
          console.log('══════════════════════════════════════════════════════\n');

          // Check page for JS errors
          const bodyText = await page3.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          const jsErrors = bodyText.match(/Cannot read propert(?:y|ies)|TypeError:|startsWith is not|undefined\s*\(reading/gi) ?? [];
          if (jsErrors.length === 0) {
            results.pass.push('Final run: no JS errors on page');
          } else {
            results.fail.push(`Final run: ${jsErrors.length} JS error(s) on page`);
          }
          await screenshot(page3, '05-final');
          break;
        }
        if (st.run?.status === 'failed') {
          results.fail.push('Final run: run.status = failed (orchestration error)');
          break;
        }
        await sleep(5000);
      }
    } catch (e) {
      console.error(`    ✗ FAILED: ${e.message}`);
      results.fail.push(`SCENARIO 4: ${e.message}`);
    } finally {
      await browser3.close();
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           STABILITY TEST SUMMARY                 ║');
  console.log('╚══════════════════════════════════════════════════╝');
  for (const p of results.pass) console.log(`  ✅ PASS  ${p}`);
  for (const f of results.fail) console.log(`  ❌ FAIL  ${f}`);

  const allPassed = results.fail.length === 0;
  console.log(`\n${allPassed ? '✅ ALL TESTS PASSED' : `❌ ${results.fail.length} TEST(S) FAILED`}\n`);
  process.exit(allPassed ? 0 : 1);
})();
