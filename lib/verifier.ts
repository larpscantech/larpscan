import path    from 'path';
import fs      from 'fs/promises';
import { randomUUID } from 'crypto';
import { launchChromium } from './browser';
import {
  analyzePageState,
  planWorkflow,
  replanWorkflow,
  executeSteps,
  buildEvidenceSummary,
  handleWalletPopups,
  injectWalletMockIntoContext,
  dismissConsentBanner,
} from './browser-agent';
import type { AgentObservation, AttemptMemory, PageState } from './browser-agent/types';
import { buildSignals } from './verdict-signals';
import type { VerdictSignals } from './verdict-signals';
import {
  buildWorkflowHypothesis,
  shouldTriggerRecovery,
  updateAttemptMemory,
} from './browser-agent/workflow';
import { isWalletConfigured, investigationWalletAddress } from './wallet/client';
import { policyForFeatureType } from './wallet/policy';
import { takeSnapshot, formatDiff } from './wallet/snapshots';
import { runSafetyMonitor, formatSafetyReport } from './wallet/monitor';
import { exposeSigningBridge, drainTransactionHashes, drainTransactionAttempt } from './wallet/signer';
import { waitForTxReceiptOutcome } from './wallet/tx-confirm';
import type { WalletRequestContext } from './wallet/request-classifier';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletEvidence {
  walletEnabled:       boolean;
  walletAddress?:      string;
  walletConnected:     boolean;
  detectedRequests:    WalletRequestContext[];
  rejectedRequests:    WalletRequestContext[];
  snapshotBefore?:     { nativeEther: string };
  snapshotAfter?:      { nativeEther: string };
  unexpectedOutflow:   boolean;
  safetyReport?:       string;
  walletLog:           string[];
}

export interface VerifyClaimResult {
  evidenceSummary:    string;
  siteLoaded:         boolean;
  blocked:            boolean;
  screenshotDataUrl?: string;
  videoUrl?:          string;
  /** Final-state screenshot after all interactions, for visual verdict grounding. */
  finalScreenshotDataUrl?: string;
  /** Structured signals for the two-layer verdict system. Present only for
   *  browser-verified claims that completed Session 2. */
  signals?:           VerdictSignals;
  /** Wallet-related evidence for wallet-gated claims. Present when wallet is configured. */
  walletEvidence?:    WalletEvidence;
}

// ─────────────────────────────────────────────────────────────────────────────
// stripJsRuntimeErrors
//
// Removes JavaScript runtime error lines (TypeError, ReferenceError, stack
// frames, etc.) from page text before it enters any evidence or probe string.
// These errors are extremely common background noise on React/Next.js apps and
// must never drive a verdict on their own — they need to be scrubbed at the
// source so no LLM call ever sees them as content.
// ─────────────────────────────────────────────────────────────────────────────

function stripJsRuntimeErrors(text: string): string {
  return text
    // Full error type lines: "TypeError: Cannot read properties of undefined (reading 'x')"
    .replace(/(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)[^\n]{0,300}\n?/g, '')
    // "Cannot read propert(y|ies) of undefined/null ..."
    .replace(/Cannot read propert(?:y|ies) of (?:undefined|null)[^\n]{0,200}\n?/gi, '')
    // Stack frames: "    at foo (bundle.js:1:2)" or "at Module.foo (webpack://...)"
    .replace(/[ \t]+at\s+\S.*(?:\.js|\.ts|\.tsx|\.mjs|webpack)[^\n]{0,150}\n?/g, '')
    // Remaining multi-blank lines left by stripping
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface AnalysisResult {
  probes:             string[];
  siteLoaded:         boolean;
  blocked:            boolean;
  pageText:           string;
  title:              string;
  screenshotDataUrl?: string;
  surfaceStatus:      number | null;
}

/** Raw structured data returned by recordInteraction for signal extraction */
interface RecordingResult {
  probes:              string[];
  videoUrl?:           string;
  observations:        AgentObservation[];
  finalPageState:      PageState;
  runApiCalls:         string[];
  walletEvidence:      WalletEvidence;
  /** JPEG screenshot captured after all interactions complete.
   *  Used by the verdict LLM for visual grounding. */
  finalScreenshotDataUrl?: string;
  /** True when Plan B observations were all no-ops → wallet_only_gate blocker. */
  walletOnlyGateDetected?: boolean;
  /** Unhandled JS errors captured by page.on('pageerror') during the run.
   *  Distinguishes "feature page crashed" (FAILED) from "feature absent" (LARP). */
  pageJsErrors:        string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeUrl(website: string): string {
  const t = website.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session 1 — Analysis (no recording)
// Lightweight health check: HTTP status, screenshot, Cloudflare detection.
// Uses analyzePageState() for richer blocker/fallback detection.
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeWebsite(baseUrl: string): Promise<AnalysisResult> {
  const probes: string[] = [];
  let siteLoaded        = false;
  let blocked           = false;
  let pageText          = '';
  let title             = '';
  let screenshotDataUrl: string | undefined;
  let surfaceStatus:    number | null = null;

  const browser = await launchChromium({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    console.log(`[verifier:analyze] Navigating to ${baseUrl}`);

    let rootResp = await page
      .goto(baseUrl, { waitUntil: 'networkidle', timeout: 20_000 })
      .catch(() => null);

    if (!rootResp) {
      rootResp = await page
        .goto(baseUrl, { waitUntil: 'load', timeout: 12_000 })
        .catch(() => null);
    }

    if (!rootResp) {
      probes.push(`GET ${baseUrl} → TIMEOUT / DNS_ERROR`);
      return { probes, siteLoaded, blocked, pageText, title, surfaceStatus: null };
    }

    await page.waitForTimeout(2_000);

    const status = rootResp.status();
    surfaceStatus = status;
    siteLoaded    = status < 400;
    probes.push(`GET ${baseUrl} → ${status}`);

    if (status >= 500) {
      return { probes, siteLoaded, blocked, pageText, title, surfaceStatus };
    }

    // Use analyzePageState for richer blocker detection
    const pageState = await analyzePageState(page);
    title    = pageState.title;
    pageText = pageState.visibleText;

    // Cloudflare / bot protection check (using both raw body and pageState blockers)
    const bodyRaw = await page.textContent('body').catch(() => '') ?? '';
    if (
      pageState.blockers.includes('bot_protection') ||
      bodyRaw.includes('Just a moment') ||
      bodyRaw.includes('Checking your browser') ||
      bodyRaw.includes('cf-browser-verification')
    ) {
      blocked = true;
      probes.push('BLOCKED: Cloudflare / bot protection');
      return { probes, siteLoaded, blocked, pageText, title, surfaceStatus };
    }

    if (title)  probes.push(`Page title: "${title}"`);
    const cleanedProbeText = stripJsRuntimeErrors(pageText);
    if (cleanedProbeText.length > 20)  probes.push(`Page content:\n${cleanedProbeText}`);
    else if (pageText.length > 20)     probes.push('Page content: JS error overlay only — feature page may be broken');
    else                               probes.push('Page content: empty (SPA render failure or auth wall)');

    // Log detected blockers
    if (pageState.blockers.length > 0) {
      probes.push(`Blockers detected: ${pageState.blockers.join(', ')}`);
    }

    // UI summary
    probes.push(`UI: ${pageState.buttons.length} button(s), ${pageState.forms.flatMap(f => f.inputs).length} input(s), ${pageState.links.length} link(s)`);

    // Screenshot
    try {
      const buf = await page.screenshot({
        type: 'jpeg', quality: 55,
        clip: { x: 0, y: 0, width: 1280, height: 720 },
      });
      screenshotDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      console.log(`[verifier:analyze] Screenshot: ${Math.round(buf.length / 1024)}KB`);
    } catch { /* non-fatal */ }

    await context.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  return { probes, siteLoaded, blocked, pageText, title, screenshotDataUrl, surfaceStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session 2 — Interaction recording
// Planning happens here in the live recording session so the planner always
// sees the true rendered DOM state, not a stale Session 1 snapshot.
// Returns raw structured data (observations, finalPageState, runApiCalls) in
// addition to probes/videoUrl so verifyClaim can build VerdictSignals.
// ─────────────────────────────────────────────────────────────────────────────

async function recordInteraction(
  baseUrl:       string,
  claimId:       string,
  claim:         string,
  passCondition: string,
  featureType:   string,
  surface:       string,
  strategy:      string,
  recordingsDir: string,
  sessionId:     string,
): Promise<RecordingResult> {
  const probes: string[] = [];
  let videoUrl: string | undefined;
  let finalScreenshotDataUrl: string | undefined;

  // Fallback empty page state returned if Session 2 fails entirely
  const emptyPageState: PageState = {
    url: baseUrl, title: '', visibleText: '', navLinks: [], links: [],
    routeCandidates: [], ctaCandidates: [], buttons: [], forms: [],
    headings: [], sectionLabels: [], tableHeaders: [], chartSignals: [],
    disabledControls: [], blockers: [], hasModal: false, apiSignals: [],
  };

  const browser = await launchChromium({ headless: true });

  let context: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  let allObservations: AgentObservation[] = [];
  let finalPageState: PageState = emptyPageState;
  const runApiCalls: string[] = [];
  let walletOnlyGateDetected = false;
  // Hoisted so the return statement at the end of the function can reference it.
  // Populated by the page.on('pageerror') listener once a page is opened.
  const pageJsErrors: string[] = [];

  // ── Wallet setup ────────────────────────────────────────────────────────
  const walletEnabled  = isWalletConfigured();
  const walletAddress  = investigationWalletAddress;
  const walletPolicy   = policyForFeatureType(featureType);
  const allWalletLogs: string[] = [];
  const allDetectedRequests: WalletRequestContext[] = [];
  const allRejectedRequests: WalletRequestContext[] = [];
  let walletConnectedAny = false;
  let spentEtherThisRun  = 0;

  const walletEvidence: WalletEvidence = {
    walletEnabled,
    walletAddress:     walletAddress ?? undefined,
    walletConnected:   false,
    detectedRequests:  [],
    rejectedRequests:  [],
    unexpectedOutflow: false,
    walletLog:         [],
  };

  if (walletEnabled) {
    console.log(`[verifier:record] Wallet-aware session — address: ${walletAddress}`);
  }

  try {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:    { width: 1280, height: 720 },
      recordVideo: { dir: recordingsDir, size: { width: 1280, height: 720 } },
    });

    // Install signing bridge FIRST so it's available when addInitScript runs.
    // Pass sessionId so this run's tx hashes are isolated from concurrent runs.
    if (walletEnabled && walletAddress) {
      await exposeSigningBridge(context, sessionId);
      await injectWalletMockIntoContext(context, walletAddress);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    // ── Run-level network listener ──────────────────────────────────────────
    page.on('response', (response) => {
      const url    = response.url();
      const status = response.status();
      if (
        url.includes('/api/') || url.includes('.json') ||
        url.includes('graphql') || url.includes('/rpc') ||
        url.includes('/v1/')   || url.includes('/v2/')
      ) {
        runApiCalls.push(`${status} ${url}`);
      }
    });

    // ── Unhandled JS error listener ─────────────────────────────────────────
    // Playwright fires 'pageerror' for any unhandled exception thrown in the
    // page context. We capture these to detect when a feature page crashes
    // (e.g. a React component throws TypeError during render/hydration) so
    // the verdict system can distinguish "page crashed = FAILED" from
    // "feature absent = LARP".
    page.on('pageerror', (error) => {
      // Only record errors that look like actual crashes (not background analytics noise)
      const msg = error.message ?? '';
      if (
        /Cannot read propert|is not a function|is not defined|Cannot set propert|undefined is not|null is not/i.test(msg)
      ) {
        pageJsErrors.push(msg.slice(0, 200));
        console.warn(`[verifier:pageerror] JS crash captured: ${msg.slice(0, 100)}`);
      }
    });

    // baseDomain must always be the root origin so that navigate("/path") steps
    // never produce double-paths like /create/create.
    const baseDomain = new URL(baseUrl).origin;

    // ── Navigate ────────────────────────────────────────────────────────────
    console.log(`[verifier:record] Navigating to ${baseUrl} (baseDomain: ${baseDomain})`);
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 15_000 }).catch(() => null);
    // When a wallet mock is active the page uses wagmi localStorage pre-connect;
    // wagmi v2 with ssr:true needs ~4-5 s to hydrate before the connected state
    // appears in the DOM. Use a longer wait so analyzePageState sees the correct
    // connected state and doesn't emit a false wallet_required blocker.
    await page.waitForTimeout(walletEnabled ? 5_000 : 2_500);

    // ── Dismiss cookie / GDPR consent banners ────────────────────────────────
    // Many sites show a consent overlay that blocks all interaction until
    // accepted. Dismiss it before wallet connect or any agent steps.
    await dismissConsentBanner(page);

    // ── Early wallet connect — before planning ────────────────────────────
    // Connect the investigation wallet as soon as the page loads so the
    // planner sees the post-connection DOM state (unlocked forms, hidden CTAs).
    if (walletEnabled && walletAddress) {
      const earlyWallet = await handleWalletPopups(
        page, walletAddress, walletPolicy, featureType, 'recon', spentEtherThisRun,
      );
      allWalletLogs.push(...earlyWallet.log);
      allDetectedRequests.push(...earlyWallet.detectedRequests);
      allRejectedRequests.push(...earlyWallet.rejectedRequests);
      if (earlyWallet.walletConnected) {
        walletConnectedAny = true;
        probes.push(`Investigation wallet connected early (address: ${walletAddress})`);
        // Give the site time to re-render after wallet connection
        await page.waitForTimeout(2_500);
      }
    }

    // ── Phase 1: Live page analysis + Plan A ────────────────────────────────
    console.log('[verifier:record] Analyzing page state...');
    // Pass the wallet address when connected so analyzePageState can suppress
    // the wallet_required blocker when the address is already visible in the DOM.
    const pageState = await analyzePageState(
      page,
      walletConnectedAny ? walletAddress ?? undefined : undefined,
    );
    pageState.apiSignals = [...runApiCalls];

    console.log(
      `[verifier:record] Page state — blockers: [${pageState.blockers.join(', ')}], ` +
      `routes: [${pageState.routeCandidates.join(', ')}], buttons: ${pageState.buttons.length}`,
    );

    // ── Phase 1.5: Workflow hypothesis (recon → hypothesis) ─────────────────
    const hypothesis = buildWorkflowHypothesis(claim, featureType, pageState);
    console.log(
      `[verifier:record] Hypothesis — likelySurface: ${hypothesis.likelySurface ?? 'n/a'}, ` +
      `firstAction: ${hypothesis.firstMeaningfulAction ? JSON.stringify(hypothesis.firstMeaningfulAction) : 'n/a'}`,
    );

    // Capture a planning screenshot — passed to the planner so it can visually
    // understand the page layout before generating steps, just like a human
    // tester would look at the page before writing their test plan.
    let planningScreenshotDataUrl: string | undefined;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
      planningScreenshotDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch { /* non-fatal */ }

    let attemptMemory: AttemptMemory = {
      attemptedRoutes: [],
      attemptedCtas: [],
      attemptedActions: [],
      noopActions: [],
    };

    const planA = await planWorkflow(
      claim, passCondition, featureType, surface, strategy, pageState,
      walletAddress ?? undefined,
      planningScreenshotDataUrl,
    );
    console.log(`[verifier:record] Plan A: ${planA.length} step(s)`);

    // ── Pre-execution wallet snapshot ────────────────────────────────────────
    let snapshotBefore = walletEnabled ? await takeSnapshot() : null;
    if (snapshotBefore) {
      allWalletLogs.push(`[wallet] Pre-run balance: ${snapshotBefore.nativeEther} BNB`);
    }

    // ── Phase 2: Execute Plan A ─────────────────────────────────────────────
    if (planA.length > 0) {
      const planAResult = await executeSteps(page, planA, baseDomain, runApiCalls, {
        stage:                      'execution',
        hypothesis,
        investigationWalletAddress: walletAddress ?? undefined,
        claim,
        passCondition,
        featureType,
      });
      allObservations = planAResult.observations;
      attemptMemory = updateAttemptMemory(attemptMemory, planAResult.observations);
    } else {
      probes.push(`Planning returned empty plan — blockers: [${pageState.blockers.join(', ')}]`);
    }

    // ── Wallet popup check after Plan A (only if not already connected) ──────
    if (walletEnabled && walletAddress && !walletConnectedAny) {
      const walletResult = await handleWalletPopups(
        page, walletAddress, walletPolicy, featureType, 'execution', spentEtherThisRun,
      );
      allWalletLogs.push(...walletResult.log);
      allDetectedRequests.push(...walletResult.detectedRequests);
      allRejectedRequests.push(...walletResult.rejectedRequests);
      if (walletResult.walletConnected) {
        walletConnectedAny = true;
        probes.push(`Wallet connected (address: ${walletAddress})`);
        await page.waitForTimeout(2_000);
      }
    }

    // ── Phase 3: Adaptive replanning ───────────────────────────────────────
    const shouldReplan     = planA.length > 0 && shouldTriggerRecovery(allObservations, 15);
    const totalSteps       = allObservations.length;

    if (shouldReplan) {
      console.log('[verifier:record] Replanning threshold reached — generating Plan B...');

      const updatedPageState = await analyzePageState(
        page,
        walletConnectedAny ? walletAddress ?? undefined : undefined,
      );
      updatedPageState.apiSignals = [...runApiCalls];

      const planB = await replanWorkflow(
        claim, passCondition, featureType, surface, strategy,
        updatedPageState, allObservations, attemptMemory,
        walletAddress ?? undefined,
      );

      if (planB.length > 0) {
        const remainingBudget = Math.max(0, 15 - totalSteps);
        const planBCapped     = planB.slice(0, remainingBudget);

        console.log(`[verifier:record] Plan B: ${planBCapped.length} step(s) (budget remaining: ${remainingBudget})`);
        const planBResult = await executeSteps(page, planBCapped, baseDomain, runApiCalls, {
          stage:                      'recovery',
          hypothesis,
          investigationWalletAddress: walletAddress ?? undefined,
          claim,
          passCondition,
          featureType,
        });
        allObservations   = [...allObservations, ...planBResult.observations];
        attemptMemory = updateAttemptMemory(attemptMemory, planBResult.observations);

        // Wallet popup check after Plan B (only if not already connected)
        if (walletEnabled && walletAddress && !walletConnectedAny) {
          const walletResultB = await handleWalletPopups(
            page, walletAddress, walletPolicy, featureType, 'recovery', spentEtherThisRun,
          );
          allWalletLogs.push(...walletResultB.log);
          allDetectedRequests.push(...walletResultB.detectedRequests);
          allRejectedRequests.push(...walletResultB.rejectedRequests);
          if (walletResultB.walletConnected) {
            walletConnectedAny = true;
          }
        }

        // If plan B also produced only no-ops, record wallet_only_gate signal
        const planBNoops = planBResult.observations.filter((o) => o.isNoop).length;
        if (planBNoops === planBResult.observations.length && planBResult.observations.length > 0) {
          walletOnlyGateDetected = true;
          probes.push('No meaningful interaction possible — feature may require wallet or is not accessible without authentication (wallet_only_gate)');
        }
      } else {
        probes.push('Replanning returned empty plan — no alternative approach found');
      }
    }

    // ── Phase 4: Final page state + evidence summary ────────────────────────
    finalPageState = await analyzePageState(
      page,
      walletConnectedAny ? walletAddress ?? undefined : undefined,
    );
    finalPageState.apiSignals = [...runApiCalls];

    // Capture a final screenshot AFTER all interactions. This is passed to the
    // verdict LLM for visual grounding — it can see the actual post-interaction
    // UI state (wallet connected, form filled, result loaded) rather than
    // inferring it from truncated text evidence.
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
      finalScreenshotDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      console.log('[verifier:record] Final screenshot captured for verdict visual grounding');
    } catch {
      console.warn('[verifier:record] Final screenshot failed (non-fatal)');
    }

    const evidenceBlock = buildEvidenceSummary(allObservations, finalPageState, runApiCalls, baseUrl);
    probes.push(evidenceBlock);

    console.log(`[verifier:record] Final URL: ${finalPageState.url}`);
    console.log(`[verifier:record] Total steps: ${allObservations.length}, API calls: ${runApiCalls.length}`);

    // ── Post-execution wallet snapshot + safety check ───────────────────────
    if (walletEnabled) {
      const snapshotAfter = await takeSnapshot();

      if (snapshotBefore && snapshotAfter) {
        const safetyResult = await runSafetyMonitor({
          snapshotBefore,
          snapshotAfter,
          txHashes:            [],   // future: collect from wallet client
          expectedMaxOutflowWei: BigInt(0),
        });

        const safetyText = formatSafetyReport(safetyResult);
        probes.push(safetyText);
        allWalletLogs.push(`[wallet] Post-run balance: ${snapshotAfter.nativeEther} BNB`);
        allWalletLogs.push(formatDiff(safetyResult.snapshotDiff!));

        walletEvidence.snapshotBefore     = { nativeEther: snapshotBefore.nativeEther };
        walletEvidence.snapshotAfter      = { nativeEther: snapshotAfter.nativeEther };
        walletEvidence.unexpectedOutflow  = safetyResult.unexpectedOutflow;
        walletEvidence.safetyReport       = safetyText;

        if (safetyResult.haltRun) {
          probes.push('⚠ WALLET SAFETY: unexpected outflow detected — further wallet actions halted');
          console.warn('[verifier:record] Wallet safety halt triggered');
        }
      }

      walletEvidence.walletConnected  = walletConnectedAny;
      walletEvidence.detectedRequests = allDetectedRequests;
      walletEvidence.rejectedRequests = allRejectedRequests;
      walletEvidence.walletLog        = allWalletLogs;

      if (allWalletLogs.length > 0) {
        probes.push(`\n--- Wallet Evidence ---\n${allWalletLogs.join('\n')}`);
      }
      if (allDetectedRequests.length > 0) {
        probes.push(
          `Wallet requests intercepted: ${allDetectedRequests.map((r) => r.description).join(' | ')}`,
        );
      }
      if (allRejectedRequests.length > 0) {
        probes.push(
          `Wallet requests rejected by policy: ${allRejectedRequests.map((r) => r.description).join(' | ')}`,
        );
      }
    }

    // ── Close page → finalizes video ────────────────────────────────────────
    await page.close();

    try {
      const rawPath = await page.video()?.path();
      if (rawPath) {
        const finalPath = path.join(recordingsDir, `${claimId}.webm`);
        await fs.rename(rawPath, finalPath).catch(async () => {
          await fs.copyFile(rawPath, finalPath);
          await fs.unlink(rawPath).catch(() => {});
        });
        videoUrl = `/recordings/${claimId}.webm`;
        console.log(`[verifier:record] Video saved → ${videoUrl}`);
      }
    } catch (e) {
      console.warn('[verifier:record] Video save failed (non-fatal):', e);
    }
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { probes, videoUrl, observations: allObservations, finalPageState, runApiCalls, walletEvidence, finalScreenshotDataUrl, walletOnlyGateDetected, pageJsErrors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyClaim(
  website:       string,
  claim:         string,
  passCondition: string,
  claimId:       string,
  surface?:      string,
  featureType?:  string,
  strategy?:     string,
): Promise<VerifyClaimResult> {
  // Session ID isolates this claim's tx hashes from concurrent verifications.
  // Generated here so it spans both recordInteraction() and drainTransactionHashes().
  const sessionId = randomUUID();

  const baseUrl  = normalizeUrl(website);
  const startUrl = surface && surface !== '/'
    ? `${baseUrl.replace(/\/$/, '')}${surface}`
    : baseUrl;

  const effectiveSurface  = surface  ?? '/';
  const effectiveFeature  = featureType ?? 'UI_FEATURE';
  const effectiveStrategy = strategy    ?? 'ui+browser';

  console.log(`\n[verifier] ══ Claim: "${claim.slice(0, 60)}" ══`);
  console.log(`[verifier] Feature: ${effectiveFeature} | Strategy: ${effectiveStrategy} | Surface: ${effectiveSurface}`);
  if (startUrl !== baseUrl) {
    console.log(`[verifier] Surface override: ${startUrl}`);
  }

  // ── Session 1: Analyse ────────────────────────────────────────────────────
  let analysis = await analyzeWebsite(startUrl);
  let effectiveStartUrl = startUrl;
  let routeFallbackUsed = false;

  // ── Conditional surface fallback ──────────────────────────────────────────
  // Retry from baseUrl only when the surface is genuinely unreachable.
  // Do NOT fall back for login/wallet-gated pages — those are valid UNTESTABLE outcomes.
  if (surface && surface !== '/' && startUrl !== baseUrl) {
    const isLoginWall = analysis.pageText.match(
      /sign in|log in|connect wallet|wallet required/i,
    );
    const isUnreachable =
      !analysis.blocked &&
      !isLoginWall &&
      (analysis.surfaceStatus === null ||
        analysis.surfaceStatus === 404 ||
        analysis.surfaceStatus === 410 ||
        analysis.surfaceStatus >= 500 ||
        analysis.pageText.trim().length < 20);

    if (isUnreachable) {
      console.warn(
        `[verifier] Surface "${surface}" unreachable (status=${analysis.surfaceStatus}) — retrying from homepage`,
      );
      const fallbackProbe = `Surface "${surface}" unreachable (HTTP ${analysis.surfaceStatus ?? 'TIMEOUT'}) — retried from homepage`;
      const retryAnalysis = await analyzeWebsite(baseUrl);
      retryAnalysis.probes.unshift(fallbackProbe);
      analysis          = retryAnalysis;
      effectiveStartUrl = baseUrl;
      routeFallbackUsed = true;
    }
  }

  if (!analysis.siteLoaded || analysis.blocked) {
    return {
      evidenceSummary:   analysis.probes.join('\n'),
      siteLoaded:        analysis.siteLoaded,
      blocked:           analysis.blocked,
      screenshotDataUrl: analysis.screenshotDataUrl,
      // No signals — short-circuited before Session 2
    };
  }

  // ── Session 2: Record + plan + execute ────────────────────────────────────
  const recordingsDir = path.join(process.cwd(), 'public', 'recordings');
  await fs.mkdir(recordingsDir, { recursive: true });

  const recording = await recordInteraction(
    effectiveStartUrl,
    claimId,
    claim,
    passCondition,
    effectiveFeature,
    effectiveSurface,
    effectiveStrategy,
    recordingsDir,
    sessionId,
  );

  // Collect any on-chain transaction hashes submitted during verification
  const submittedTxHashes  = drainTransactionHashes(sessionId);
  const transactionAttempted = drainTransactionAttempt(sessionId);
  let txReceiptStatus: 'success' | 'reverted' | 'timeout' | undefined;
  if (submittedTxHashes.length > 0) {
    const primaryHash = submittedTxHashes[submittedTxHashes.length - 1] as `0x${string}`;
    console.log(`[verifier] On-chain tx hash (broadcast): ${primaryHash}`);
    txReceiptStatus = await waitForTxReceiptOutcome(primaryHash);
    console.log(`[verifier] On-chain receipt outcome: ${txReceiptStatus}`);
  }
  if (transactionAttempted && submittedTxHashes.length === 0) {
    console.log('[verifier] Transaction was attempted but not broadcast (likely insufficient BNB for gas)');
  }

  // ── Build structured signals from raw recording data ──────────────────────
  const signals = buildSignals(
    recording.observations,
    recording.finalPageState,
    recording.runApiCalls,
    effectiveStartUrl,
    analysis.siteLoaded,
    analysis.blocked,
    routeFallbackUsed,
    recording.walletEvidence,
    submittedTxHashes,
    txReceiptStatus,
    transactionAttempted,
    effectiveSurface,
    recording.walletOnlyGateDetected,
    recording.pageJsErrors,
  );

  console.log(
    `[verifier] Signals — ownApi: ${signals.ownDomainApiCalls.length}, ` +
    `form: ${signals.formAppeared}, cta: ${signals.enabledCtaPresent}, ` +
    `blockers: [${signals.blockersEncountered.join(', ')}], ` +
    `noops: ${signals.noopCount}/${signals.totalSteps}`,
  );

  const receiptNote =
    submittedTxHashes.length > 0 && txReceiptStatus
      ? [
          '--- On-chain confirmation ---',
          `Hash: ${submittedTxHashes[submittedTxHashes.length - 1]}`,
          `Receipt: ${txReceiptStatus}`,
          txReceiptStatus === 'reverted'
            ? 'Execution reverted on-chain (matches dApp "Transaction failed" when present).'
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  return {
    evidenceSummary:
      [...analysis.probes, ...recording.probes].join('\n') +
      (receiptNote ? `\n${receiptNote}` : ''),
    siteLoaded:        analysis.siteLoaded,
    blocked:           analysis.blocked,
    screenshotDataUrl:      analysis.screenshotDataUrl,
    videoUrl:               recording.videoUrl,
    finalScreenshotDataUrl: recording.finalScreenshotDataUrl,
    signals,
    walletEvidence:         recording.walletEvidence,
  };
}
